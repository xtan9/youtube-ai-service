# Caption language matching: primary-subtag retry

**Date:** 2026-04-26
**Status:** Approved (brainstorming complete; awaiting implementation plan)
**Owner:** xingdi

## Problem

Production summaries of non-English YouTube videos can come back in English. The user-reported case: `https://www.youtube.com/watch?v=xMZqTuLWSA4` is a Chinese video, but both the rendered transcript and the LLM summary are English.

Root cause traces to strict-equality matching inside `youtube-transcript-plus`. The orchestrator passes a primary-subtag-only `lang` (e.g. `"zh"`) to the VPS `POST /captions` endpoint. YouTube tags the actual track as `"zh-Hans"` (or `"zh-CN"`/`"zh-Hant-TW"` for other variants), so the library's `tracks.find((t) => t.languageCode === lang)` returns `undefined` and throws `YoutubeTranscriptNotAvailableLanguageError`. The captions adapter treats that as "no captions" and the orchestrator's existing fallback retries with `lang="en"`. This Chinese video has uploader-provided English manual subtitles, so the English track resolves and becomes the persisted transcript. The LLM, asked for a "video-native" summary, summarizes the English transcript in English.

The same bug class is already documented in code comments (`captions.ts:158-167` mentions `tracks[0]` as a prior incident — "Arabic for French videos"). This is a second flavor of the same underlying problem: BCP-47 normalization on the caller side combined with strict equality on the library side.

## Goal

Make `POST /captions { lang: "zh" }` resolve a `zh-*` track when one exists, without changing the contract any consumer relies on, and without leaking BCP-47 awareness into upstream callers.

Non-goals:
- Revisiting the English-fallback policy. The orchestrator's `availableCaptions.includes("en")` retry stays as-is. (Tracked separately for a future design.)
- Backfilling cache pollution beyond the user-reported video. (Other affected URLs will self-heal on next request after deploy if their cache row is invalidated by some other path; otherwise they remain English-cached until reported.)
- Changing language detection in `language-detect.ts`.

## Approach

Single-file change in the VPS captions adapter (`youtube-ai-service/src/lib/captions.ts`).

`fetchCaptions` wraps `fetchTranscript`. When the wrapped call throws `YoutubeTranscriptNotAvailableLanguageError`, the wrapper inspects `err.availableLangs` and decides whether to retry once with a more specific code that matches the requested primary subtag.

Retry preconditions (all must hold):
- `lang` is provided (truthy).
- `lang` contains no `-` (i.e. caller asked for a primary subtag, not a regional/script-specific code).
- One of `err.availableLangs` has `code.toLowerCase().split("-")[0] === lang.toLowerCase()`.

When all preconditions hold, call `fetchTranscript` again with the matched code (the first match in `availableLangs` order — preserves YouTube's track ordering). Otherwise return `null`, preserving today's "no captions" semantics so the orchestrator's existing English/Whisper cascade runs unchanged.

The retry call's failure modes:
- Throws an *expected* no-captions error (rare — would imply the listed track disappeared between calls): return `null`.
- Throws an *unexpected* error: propagate so it surfaces as 500 + `CAPTION_UNEXPECTED_FAILURE` (existing alert path).
- No second-level retry. The retried code is the canonical YouTube-emitted track code; if that fails, retrying again won't help.

Logging:
- One `console.warn` immediately before the retry call: `errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG"`, `videoId`, `requested` (the bare subtag), `matched` (the resolved code). Lets us see retry rate in the log aggregator and detect upstream regressions (e.g., yt-dlp emitting `"zh"` for tracks now actually labeled `"zh"`).

Consumers untouched:
- `routes/captions.ts` — no change. The `lang` query parameter still flows through verbatim.
- Frontend orchestrator (`app/api/summarize/stream/route.ts`) — no change.
- VPS metadata/Whisper paths — no change.
- The existing English-fallback at `route.ts:477-495` continues to fire when the retry also misses (e.g. video has only `en` and `fr` tracks but detected language is `de`).

## Tests

`youtube-ai-service/src/lib/__tests__/captions.test.ts` (existing file).

Stub `fetchTranscript` (already mocked in this suite) and add cases:

1. **Subtag-mismatch retry succeeds.** `lang="zh"`; first call throws `new YoutubeTranscriptNotAvailableLanguageError("zh", ["zh-Hans", "en"], videoId)`; second call (with `"zh-Hans"`) returns segments. Assert: result has `language: "zh"`, segments returned, `fetchTranscript` called twice with `lang="zh"` then `lang="zh-Hans"`.

2. **No matching primary subtag.** `lang="zh"`; first throw with `availableLangs=["en", "fr"]`. Assert: returns `null`, `fetchTranscript` called once.

3. **Region-tagged input skips retry.** `lang="en-US"`; first throw with `availableLangs=["en"]`. Assert: returns `null`, `fetchTranscript` called once (the no-`-` guard prevents downgrading specific requests).

4. **Script+region match.** `lang="zh"`; first throw `availableLangs=["zh-Hant-TW"]`; second call returns segments. Assert: retry uses `"zh-Hant-TW"` (covers script-tagged variants beyond simple region tags).

5. **Case insensitivity.** `lang="ZH"`; first throw `availableLangs=["zh-Hans"]`. Assert: retry uses `"zh-Hans"` (the lookup is case-insensitive on both sides).

6. **Retry also throws expected.** `lang="zh"`; first throw `availableLangs=["zh-Hans"]`; second call throws another `YoutubeTranscriptNotAvailableLanguageError`. Assert: returns `null`, no third call.

7. **Retry throws unexpected.** `lang="zh"`; first throw `availableLangs=["zh-Hans"]`; second call throws a `TypeError`. Assert: rethrown (caller sees 500 + alert), not silently swallowed.

8. **Existing tests pass unmodified.** All current cases in `captions.test.ts` continue to behave identically — the new path is only entered on a specific error class with a specific shape.

## Cache invalidation

After the VPS deploy completes (otherwise the next request to xMZqTuLWSA4 re-poisons the cache), execute one SQL statement against the production Supabase database via the Supabase MCP server:

```sql
DELETE FROM videos
WHERE youtube_url = 'https://www.youtube.com/watch?v=xMZqTuLWSA4';
```

Cascades to `summaries` (FK with `ON DELETE CASCADE`) and `video_transcripts` (FK with `ON DELETE CASCADE`). On the next user request to this URL the full pipeline re-runs and persists the corrected Chinese transcript + summary.

Scope is intentionally narrow: only this one URL. Other affected videos may exist but identifying them requires per-video yt-dlp calls; we accept the latent miss and revisit if user reports trickle in.

## Verification

After VPS deploy + cache delete:

1. **Unit tests.** `cd youtube-ai-service && npm test` — all green including the seven new cases above.
2. **Lint.** No new lint errors introduced by the change.
3. **Production smoke (Playwright).** Sign in with `~/.config/claude-test-creds/youtubeai.env` against `https://www.youtubeai.chat`; navigate to `/summary?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DxMZqTuLWSA4`; wait for streaming to finish; assert the rendered `.prose` summary content contains CJK characters (Unicode range matches `\p{Script=Han}` or simpler `[一-鿿]`). Also assert the visible "Detected language" status line shows `zh` (or a `zh-*` variant), not `en`.
4. **Log spot-check.** Confirm one `CAPTION_LANG_RETRY_PRIMARY_SUBTAG` warn line for that videoId on the first post-deploy request to it.

## Risk and rollback

- **Blast radius:** one file in the VPS service. Behavior change is strictly additive: requests that previously returned `null` now sometimes return a successful result; requests that previously returned segments are unchanged.
- **Rollback:** revert the captions.ts commit and redeploy. Cache rows written between deploy and rollback would carry the new (correct) Chinese transcript — those would survive the rollback as accurate cache entries, no cleanup needed.

## Out of scope (future work)

- Revisit "fall back to English captions on miss" for non-English videos — auto-translated English may be uniformly worse than Whisper-on-original. Needs prod data on retry-fire rate before we change the policy.
- Backfill scan of cached transcripts where `language="en"` but the underlying video is non-English. Bounded by yt-dlp re-checks per cached row; defer until we see whether the long tail surfaces in user reports.

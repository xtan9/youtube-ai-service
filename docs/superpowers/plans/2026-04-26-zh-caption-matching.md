# zh Caption Primary-Subtag Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /captions { lang: "zh" }` resolve a `zh-Hans` (or any region/script-tagged variant of the requested primary subtag) so non-English videos with uploader-provided English subs stop being summarized in English.

**Architecture:** Single-file change in the VPS captions adapter — when `youtube-transcript-plus` throws `YoutubeTranscriptNotAvailableLanguageError` for a bare-primary-subtag request and the error's `availableLangs` contains a matching variant, retry once with the exact code. After deploy, manually invalidate the Supabase cache row for the user-reported video and verify on production.

**Tech Stack:** TypeScript (Node.js + Hono), Vitest, `youtube-transcript-plus` v2.0.0, Supabase (cache), Playwright (e2e verification).

**Spec:** `docs/superpowers/specs/2026-04-26-zh-caption-matching-design.md` (commit `02fb76a` on `main`).

---

## File Structure

- **Modify:** `src/lib/captions.ts` — add `findSubtagMatch` helper + retry branch in `fetchCaptions`'s catch.
- **Modify:** `src/lib/__tests__/captions.test.ts` — append new `describe` block with seven cases under the existing `describe("fetchCaptions")` group.

No new files. No schema or contract changes — `routes/captions.ts`, the orchestrator, and the metadata service stay untouched.

---

## Task 1: Add primary-subtag retry to fetchCaptions (TDD)

**Files:**
- Modify: `src/lib/captions.ts` (add helper + extend catch in `fetchCaptions`)
- Test: `src/lib/__tests__/captions.test.ts` (append new test block)

- [ ] **Step 1: Add the seven failing tests**

Append this block at the end of `src/lib/__tests__/captions.test.ts` (still inside the file, not nested in another describe). Note: `YoutubeTranscriptNotAvailableLanguageError` must be added to the existing import from `youtube-transcript-plus` at the top of the file.

```typescript
describe("fetchCaptions: primary-subtag retry", () => {
  beforeEach(() => {
    mockedFetchTranscript.mockReset();
  });

  it("retries lang='zh' with the matching zh-Hans track and returns its segments", async () => {
    const url = "https://youtu.be/dQw4w9WgXcQ";
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["zh-Hans", "en"],
          "dQw4w9WgXcQ"
        )
      )
      .mockResolvedValueOnce(ok([{ text: "你好", lang: "zh-Hans" }]));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchCaptions(url, "zh");

    expect(result).not.toBeNull();
    expect(result!.language).toBe("zh");
    expect(result!.segments[0].text).toBe("你好");
    expect(mockedFetchTranscript).toHaveBeenCalledTimes(2);
    expect(mockedFetchTranscript.mock.calls[0][1]).toEqual({
      videoDetails: true,
      lang: "zh",
    });
    expect(mockedFetchTranscript.mock.calls[1][1]).toEqual({
      videoDetails: true,
      lang: "zh-Hans",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions] CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
      expect.objectContaining({
        errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
        videoId: "dQw4w9WgXcQ",
        requested: "zh",
        matched: "zh-Hans",
      })
    );
  });

  it("returns null without retry when no available lang shares the primary subtag", async () => {
    mockedFetchTranscript.mockRejectedValueOnce(
      new YoutubeTranscriptNotAvailableLanguageError(
        "zh",
        ["en", "fr"],
        "dQw4w9WgXcQ"
      )
    );

    const result = await fetchCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      "zh"
    );

    expect(result).toBeNull();
    expect(mockedFetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the requested lang is region-tagged (en-US)", async () => {
    // Region-tagged callers asked for something specific. Don't second-guess
    // by downgrading to a different en variant.
    mockedFetchTranscript.mockRejectedValueOnce(
      new YoutubeTranscriptNotAvailableLanguageError(
        "en-US",
        ["en"],
        "dQw4w9WgXcQ"
      )
    );

    const result = await fetchCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      "en-US"
    );

    expect(result).toBeNull();
    expect(mockedFetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("matches script+region variants like zh-Hant-TW", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["zh-Hant-TW"],
          "dQw4w9WgXcQ"
        )
      )
      .mockResolvedValueOnce(ok([{ text: "你好", lang: "zh-Hant-TW" }]));

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      "zh"
    );

    expect(result).not.toBeNull();
    expect(mockedFetchTranscript.mock.calls[1][1]).toEqual({
      videoDetails: true,
      lang: "zh-Hant-TW",
    });
  });

  it("matches case-insensitively (lang='ZH' resolves zh-Hans)", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "ZH",
          ["zh-Hans"],
          "dQw4w9WgXcQ"
        )
      )
      .mockResolvedValueOnce(ok([{ text: "你好", lang: "zh-Hans" }]));

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      "ZH"
    );

    expect(result).not.toBeNull();
    expect(mockedFetchTranscript.mock.calls[1][1]).toEqual({
      videoDetails: true,
      lang: "zh-Hans",
    });
  });

  it("returns null when the retry also throws an expected no-captions error", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["zh-Hans"],
          "dQw4w9WgXcQ"
        )
      )
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableError("dQw4w9WgXcQ")
      );

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      "zh"
    );

    expect(result).toBeNull();
    expect(mockedFetchTranscript).toHaveBeenCalledTimes(2);
  });

  it("rethrows when the retry throws an unexpected error (alertable, not silently null)", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["zh-Hans"],
          "dQw4w9WgXcQ"
        )
      )
      .mockRejectedValueOnce(new TypeError("boom"));

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      fetchCaptions("https://youtu.be/dQw4w9WgXcQ", "zh")
    ).rejects.toBeInstanceOf(TypeError);

    expect(mockedFetchTranscript).toHaveBeenCalledTimes(2);
  });
});
```

Also update the import at the top of the same file (the only top-of-file change). Find the existing import block:

```typescript
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  type TranscriptSegment,
} from "youtube-transcript-plus";
```

Replace with (adding `YoutubeTranscriptNotAvailableLanguageError`):

```typescript
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  type TranscriptSegment,
} from "youtube-transcript-plus";
```

- [ ] **Step 2: Run the new tests, confirm all seven fail**

Run: `npm test -- src/lib/__tests__/captions.test.ts -t "primary-subtag retry"`

Expected: 7 failed (the existing `fetchCaptions` catch returns `null` on `YoutubeTranscriptNotAvailableLanguageError` via `isExpectedNoCaptions`, so all retry/throw expectations fail and `mockedFetchTranscript` is only called once everywhere).

- [ ] **Step 3: Implement the helper + retry branch in `src/lib/captions.ts`**

Add this helper anywhere in `src/lib/captions.ts` *above* the `fetchCaptions` function (next to `isExpectedNoCaptions` is a natural spot):

```typescript
// youtube-transcript-plus matches a requested `lang` against the track's
// `languageCode` with strict equality. YouTube tags Chinese tracks as
// `zh-Hans`/`zh-Hant-TW`/etc. so a primary-subtag-only request like `"zh"`
// silently misses and falls through to "no captions". When the library
// throws NotAvailableLanguageError it surfaces the actual track codes via
// `availableLangs`; this helper picks the first one whose primary subtag
// matches the request, case-insensitive. Returns null for region-tagged
// inputs (the caller asked for `"en-US"` specifically — don't downgrade
// to `"en"` behind their back).
function findSubtagMatch(
  lang: string,
  available: readonly string[]
): string | null {
  if (lang.includes("-")) return null;
  const want = lang.toLowerCase();
  return (
    available.find((code) => code.toLowerCase().split("-")[0] === want) ?? null
  );
}
```

Then replace the existing `try { ... } catch (err) { ... }` block in `fetchCaptions` (the one that wraps the first `fetchTranscript` call and currently sits roughly at lines 176-192 of the unmodified file). Old:

```typescript
  let result: TranscriptResult;
  try {
    const response = await fetchTranscript(videoId, {
      videoDetails: true,
      ...(lang ? { lang } : {}),
    });
    result = response as TranscriptResult;
  } catch (err) {
    if (isExpectedNoCaptions(err)) return null;
    console.error("[captions] CAPTION_UNEXPECTED_FAILURE", {
      errorId: "CAPTION_UNEXPECTED_FAILURE",
      videoId,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      err,
    });
    throw err;
  }
```

New:

```typescript
  let result: TranscriptResult;
  try {
    const response = await fetchTranscript(videoId, {
      videoDetails: true,
      ...(lang ? { lang } : {}),
    });
    result = response as TranscriptResult;
  } catch (err) {
    // Strict-equality match inside the library means primary-subtag
    // requests (e.g. `"zh"`) miss region/script-tagged tracks
    // (`"zh-Hans"`). Catch that one shape and retry with the matched
    // code before falling through to the generic no-captions path.
    if (lang && err instanceof YoutubeTranscriptNotAvailableLanguageError) {
      const matched = findSubtagMatch(lang, err.availableLangs);
      if (!matched) return null;
      console.warn("[captions] CAPTION_LANG_RETRY_PRIMARY_SUBTAG", {
        errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
        videoId,
        requested: lang,
        matched,
      });
      try {
        const retryResponse = await fetchTranscript(videoId, {
          videoDetails: true,
          lang: matched,
        });
        result = retryResponse as TranscriptResult;
      } catch (retryErr) {
        if (isExpectedNoCaptions(retryErr)) return null;
        console.error("[captions] CAPTION_UNEXPECTED_FAILURE", {
          errorId: "CAPTION_UNEXPECTED_FAILURE",
          videoId,
          errorClass:
            retryErr instanceof Error
              ? retryErr.constructor.name
              : typeof retryErr,
          err: retryErr,
        });
        throw retryErr;
      }
    } else if (isExpectedNoCaptions(err)) {
      return null;
    } else {
      console.error("[captions] CAPTION_UNEXPECTED_FAILURE", {
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        videoId,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        err,
      });
      throw err;
    }
  }
```

- [ ] **Step 4: Run the new tests, confirm all seven pass**

Run: `npm test -- src/lib/__tests__/captions.test.ts -t "primary-subtag retry"`

Expected: 7 passed.

- [ ] **Step 5: Run the full test suite, confirm no regressions**

Run: `npm test`

Expected: 210 passed (203 prior + 7 new), 0 failed.

- [ ] **Step 6: Lint**

Run: `npm run lint` (if a `lint` script exists; otherwise `npx eslint src/`)

Expected: 0 errors. Fix any introduced.

- [ ] **Step 7: Commit**

```bash
git add src/lib/captions.ts src/lib/__tests__/captions.test.ts
git commit -m "$(cat <<'EOF'
fix(captions): retry primary-subtag lang against region-tagged tracks

youtube-transcript-plus matches `lang` against `track.languageCode`
with strict equality. We pass primary-subtag codes (`zh`) but YouTube
tags tracks with region/script (`zh-Hans`), so the library throws
NotAvailableLanguage and we silently fall through to the English
fallback — producing English transcripts and summaries for non-English
videos that have uploader-provided English subs.

Catch NotAvailableLanguageError, look up a matching variant from the
error's availableLangs, retry once with the exact code. Region-tagged
inputs (e.g. `en-US`) skip the retry — those callers asked for
something specific.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: PR, review, and merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin fix/zh-caption-primary-subtag-retry
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "fix(captions): retry primary-subtag lang against region-tagged tracks" --body "$(cat <<'EOF'
## Summary
- Bug: Chinese videos summarized in English. youtube-transcript-plus does strict-equality on track `languageCode`; we pass `lang="zh"` but the track is `"zh-Hans"`, so the library throws and we silently retry with `"en"` (uploader-provided English subs match), producing English transcripts.
- Fix: catch `YoutubeTranscriptNotAvailableLanguageError`, look up a primary-subtag match in `err.availableLangs`, retry once with the matched code. Region-tagged inputs (`en-US`) skip the retry.
- Spec: `docs/superpowers/specs/2026-04-26-zh-caption-matching-design.md`.

## Test plan
- [x] 7 new vitest cases in `captions.test.ts` covering: zh→zh-Hans success, no-match no-retry, region-tagged skip, script+region variant, case-insensitive, retry-throws-expected, retry-throws-unexpected.
- [x] Full vitest suite green (210/210).
- [x] Lint clean.
- [ ] Post-merge: invalidate cache row for `xMZqTuLWSA4` and Playwright e2e against prod confirms Chinese transcript+summary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Run pr-review-toolkit**

Invoke the `pr-review-toolkit:review-pr` skill against the PR number returned by `gh pr create`. The diff is one source file + one test file in TypeScript — applicable agents are `code-reviewer` (always) and `pr-test-analyzer` (since test file changed). Skip `comment-analyzer`/`type-design-analyzer`/`silent-failure-hunter` unless reviewer flags concerns.

If the reviewer reports `Critical` or `Important` issues, fix them in the worktree, push, and re-run the toolkit. Skip if it returns clean.

- [ ] **Step 4: Wait for CI**

Run: `gh pr checks <PR-number>` until all required checks pass (test, lint, typecheck, build).

If checks fail, investigate and fix the underlying issue — never `--no-verify` or skip required checks.

- [ ] **Step 5: STOP — request explicit user approval before merging**

Memory `feedback_pr_merge_requires_approval`: never `gh pr merge` without per-merge user approval. Pause and ask: "PR is green and review is clean — OK to squash-merge and delete the branch?"

- [ ] **Step 6: Merge after approval**

```bash
gh pr merge <PR-number> --squash --auto --delete-branch
```

(The `--auto` flag is harmless when checks are already green; with `--delete-branch` the remote branch is removed on successful merge.)

- [ ] **Step 7: Confirm merge**

```bash
gh pr view <PR-number> --json state,mergedAt
```

Expected: `{"state":"MERGED","mergedAt":"..."}`.

---

## Task 3: Cache invalidation for xMZqTuLWSA4

**Pre-requisite:** VPS deploy from Task 2's merged main commit must be live. The youtube-ai-service has push-to-main CI deploy per `CLAUDE.md` — confirm via the deploy workflow's status before running the SQL, otherwise the next request to this URL re-poisons the cache row.

- [ ] **Step 1: Verify deploy succeeded**

Run: `gh run list --workflow=<deploy-workflow-name> --limit 5` (the youtube-ai-service deploy workflow) or check the deploys section of the Actions tab. Wait until the post-merge run on `main` shows `success`.

- [ ] **Step 2: Run the cache-invalidation SQL via Supabase MCP**

Use the `mcp__plugin_supabase_supabase__execute_sql` MCP tool (the `supabase:supabase` skill is the entry point). The frontend Supabase project is the one tied to the `youtubeai_chat_frontend` app — use `mcp__plugin_supabase_supabase__list_projects` first to confirm the right project ID, then:

```sql
DELETE FROM videos
WHERE youtube_url = 'https://www.youtube.com/watch?v=xMZqTuLWSA4'
RETURNING id, youtube_url;
```

The `RETURNING` clause echoes the row(s) deleted so we can confirm exactly one row matched. The FKs on `summaries.video_id` and `video_transcripts.video_id` use `ON DELETE CASCADE` so both tables clean up automatically.

Expected output: one row returned with the URL above. If zero rows: the URL was never cached (unlikely given the user reported it just now) — proceed to verification anyway. If multiple rows: investigate (would indicate a uniqueness regression).

---

## Task 4: Production verification

- [ ] **Step 1: Playwright e2e against production**

Use the `playwright` skill. Write a one-off script at `/tmp/playwright-test-zh-caption.js`:

```javascript
const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'https://www.youtubeai.chat';
const VIDEO_URL = 'https://www.youtube.com/watch?v=xMZqTuLWSA4';
const creds = fs.readFileSync('/home/xingdi/.config/claude-test-creds/youtubeai.env', 'utf8');
const EMAIL = creds.match(/TEST_USER_EMAIL=(.+)/)[1].trim();
const PASSWORD = creds.match(/TEST_USER_PASSWORD=(.+)/)[1].trim();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(`${TARGET_URL}/auth/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(u => !u.toString().includes('/auth/login'), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${TARGET_URL}/summary?url=${encodeURIComponent(VIDEO_URL)}`, { waitUntil: 'domcontentloaded' });

  // Real summarization can take ~minute on cold cache; allow generous wait.
  await page.waitForSelector('.prose p', { timeout: 240000 });
  // Give streaming a beat to finish painting before sampling.
  await page.waitForTimeout(2000);

  const summaryText = await page.evaluate(() => {
    const proseEls = document.querySelectorAll('.prose p, .prose li, .prose h1, .prose h2, .prose h3');
    return Array.from(proseEls).map(el => el.textContent || '').join(' ');
  });

  const cjkRegex = /\p{Script=Han}/u;
  const hasCjk = cjkRegex.test(summaryText);
  const sample = summaryText.slice(0, 200);

  console.log('Sample of rendered summary:', sample);
  console.log('Contains CJK characters:', hasCjk);

  await page.screenshot({ path: '/tmp/zh-caption-fix-after.png', fullPage: true });
  console.log('Screenshot: /tmp/zh-caption-fix-after.png');

  await browser.close();
  process.exit(hasCjk ? 0 : 1);
})();
```

Run: `cd /home/xingdi/.claude/skills/playwright && node run.js /tmp/playwright-test-zh-caption.js`

Expected output: `Contains CJK characters: true` and exit code 0. The script exits 1 if the rendered summary lacks any Han-script character — a strong signal the fix didn't take effect (deploy not propagated, cache not invalidated, or different bug).

- [ ] **Step 2: Spot-check VPS logs for the retry warn line**

The first post-deploy request to `xMZqTuLWSA4` should emit one `[captions] CAPTION_LANG_RETRY_PRIMARY_SUBTAG` warn line. If the VPS logging stack is reachable from the dev machine (Tailscale + the operator's preferred log viewer — check `youtube-ai-service/scripts/` for what the project uses), grep for `CAPTION_LANG_RETRY_PRIMARY_SUBTAG` and confirm one entry with `requested: "zh"` and a `matched` field starting with `zh-`.

If logs aren't accessible from this environment, this step is informational — Step 1's CJK assertion is the load-bearing verification.

- [ ] **Step 3: Report completion**

Summarize back to the user: PR merged at `<sha>`, cache row deleted, Playwright e2e passed with CJK output. Attach the `/tmp/zh-caption-fix-after.png` screenshot path.

---

## Self-review (writing-plans skill)

Spec coverage:
- Spec §Approach (single-file fix at captions adapter, retry once on primary-subtag mismatch, region-tagged skip, no second retry, log on retry) — Task 1 Step 3.
- Spec §Tests (seven specific cases) — Task 1 Step 1 contains all seven verbatim.
- Spec §Cache invalidation (single SQL via Supabase MCP, cascades) — Task 3 Step 2.
- Spec §Verification (full vitest, lint, Playwright with CJK assertion, log spot-check) — Task 1 Steps 5-6, Task 4 Steps 1-2.
- Spec §Risk and rollback — covered implicitly by the squash merge in Task 2 Step 6 (revert is one `git revert` + redeploy if needed).

No placeholders. No TBDs. All code blocks complete. All commands include exact paths and expected output. Function names (`findSubtagMatch`, `fetchCaptions`), error class (`YoutubeTranscriptNotAvailableLanguageError`), and log id (`CAPTION_LANG_RETRY_PRIMARY_SUBTAG`) are consistent across the implementation, tests, and verification steps.

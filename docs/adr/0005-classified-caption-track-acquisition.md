# Put Caption Track acquisition behind one classified application seam

**Date:** 2026-08-03
**Status:** Accepted
**Owner:** youtube-ai-service maintainers

## Context

The `/captions` route previously depended on a positional `fetchCaptions`
surface that exposed provider policy through its arguments and represented
every expected provider result as either a wide result object or `null`.
Unavailable videos therefore looked identical to available videos without a
usable Caption Track, and route tests had to know provider policy.

## Decision

Caption Track acquisition exposes one callable application seam:

```text
acquire({ videoReference, requestedLanguage?, requestId, signal })
  -> acquired | absent | video-unavailable
```

The request contains the immutable, already-validated `YouTubeVideoReference`
and the request work signal. Its fields are readonly and the HTTP route freezes
the request before calling the seam. The outcome is a closed discriminated
union; unexpected defects throw and are not represented as a fourth result.

| Outcome | Meaning | Fallback eligibility |
| --- | --- | --- |
| `acquired` | Non-empty `TimedTextSegment[]`, `auto_captions`, Prompt Locale, and nullable title/channel data | Caption Track is usable; do not run Transcription |
| `absent` | An available video has no usable track: disabled, missing, exhausted language matching, empty provider result, or filtered-empty segments | Only outcome eligible for Transcription fallback |
| `video-unavailable` | The valid reference cannot be retrieved, including provider-unavailable and invalid-reference classifications | Terminal; never fallback |

The acquisition module owns provider invocation, the one bounded primary-
subtag retry, provider-error translation, entity decoding, invalid-code-point
defense, whitespace filtering, Prompt Locale selection, and safe structured
diagnostics. The `youtube-transcript-plus` adapter translates only its provider
exceptions and response schema into an internal provider result. Network,
schema, parsing, programming, and unknown provider defects escape unchanged.
The request work signal is checked before classification and after every
provider attempt so cancellation and deadlines retain their original reason.

The route owns authentication, request validation, resource admission,
request correlation, response shaping, and HTTP mapping. `acquired` maps to
the existing 200 response, including `segments`, timing units, metadata,
source, Prompt Locale as the wire `language` field, and the transitional
derived `transcript` field. `absent` maps to the existing bounded 404
`CAPTIONS_NOT_FOUND` response. `video-unavailable` maps to bounded terminal
422 `VIDEO_UNAVAILABLE`; unlike `absent`, it never authorizes Transcription
fallback. The frontend consumer is deployed before, or atomically with, this
service mapping.

Production composition constructs one acquisition module and injects only
that seam into the route. Acquisition tests fake only the provider adapter;
route tests fake only the acquisition seam; composition tests exercise the
real production acquisition path and ensure the route cannot bypass it.

## Vocabulary

`TimedTextSegment` is the source-neutral shared shape used by Caption Track
acquisition and Transcription. It preserves the existing `text`, `start`, and
`duration` wire fields and numeric seconds units. `PromptLocale` remains the
binary `en`/`zh` prompt-routing value and is not a replacement for a full
Language Tag.

## Consequences

- A caller receives a truthful internal availability classification and
  fallback policy has one owner.
- Provider library classes and raw payloads cannot leak into routes or HTTP
  responses.
- The terminal Video Unavailable wire contract is activated independently
  after the consumer rollout without reopening acquisition policy.
- Tests observe behavior through the application and provider seams, so helper
  reorganization does not change the test contract.

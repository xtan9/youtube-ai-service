# Keep one canonical Language Tag policy at the service boundary

The service accepts language values from callers and providers at several
boundaries, but the meaning of those values is not interchangeable. The
service therefore keeps one generic Language Tag policy in
`src/lib/language-tag.ts`. That module is the only owner of bounded parsing,
runtime canonicalization, parse-failure classification, canonical identity,
and Primary Language Code derivation.

Consumers receive the narrow representation their work can honor:

| Boundary | Representation | Responsibility |
| --- | --- | --- |
| `/captions` and `/transcribe` request intake | canonical `LanguageTag` | Parse caller text and map rejection to the stable 400 response before provider work. |
| Video Information provider adapter | canonical `LanguageTag` or absence | Parse yt-dlp language values and report bounded rejection classifications to the workflow. |
| Detection | `LanguageTag` or absence | Select evidence without reparsing or discarding full-tag detail. |
| Metadata response | `PrimaryLanguageCode` | Preserve the v1 lowercase two-letter wire meaning. |
| Caption Track adapter | `LanguageTag` plus a bounded raw provider token during retry | Compare canonical identity; retain raw spelling only long enough for the strict provider transport call. |
| Prompt selection, Transcription workflow, Groq, and Whisper | `PrimaryLanguageCode` or absence | Consume validated backend language intent without language parsing. |
| Caption Track response | `PromptLocale` | Preserve the existing binary prompt-routing meaning derived from the returned track. |

Canonical identity is the domain value. Raw provider spelling is transport
data and is confined to the Caption Track adapter because its provider uses
strict string matching. It must not become a domain value, response field, or
second language policy.

This decision deliberately has no feature flag, compatibility parser, shared
frontend/service package, or additional language dependency. The service-local
policy and the mirrored v1 fixture manifest are the release boundaries.

## Repository invariants

Review searches must continue to show that:

- `new Intl.Locale` is present only in `src/lib/language-tag.ts`; other modules
  consume the public policy rather than calling the runtime canonicalizer.
- Language-tag rejection and identity mechanics are owned by that same module;
  detection, prompt selection, Caption Track matching, Groq, and Whisper do not
  carry their own regexes, sentinel collections, alias tables, or primary-tag
  splitting.
- Provider transport pairing (`availableLangs` and the bounded raw token) is
  confined to `src/lib/captions.ts`; yt-dlp language values are parsed at their
  adapter boundary and only canonical values escape.

The public tests should observe Language Tag semantics, consumer arguments, or
HTTP responses. They should not import parser internals, conversion data, or
runtime canonicalization details.

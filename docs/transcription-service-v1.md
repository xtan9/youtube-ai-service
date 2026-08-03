# Transcription service HTTP contract v1

**Contract version:** `transcription-http/v1`<br />
**Service owner:** `xtan9/youtube-ai-service`<br />
**Frontend consumer:** `xtan9/youtubeai_chat_frontend`

The canonical cross-repository contract is documented in the frontend
repository at
[`docs/contracts/transcription-service-v1.md`](https://github.com/xtan9/youtubeai_chat_frontend/blob/main/docs/contracts/transcription-service-v1.md).
This repository owns the route implementation and keeps the exact fixture
mirror at
[`test-fixtures/transcription-contract/v1/cases.json`](../test-fixtures/transcription-contract/v1/cases.json).

The service exposes authenticated `POST /metadata`, `POST /captions`, and
`POST /transcribe` endpoints. The current response shape is a non-empty
`segments` array plus the additive `transcript` compatibility alias. Invalid
JSON, invalid YouTube URLs, invalid language hints, empty results, and the
documented provider failures retain stable status meanings; provider details
remain in bounded logs rather than response bodies.

For `/captions`, `404 CAPTIONS_NOT_FOUND` means the available Video has no
usable Caption Track and is the only outcome that authorizes frontend
Transcription fallback. A valid YouTube Video Reference that cannot be
retrieved maps to terminal `422 VIDEO_UNAVAILABLE`; unexpected acquisition
defects remain `500 CAPTIONS_FAILED` and are never fallback-eligible.

Language meanings remain endpoint-specific and stable: `/metadata` emits
lowercase two-letter Primary Language Codes, `/captions` keeps its `language`
field as the binary Prompt Locale derived from the returned Caption Track, and
`/transcribe` returns the canonical full Language Tag supplied by the caller or
`"auto"` when language is omitted. Request input is parsed once by the
service-local Language Tag policy; Transcription, Groq, and Whisper receive
only the resulting Primary Language Code or absence.

Resource limits are enforced before provider work can produce a successful
response. The service fails closed when any required limit setting is missing
or invalid. Request bodies are bounded on all three data endpoints;
transcription downloads are bounded by both media bytes and duration, with an
unknown duration rejected; per-key rate limits, concurrent transcription
capacity, and endpoint timeouts are enforced in the service process. Limit and
timeout responses are generic and stable: `413` for an oversized body or media
item, `429` for rate or concurrency limits, `503` when media duration cannot be
determined or service limits are misconfigured, and `504` for an endpoint
timeout. These responses never include provider diagnostics or bearer-key
material.

The `/metadata` `duration` field uses `null` for an unknown video duration.
That is distinct from the frontend's internal `duration: 0` marker on a
synthesized untimed segment when it consumes the legacy transcript-only
compatibility variant.

The `legacy-transcript-only` fixture keeps the canonical producer response
under both repository entries and stores the old consumer input as an explicit
`legacyResponse` variant. The service route test therefore remains a producer
test, while the frontend adapter test exercises the rollout bridge.

The fixture-driven route tests use the real Hono handlers and stub only the
provider boundary. They do not call YouTube, Groq, Whisper, or any paid
service. Keep this fixture file byte-for-byte identical to the frontend copy
when the contract changes.

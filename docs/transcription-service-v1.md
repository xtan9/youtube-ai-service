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

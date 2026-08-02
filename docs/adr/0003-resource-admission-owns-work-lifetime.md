# Resource admission owns work lifetime

Each application instance owns one resource-admission module whose rate state, transcription capacity, endpoint deadlines, and request work signals are shared across protected routes. A deadline cancels the active body reader, network request, retry delay, or child process and does not release transcription capacity or return the timeout response until downstream cleanup settles; this is deliberately stricter than a response-only timer so a 504 cannot hide continuing work or admit an unbounded replacement job.

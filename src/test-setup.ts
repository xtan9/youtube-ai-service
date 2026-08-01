import { beforeEach } from "vitest";

// Route tests exercise the production fail-closed configuration path. Keep
// the suite's ordinary requests within generous, deterministic test limits;
// individual tests override or delete these values when they need to pin a
// rejection boundary.
beforeEach(() => {
  process.env.MAX_REQUEST_BODY_BYTES ??= "65536";
  process.env.MAX_MEDIA_SIZE_BYTES ??= "50000000";
  process.env.MAX_MEDIA_DURATION_SECONDS ??= "1800";
  process.env.RATE_LIMIT_WINDOW_MS ??= "60000";
  process.env.RATE_LIMIT_MAX_REQUESTS ??= "1000";
  process.env.MAX_CONCURRENT_JOBS ??= "8";
  process.env.METADATA_TIMEOUT_MS ??= "30000";
  process.env.CAPTIONS_TIMEOUT_MS ??= "30000";
  process.env.TRANSCRIBE_TIMEOUT_MS ??= "300000";
});

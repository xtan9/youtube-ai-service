// Must run before any HTTP client is created — see prefer-ipv4.ts for why.
import "./lib/prefer-ipv4.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./lib/runtime-config.js";

const config = loadRuntimeConfig(process.env);
const app = createApp(config);
const { port } = config.server;

console.log(`youtube-ai-service starting on port ${port}`);

serve({ fetch: app.fetch, port });

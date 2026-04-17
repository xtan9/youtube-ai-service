import { Hono } from "hono";

const transcribe = new Hono();

transcribe.post("/transcribe", async (c) => {
  return c.json({ error: "Not implemented yet" }, 501);
});

export { transcribe };

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.js";
import { loadConfig } from "../config.js";
import { smokeRemote } from "../scripts/remote-smoke.js";

test("remote smoke validates anonymous health/readiness and closes upstream without audio", async (t) => {
  const config = loadConfig({
    FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/project",
    AZURE_AUTH_MODE: "azure-cli"
  });
  let disposed = false, resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const native = { async connect() {
    return {
      async *[Symbol.asyncIterator]() { yield { type: "session.updated" }; await done; },
      async dispose() { disposed = true; resolveDone(); },
      async sendAudio() { assert.fail("Remote smoke must not send audio."); }
    };
  } };
  const app = await createApp(config, native);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = app.server.address().port;
  config.origin = `http://127.0.0.1:${port}`;
  config.host = `127.0.0.1:${port}`;
  t.after(() => app.close());
  assert.deepEqual(await smokeRemote(config.origin, 3000),
    { health: 200, ready: true, sampleRate: 24000, cleanClose: true });
  assert.equal(disposed, true);
});
test("remote smoke refuses credentials, paths and insecure public origins", async () => {
  for (const origin of ["https://user:pass@example.com", "https://example.com/path", "http://example.com"]) {
    await assert.rejects(smokeRemote(origin));
  }
});

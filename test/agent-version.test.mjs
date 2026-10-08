import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureVersion } from "../scripts/agent-version.mjs";

const definition = JSON.parse(await readFile(new URL("../agent/definition.json", import.meta.url), "utf8"));

test("exported definition contains native managed voice configuration and safety boundaries", () => {
  assert.equal(definition.kind, "voice");
  assert.equal(definition.model_type, "managed");
  assert.equal(definition.model, "gpt-realtime-2.1");
  assert.equal(definition.audio.output.voice_type, "azure-standard");
  assert.equal(definition.audio.input.transcription.model, "azure-speech");
  assert.match(definition.instructions, /not a therapist/);
  assert.match(definition.instructions, /local emergency services/);
  assert.equal(definition.tools, undefined);
});

test("agent setup reuses an identical definition without creating another version", async () => {
  let created = false;
  const agents = {
    async *listVersions(name, options) {
      assert.equal(name, "motivation-coach-agent");
      assert.equal(options.requestOptions.headers["foundry-features"], "VoiceAgents=V1Preview");
      yield { version: "5", definition: { ...definition } };
    },
    createVersion() { created = true; }
  };
  assert.equal(await ensureVersion(agents, "motivation-coach-agent", definition), "5");
  assert.equal(created, false);
});

test("missing agent creates a native version with preview header", async () => {
  const agents = {
    async *listVersions() { throw Object.assign(new Error("missing"), { statusCode: 404 }); },
    async createVersion(name, body, options) {
      assert.equal(name, "motivation-coach-agent");
      assert.deepEqual(body, definition);
      assert.equal(options.requestOptions.headers["foundry-features"], "VoiceAgents=V1Preview");
      return { version: "1" };
    }
  };
  assert.equal(await ensureVersion(agents, "motivation-coach-agent", definition), "1");
});

test("RBAC propagation retries authorization only, never ambiguous writes", async () => {
  let writes = 0, sleeps = 0;
  const agents = {
    async *listVersions() {},
    async createVersion() {
      writes++;
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }
  };
  await assert.rejects(ensureVersion(agents, "motivation-coach-agent", definition,
    async () => { sleeps++; }), /forbidden/);
  assert.equal(writes, 10);
  assert.equal(sleeps, 9);
  writes = 0;
  agents.createVersion = async () => { writes++; throw Object.assign(new Error("unavailable"), { statusCode: 503 }); };
  await assert.rejects(ensureVersion(agents, "motivation-coach-agent", definition), /unavailable/);
  assert.equal(writes, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { VoiceAgentRealtimeClient } from "@azure/ai-projects";
import { WebSocketServer } from "ws";
import { BoundedTransport } from "../native.js";
import { MAX_UPSTREAM_BYTES } from "../limits.js";

test("installed SDK uses native voice route, preview opt-in, AI token scope and pinned version", async () => {
  let scope, options, handlers;
  const sent = [];
  const transport = {
    setHandlers(value) { handlers = value; },
    async connect(value) { options = value; },
    async send(value) { sent.push(JSON.parse(value)); },
    async close() { handlers.onClose(1000, "done", true); }
  };
  const client = new VoiceAgentRealtimeClient("https://example.services.ai.azure.com/api/projects/project",
    { async getToken(value) { scope = value; return { token: "test-only", expiresOnTimestamp: Date.now() + 10000 }; } },
    { webSocketFactory: { create: () => transport } });
  const connection = await client.connect("motivation-coach-agent",
    { agentVersionOverride: "1", store: false, transport: "websocket" });
  const url = new URL(options.url);
  assert.equal(url.pathname, "/api/projects/project/agents/motivation-coach-agent/endpoint/protocols/voice");
  assert.equal(url.protocol, "wss:");
  assert.equal(url.searchParams.get("x-agent-version-override"), "1");
  assert.equal(url.searchParams.get("store"), "false");
  assert.equal(url.searchParams.get("api-version"), "v1");
  assert.equal(options.headers["foundry-features"], "VoiceAgents=V1Preview");
  assert.equal(scope, "https://ai.azure.com/.default");
  await connection.sendAudio(new Uint8Array([1, 2, 3, 4]));
  assert.equal(sent[0].type, "input_audio_buffer.append");
  assert.equal(sent[0].audio, "AQIDBA==");
  await connection.dispose();
});
test("native transport rejects oversized upstream messages", async (t) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  t.after(() => new Promise((resolve) => wss.close(resolve)));
  let resolveError;
  const error = new Promise((resolve) => { resolveError = resolve; });
  const transport = new BoundedTransport();
  transport.setHandlers({ onMessage() { assert.fail("Oversized payload should not be delivered."); },
    onClose() {}, onError: resolveError });
  const peer = once(wss, "connection");
  await transport.connect({ url: `ws://127.0.0.1:${wss.address().port}`, protocols: [],
    headers: {}, connectionTimeoutInMs: 1000 });
  const [ws] = await peer;
  ws.send("x".repeat(MAX_UPSTREAM_BYTES + 1));
  assert.match((await error).message, /Max payload size exceeded/);
  await transport.close(1000, "done");
});

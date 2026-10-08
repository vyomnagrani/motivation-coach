import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createApp } from "../server.js";
import { loadConfig } from "../config.js";

class FakeConnection {
  constructor() { this.events = []; this.waiter = null; this.done = false; this.audio = []; this.controls = []; }
  push(event) { if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value: event }); } else this.events.push(event); }
  async *[Symbol.asyncIterator]() {
    while (!this.done) {
      if (this.events.length) yield this.events.shift();
      else {
        const item = await new Promise((resolve) => { this.waiter = resolve; });
        if (item.done) return;
        yield item.value;
      }
    }
  }
  async sendAudio(data) { this.audio.push(Buffer.from(data)); }
  async sendEvent(event) { this.controls.push(event); }
  async cancelResponse(event) { this.controls.push(event); }
  async dispose() { this.done = true; this.waiter?.({ done: true }); this.waiter = null; }
}

async function setup(t, options = {}) {
  const connections = [];
  const config = loadConfig({ FOUNDRY_PROJECT_ENDPOINT: "https://test.services.ai.azure.com/api/projects/test", AZURE_AUTH_MODE: "azure-cli" });
  const native = { hasStartupGreeting: Boolean(options.greeting), async connect() {
    const connection = new FakeConnection(); connections.push(connection);
    connection.push({ type: "session.updated" }); return connection;
  } };
  const app = await createApp(config, native, options);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  config.origin = origin; config.host = `127.0.0.1:${port}`;
  t.after(() => app.close());
  function socket(headers = {}, path = "/api/voice") {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Origin: origin, ...headers }, perMessageDeflate: false
    });
    const messages = [];
    ws.on("message", (data, binary) => messages.push(binary ? data : JSON.parse(data.toString())));
    ws.on("error", () => {});
    return { ws, messages };
  }
  async function open() {
    const client = socket();
    await once(client.ws, "open");
    await until(() => client.messages.some((m) => m.type === "ready"));
    return client;
  }
  return { app, config, origin, socket, open, connections };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for condition.");
}
async function rejected(client) {
  const [, response] = await once(client.ws, "unexpected-response");
  response.resume();
  client.ws.terminate();
  return response.statusCode;
}

test("only health/static routes exist; security headers prevent framing and sniffing", async (t) => {
  const { origin } = await setup(t);
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const html = await fetch(origin);
  assert.match(await html.text(), /Just start talking/);
  assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  const copy = await fetch(`${origin}/api/content`);
  assert.equal(copy.headers.get("cache-control"), "no-store");
  assert.equal((await copy.json()).content.title, "Vyom's Motivation Coach");
  assert.equal((await fetch(`${origin}/content-view.js`)).status, 200);
  for (const path of ["/.env", "/api/history", "/api/agents", "/native.js", "/api/voice?agent=other"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  assert.equal((await fetch(origin, { method: "POST", body: "upload" })).status, 405);
});
test("websocket upgrade requires exact configured origin and fixed route", async (t) => {
  const { socket, connections } = await setup(t);
  assert.equal(await rejected(socket({ Origin: "https://evil.example" })), 403);
  assert.equal(await rejected(socket({ Origin: "null" })), 403);
  assert.equal(await rejected(socket({}, "/api/voice?agent=other")), 404);
  assert.equal(connections.length, 0);
});
test("PCM proxy sends bytes, streams native audio/transcripts, handles interruption/truncation", async (t) => {
  const { open, connections, app } = await setup(t);
  const { ws, messages } = await open();
  const connection = connections[0];
  ws.send(Buffer.alloc(4800, 1));
  await until(() => connection.audio.length === 1);
  assert.equal(connection.audio[0].length, 4800);
  connection.push({ type: "response.created", response: { id: "r1" } });
  connection.push({ type: "response.output_audio.delta", item_id: "item_1", content_index: 0, response_id: "r1", delta: new Uint8Array(4800) });
  connection.push({ type: "response.output_audio_transcript.delta", item_id: "item_1", response_id: "r1", delta: "Hello" });
  await until(() => messages.some((m) => m.type === "transcript"));
  assert.ok(messages.some(Buffer.isBuffer));
  assert.equal(messages.find((m) => m.type === "transcript").delta, "Hello");
  connection.push({ type: "input_audio_buffer.speech_started" });
  await until(() => messages.some((m) => m.type === "interrupted"));
  ws.send(JSON.stringify({ type: "played", itemId: "item_1", contentIndex: 0, audioEndMs: 50 }));
  await until(() => connection.controls.length === 1);
  assert.equal(connection.controls[0].type, "conversation.item.truncate");
  assert.equal(connection.controls[0].audio_end_ms, 50);
  const before = messages.length;
  connection.push({ type: "response.created", response: { id: "r2" } });
  connection.push({ type: "response.output_audio.delta", item_id: "item_1", content_index: 0, response_id: "r1", delta: new Uint8Array(4800) });
  await delay(30);
  assert.equal(messages.length, before);
  ws.send('{"type":"end"}');
  await once(ws, "close");
  await until(() => app.sessions.size === 0);
  assert.equal(connection.done, true);
});
test("manual interruption cancels active response without provider-specific response ID", async (t) => {
  const { open, connections } = await setup(t);
  const { ws, messages } = await open();
  connections[0].push({ type: "response.created", response: { id: "r1" } });
  connections[0].push({ type: "response.output_audio.delta", item_id: "item_1", content_index: 0,
    response_id: "r1", delta: new Uint8Array(4800) });
  await until(() => messages.some(Buffer.isBuffer));
  ws.send('{"type":"interrupt"}');
  await until(() => connections[0].controls.length === 1);
  assert.equal(connections[0].controls[0], undefined);
  assert.ok(messages.some((m) => m.type === "interrupted"));
  ws.close();
});
test("native startup greeting is cleared but not truncated as a nonexistent conversation item", async (t) => {
  const { open, connections } = await setup(t, { greeting: true });
  const { ws, messages } = await open();
  connections[0].push({ type: "response.created", response: { id: "greeting" } });
  connections[0].push({ type: "response.output_audio.delta", item_id: "greeting_item", content_index: 0,
    response_id: "greeting", delta: new Uint8Array(4800) });
  await until(() => messages.some(Buffer.isBuffer));
  connections[0].push({ type: "input_audio_buffer.speech_started" });
  await until(() => messages.some((m) => m.type === "interrupted"));
  ws.send(JSON.stringify({ type: "played", itemId: "greeting_item", contentIndex: 0, audioEndMs: 0 }));
  await delay(30);
  assert.equal(connections[0].controls.length, 0);
  assert.ok(!messages.some((m) => m.type === "error"));
  ws.close();
});
test("invalid controls and odd-length PCM end the session", async (t) => {
  const { open } = await setup(t);
  const first = await open();
  first.ws.send('{"type":"session.update","model":"other"}');
  const [code] = await once(first.ws, "close");
  assert.equal(code, 1008);
  assert.ok(first.messages.some((m) => m.type === "error"));
  const second = await open();
  second.ws.send(Buffer.alloc(3));
  const [secondCode] = await once(second.ws, "close");
  assert.equal(secondCode, 1008);
});
test("per-client start rate and process concurrency are enforced before native connect", async (t) => {
  const { open, socket, connections, config } = await setup(t);
  const clients = await Promise.all([open(), open(), open()]);
  assert.equal(connections.length, 3);
  assert.equal(await rejected(socket()), 429);
  config.proxies.addAddress("127.0.0.1", "ipv4");
  assert.equal(await rejected(socket({ "X-Forwarded-For": "203.0.113.9" })), 503);
  for (const client of clients) client.ws.close();
});
test("five-minute cap timer closes both browser and upstream (shortened test clock)", async (t) => {
  const { open, connections, app } = await setup(t, { sessionMs: 150 });
  const { ws, messages } = await open();
  await once(ws, "close");
  assert.ok(messages.some((m) => m.type === "ended" && m.message.includes("five-minute")));
  await until(() => app.sessions.size === 0);
  assert.equal(connections[0].done, true);
});
test("upstream failure is sanitized and slot is released", async (t) => {
  const { open, connections, app } = await setup(t);
  const { ws, messages } = await open();
  connections[0].push({ type: "error", error: { message: "SECRET_TOKEN" } });
  await once(ws, "close");
  assert.ok(messages.some((m) => m.type === "error"));
  assert.ok(!JSON.stringify(messages).includes("SECRET_TOKEN"));
  await until(() => app.sessions.size === 0);
});

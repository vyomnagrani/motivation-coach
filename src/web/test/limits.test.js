import test from "node:test";
import assert from "node:assert/strict";
import { BlockList } from "node:net";
import { loadConfig, clientIp } from "../config.js";
import { StartLimiter, StreamLimiter, parseControl } from "../limits.js";

const env = { FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/example",
  AZURE_AUTH_MODE: "azure-cli" };

test("configuration accepts fixed project and rejects unsafe endpoints/auth/origins", () => {
  assert.equal(loadConfig(env).agent, "motivation-coach-agent");
  assert.equal(loadConfig(env).version, "1");
  assert.equal(loadConfig(env).contentUrl, "");
  assert.throws(() => loadConfig({ AZURE_AUTH_MODE: "azure-cli" }), /Set FOUNDRY_PROJECT_ENDPOINT/);
  assert.throws(() => loadConfig({ ...env, FOUNDRY_PROJECT_ENDPOINT: "" }), /Set FOUNDRY_PROJECT_ENDPOINT/);
  for (const endpoint of ["http://example.services.ai.azure.com/api/projects/example",
    "https://evil.example/api/projects/p", "https://example.services.ai.azure.com/api/projects/p?agent=x"]) {
    assert.throws(() => loadConfig({ ...env, FOUNDRY_PROJECT_ENDPOINT: endpoint }));
  }
  assert.throws(() => loadConfig({ ...env, PUBLIC_ORIGIN: "http://example.com" }));
  assert.throws(() => loadConfig({ ...env, PUBLIC_ORIGIN: "https://example.com/path" }));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: "production" }));
  assert.throws(() => loadConfig({ ...env, AZURE_AUTH_MODE: "managed-identity" }));
  assert.throws(() => loadConfig({ ...env, TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }));
});
test("forwarded IP is ignored unless the immediate proxy is trusted", () => {
  const proxies = new BlockList();
  proxies.addSubnet("10.0.0.0", 24, "ipv4");
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: { "x-forwarded-for": xff } });
  assert.equal(clientIp(req("::ffff:203.0.113.1", "1.2.3.4"), proxies), "203.0.113.1");
  assert.equal(clientIp(req("10.0.0.4", "fake, 1.2.3.4"), proxies), "10.0.0.4");
  assert.equal(clientIp(req("10.0.0.4", "1.2.3.4, 203.0.113.2, 10.0.0.3"), proxies), "203.0.113.2");
});
test("start limiter caps minute/hour and prunes expired clients", () => {
  const limiter = new StartLimiter();
  for (let i = 0; i < 3; i++) assert.equal(limiter.allow("ip", 0), true);
  assert.equal(limiter.allow("ip", 1), false);
  for (let i = 0; i < 7; i++) assert.equal(limiter.allow("ip", 60_000 * (i + 1)), true);
  assert.equal(limiter.allow("ip", 600_000), false);
  assert.equal(limiter.allow("ip", 3_600_000), true);
  assert.equal(limiter.clients.size, 1);
});
test("stream token buckets bound bursts and sustained audio", () => {
  const limiter = new StreamLimiter(0);
  for (let i = 0; i < 20; i++) assert.equal(limiter.allow(4800, 0), true);
  assert.equal(limiter.allow(4800, 0), false);
  assert.equal(limiter.allow(4800, 100), true);
  const messages = new StreamLimiter(0);
  for (let i = 0; i < 120; i++) assert.equal(messages.allow(0, 0), true);
  assert.equal(messages.allow(0, 0), false);
});
test("controls cannot choose agents, URLs, tools, or arbitrary protocol events", () => {
  for (const message of [null, [], { type: "session.update" }, { type: "end", agent: "other" },
    { type: "played", itemId: "x", contentIndex: 0, audioEndMs: -1 }]) {
    assert.throws(() => parseControl(Buffer.from(JSON.stringify(message))));
  }
  assert.deepEqual(parseControl(Buffer.from('{"type":"end"}')), { type: "end" });
  assert.equal(parseControl(Buffer.from('{"type":"played","itemId":"item_1","contentIndex":0,"audioEndMs":1}')).type, "played");
});

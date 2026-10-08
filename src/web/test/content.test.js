import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContentLoader, validateContent } from "../content.js";
import { applyContent, loadPageContent } from "../public/content-view.js";
import { loadConfig } from "../config.js";

const content = JSON.parse(await readFile(new URL("../public/content-defaults.json", import.meta.url), "utf8"));
const url = "https://raw.githubusercontent.com/vyomnagrani/motivation-coach/main/dynamic-content/foundryvoiceapp.json";

test("embedded HTML, bundled JSON and public dynamic content match every text field", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const dynamic = JSON.parse(await readFile(
    new URL("../../../dynamic-content/foundryvoiceapp.json", import.meta.url), "utf8"));
  const embedded = { title: html.match(/<title>([^<]*)<\/title>/)?.[1] };
  for (const [field, id] of Object.entries({
    title: "brand", tagline: "tagline", heading: "heading",
    introduction: "introduction", disclaimer: "disclaimer"
  })) {
    const text = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>([^<]*)<\\/`))?.[1];
    assert.equal(text, content[field], `HTML ${id} matches ${field}`);
    if (field !== "title") embedded[field] = text;
  }
  assert.deepEqual(embedded, content);
  assert.deepEqual(dynamic, content);
});

test("blank source serves bundled content without an external request", async () => {
  const loader = await createContentLoader("", async () => {
    assert.fail("Bundled content must not request an external source.");
  });
  assert.deepEqual(await loader(), { content });
});

test("text schema rejects missing, unknown, non-string and oversized fields", () => {
  assert.deepEqual(validateContent(content), content);
  for (const invalid of [null, [], { ...content, title: "" }, { ...content, title: {} },
    { ...content, title: "x".repeat(161) }, { ...content, script: "alert(1)" },
    { ...content, disclaimer: undefined }]) assert.throws(() => validateContent(invalid));
});

test("later page loads reread source; simultaneous requests are coalesced", async () => {
  let calls = 0;
  const loader = await createContentLoader(url, async () => {
    calls++;
    return new Response(JSON.stringify({ ...content, title: `Title ${calls}` }));
  });
  const [first, concurrent] = await Promise.all([loader(), loader()]);
  assert.equal(calls, 1);
  assert.equal(first.content.title, "Title 1");
  assert.deepEqual(first, concurrent);
  assert.equal((await loader()).content.title, "Title 2");
});

test("upstream failures, redirects, malformed data and oversized bodies report fallback", async () => {
  for (const request of [
    async () => new Response("", { status: 404 }),
    async () => new Response("not JSON"),
    async () => new Response(JSON.stringify({ title: "missing fields" })),
    async () => new Response("x".repeat(16385)),
    async (_url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal);
      throw new Error("network unavailable");
    }
  ]) {
    const logs = [];
    const loader = await createContentLoader(url, request, (...args) => logs.push(args));
    const result = await loader();
    assert.deepEqual(result.content, content);
    assert.match(result.warning, /Showing bundled text/);
    assert.equal(logs.length, 1);
  }
});

test("source configuration only accepts credential-free GitHub raw JSON URLs", () => {
  const env = { FOUNDRY_PROJECT_ENDPOINT: "https://test.services.ai.azure.com/api/projects/test", AZURE_AUTH_MODE: "azure-cli" };
  assert.equal(loadConfig({ ...env, CONTENT_SOURCE_URL: url }).contentUrl, url);
  for (const source of ["http://raw.githubusercontent.com/u/r/main/a.json",
    "https://example.com/a.json", "https://user:secret@raw.githubusercontent.com/u/r/main/a.json",
    `${url}?token=secret`, "https://raw.githubusercontent.com/u/r/main/a.js"]) {
    assert.throws(() => loadConfig({ ...env, CONTENT_SOURCE_URL: source }));
  }
});

test("browser updates all copy as plain text and displays source failure notice", async () => {
  const elements = new Map();
  const document = { title: "", getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: true });
    return elements.get(id);
  } };
  applyContent({ ...content, title: "<script>not executable</script>" }, document);
  assert.equal(document.title, "<script>not executable</script>");
  assert.equal(elements.get("brand").textContent, document.title);
  assert.equal(elements.get("introduction").textContent, content.introduction);
  await loadPageContent(document, async (path) => {
    assert.equal(path, "/api/content");
    return new Response(JSON.stringify({ content, warning: "Source unavailable" }));
  });
  assert.equal(document.title, content.title);
  assert.equal(elements.get("content-notice").hidden, false);
  assert.equal(elements.get("content-notice").textContent, "Source unavailable");
});

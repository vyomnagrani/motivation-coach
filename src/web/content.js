import { readFile } from "node:fs/promises";

const limits = { title: 160, tagline: 300, heading: 300, introduction: 2000, disclaimer: 1000 };
const maxBytes = 16384;

export function validateContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !Object.hasOwn(limits, key))) {
    throw new Error("Content must be an object containing only the documented text fields.");
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > limit) {
      throw new Error(`Invalid content field: ${key}.`);
    }
  }
  return Object.fromEntries(Object.keys(limits).map((key) => [key, value[key]]));
}

export async function createContentLoader(url, request = fetch, log = console.error) {
  const defaults = validateContent(JSON.parse(await readFile(
    new URL("./public/content-defaults.json", import.meta.url), "utf8")));
  let pending;
  async function load() {
    if (!url) return { content: defaults };
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Content source returned HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error("Content source has no body.");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("Content source exceeds 16 KiB.");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      return { content: validateContent(JSON.parse(Buffer.concat(chunks).toString("utf8"))) };
    } catch (error) {
      log("Page content update failed:", error.message);
      return { content: defaults, warning: "Latest page text could not be loaded. Showing bundled text; reload to try again." };
    }
  }
  return () => {
    // Coalesce simultaneous page loads, but refresh the source on later visits.
    if (!pending) pending = load().finally(() => { pending = undefined; });
    return pending;
  };
}

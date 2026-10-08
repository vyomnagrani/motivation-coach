import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../src/web/package.json", import.meta.url));
const { AIProjectClient } = require("@azure/ai-projects");
const { AzureCliCredential } = require("@azure/identity");

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export async function ensureVersion(agents, name, definition, sleep = delay) {
  const options = { requestOptions: { headers: { "foundry-features": "VoiceAgents=V1Preview" } } };
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      for await (const version of agents.listVersions(name, options)) {
        if (JSON.stringify(canonical(version.definition)) === JSON.stringify(canonical(definition))) {
          return version.version;
        }
      }
      break;
    } catch (error) {
      if (error.statusCode === 404) break;
      if (error.statusCode !== 403 || attempt === 9) throw error;
      console.error("Waiting for project RBAC propagation before reading agent versions...");
      await sleep(30_000);
    }
  }
  // Only retry explicit authorization failures; do not duplicate ambiguous writes.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return (await agents.createVersion(name, definition, options)).version; }
    catch (error) {
      if (error.statusCode !== 403 || attempt === 9) throw error;
      console.error("Waiting for project RBAC propagation before creating the voice agent...");
      await sleep(30_000);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const endpoint = process.env.AZURE_AI_PROJECT_ENDPOINT;
  const name = process.env.FOUNDRY_VOICE_AGENT_NAME;
  if (!endpoint || !name) throw new Error("Missing provisioned project endpoint or agent name.");
  const definition = JSON.parse(await readFile(new URL("../agent/definition.json", import.meta.url), "utf8"));
  const project = new AIProjectClient(endpoint, new AzureCliCredential({
    subscription: process.env.AZURE_SUBSCRIPTION_ID
  }), { retryOptions: { maxRetries: 0 } });
  const version = await ensureVersion(project.agents, name, definition);
  if (!/^[1-9]\d*$/.test(version)) throw new Error("Foundry returned an invalid agent version.");
  console.log(version);
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/web/config.js";

const resources = await readFile(new URL("../infra/modules/resources.bicep", import.meta.url), "utf8");
const parameters = JSON.parse(await readFile(new URL("../infra/main.parameters.json", import.meta.url), "utf8"));

test("infrastructure configures the endpoint variable actually consumed by the app", () => {
  assert.match(resources, /name: 'FOUNDRY_PROJECT_ENDPOINT', value: projectEndpoint/);
  const config = loadConfig({
    FOUNDRY_PROJECT_ENDPOINT: "https://ai-motivation-coach-demo.services.ai.azure.com/api/projects/motivation-coach-project",
    FOUNDRY_VOICE_AGENT_NAME: "motivation-coach-agent",
    FOUNDRY_VOICE_AGENT_VERSION: "2",
    PUBLIC_ORIGIN: "https://ca-motivation-coach-demo.example",
    AZURE_AUTH_MODE: "managed-identity",
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    NODE_ENV: "production"
  });
  assert.equal(config.agent, "motivation-coach-agent");
  assert.equal(config.version, "2");
  assert.equal(config.authMode, "managed-identity");
});

test("repeat provisioning preserves image, pinned version and public origin", () => {
  assert.equal(parameters.parameters.containerImage.value,
    "${MOTIVATION_COACH_IMAGE=mcr.microsoft.com/azuredocs/containerapps-helloworld:latest}");
  assert.equal(parameters.parameters.agentVersion.value, "${FOUNDRY_VOICE_AGENT_VERSION=1}");
  assert.equal(parameters.parameters.publicOrigin.value, "${WEB_URL=}");
  assert.match(resources, /name: 'PUBLIC_ORIGIN', value: publicOrigin/);
  assert.match(resources, /registries: startsWith\(containerImage/);
});

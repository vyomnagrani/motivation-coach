import { AIProjectClient } from "@azure/ai-projects";
import { ManagedIdentityCredential, AzureCliCredential } from "@azure/identity";
import WebSocket from "ws";
import { MAX_BUFFER_BYTES, MAX_UPSTREAM_BYTES } from "./limits.js";

export function sessionConfig(agent) {
  const detection = agent.audio?.input?.turn_detection;
  const turnDetection = detection ? { ...detection, create_response: true, interrupt_response: true } :
    { type: "server_vad", create_response: true, interrupt_response: true, silence_duration_ms: 500 };
  return {
    type: "realtime", output_modalities: ["text", "audio"],
    audio: {
      input: { ...agent.audio?.input, format: { type: "audio/pcm", rate: 24_000 }, turn_detection: turnDetection },
      output: { ...agent.audio?.output, format: { type: "audio/pcm", rate: 24_000 } }
    }
  };
}

// The SDK owns native /protocols/voice routing, preview headers, version pinning,
// token scope and PCM event serialization. This transport only bounds I/O.
export class BoundedTransport {
  setHandlers(handlers) { this.handlers = handlers; }
  connect(options) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(options.url, options.protocols, {
        headers: options.headers, handshakeTimeout: options.connectionTimeoutInMs,
        maxPayload: MAX_UPSTREAM_BYTES, perMessageDeflate: false, followRedirects: false
      });
      let opened = false;
      const abort = () => { ws.terminate(); reject(new Error("Connection cancelled.")); };
      if (options.abortSignal?.aborted) { abort(); return; }
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      ws.on("open", () => { opened = true; resolve(); });
      ws.on("message", (data, binary) => {
        if (binary) { ws.terminate(); this.handlers.onError(new Error("Unexpected binary upstream event.")); return; }
        this.handlers.onMessage(data.toString("utf8"));
      });
      ws.on("error", (error) => { reject(error); this.handlers.onError(error); });
      ws.on("close", (code, reason) => {
        options.abortSignal?.removeEventListener("abort", abort);
        if (!opened) reject(new Error("Connection closed before opening."));
        this.handlers.onClose(code, reason.toString(), code === 1000);
      });
    });
  }
  send(data, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted || this.ws?.readyState !== WebSocket.OPEN ||
          Buffer.byteLength(data) > MAX_UPSTREAM_BYTES || this.ws.bufferedAmount > MAX_BUFFER_BYTES) {
        reject(new Error("Upstream send limit or disconnected.")); return;
      }
      this.ws.send(data, (error) => error ? reject(error) : resolve());
    });
  }
  async close(code, reason) {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    if (ws.readyState === WebSocket.CONNECTING) { ws.terminate(); return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
      timer.unref();
      ws.once("close", () => { clearTimeout(timer); resolve(); });
      ws.close(code === 1000 ? 1000 : 1011, code === 1000 ? "Session ended" : "Connection ended");
    });
  }
}

export function createNative(config) {
  const credential = config.authMode === "azure-cli" ? new AzureCliCredential() :
    new ManagedIdentityCredential({ clientId: config.clientId });
  const project = new AIProjectClient(config.endpoint, credential, {
    retryOptions: { maxRetries: 0 },
    realtimeOptions: { webSocketFactory: { create: () => new BoundedTransport() } }
  });
  let definitionPromise, cachedDefinition;
  async function definition(signal) {
    if (!definitionPromise) {
      definitionPromise = project.agents.getVersion(config.agent, config.version, {
        abortSignal: signal,
        requestOptions: { headers: { "foundry-features": "VoiceAgents=V1Preview" }, timeout: 20_000 }
      }).then((version) => {
        if (version.definition.kind !== "voice") throw new Error("Configured version is not kind=voice.");
        cachedDefinition = version.definition;
        return cachedDefinition;
      }).catch((error) => { definitionPromise = undefined; throw error; });
    }
    return definitionPromise;
  }
  return {
    definition,
    get hasStartupGreeting() { return cachedDefinition?.greeting != null; },
    async connect(signal) {
      const agent = await definition(signal);
      if (signal.aborted) throw new Error("Connection cancelled.");
      const connection = await project.beta.voiceAgents.realtime.connect(config.agent, {
        agentVersionOverride: config.version, store: false, transport: "websocket",
        connectionTimeoutInMs: 20_000, abortSignal: signal
      });
      try {
        await connection.configureSession(sessionConfig(agent));
        return connection;
      } catch (error) { await connection.dispose(); throw error; }
    }
  };
}

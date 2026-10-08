import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig, clientIp } from "./config.js";
import { createNative } from "./native.js";
import { createContentLoader } from "./content.js";
import { StartLimiter, StreamLimiter, parseControl, SESSION_MS, MAX_SESSIONS,
  MAX_PCM_BYTES, MAX_BUFFER_BYTES, MAX_UPSTREAM_BYTES } from "./limits.js";

export async function createApp(config, native = createNative(config), { sessionMs = SESSION_MS, contentFetch = fetch } = {}) {
  const loadContent = await createContentLoader(config.contentUrl, contentFetch);
  const files = new Map();
  for (const [route, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/content-view.js", "content-view.js", "text/javascript; charset=utf-8"],
    ["/pcm-worklet.js", "pcm-worklet.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"]
  ]) files.set(route, { data: await readFile(new URL(`./public/${file}`, import.meta.url)), type });
  const starts = new StartLimiter();
  const sessions = new Set();
  let shuttingDown = false;
  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
    res.setHeader("Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${config.origin.replace(/^http/, "ws")}; worker-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if (config.origin.startsWith("https:")) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return;
    }
    if (req.url === "/healthz") {
      res.writeHead(shuttingDown ? 503 : 200, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: shuttingDown ? "draining" : "ok" })); return;
    }
    if (req.url === "/api/content") {
      void loadContent().then((result) => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify(result));
      }).catch((error) => {
        console.error("Page content endpoint failed:", error.message);
        if (!res.destroyed) { res.writeHead(503); res.end(); }
      });
      return;
    }
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.data.length });
    res.end(req.method === "HEAD" ? undefined : file.data);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PCM_BYTES,
    perMessageDeflate: false, clientTracking: false });
  const reject = (socket, code, message) => {
    socket.end(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (shuttingDown || req.url !== "/api/voice" || req.method !== "GET") return reject(socket, 404, "Not Found");
    if (req.headers.origin !== config.origin || req.headers.host !== config.host ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") ||
        req.headers["sec-websocket-protocol"]) return reject(socket, 403, "Forbidden");
    if (!starts.allow(clientIp(req, config.proxies))) return reject(socket, 429, "Too Many Requests");
    if (sessions.size >= MAX_SESSIONS) return reject(socket, 503, "Service Unavailable");
    const slot = { stop: () => {} };
    sessions.add(slot);
    // Invalid upgrade headers can be rejected by ws before its callback runs.
    let accepted = false;
    const releaseUnaccepted = () => { if (!accepted) sessions.delete(slot); };
    socket.once("close", releaseUnaccepted);
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        accepted = true;
        socket.removeListener("close", releaseUnaccepted);
        serveVoice(ws, slot);
      });
    } catch { sessions.delete(slot); reject(socket, 400, "Bad Request"); }
  });

  function serveVoice(ws, slot) {
    const abort = new AbortController();
    const limiter = new StreamLimiter();
    const expiresAt = Date.now() + sessionMs;
    let connection, ended = false, ready = false, alive = true;
    let queuedBytes = 0, queuedMessages = 0, sends = Promise.resolve();
    let activeResponse, audioItem, pendingPlayed, lastInterrupt = 0;
    let greetingPending = false, greetingResponse;
    const droppedResponses = new Set();
    const emittedItems = new Map();
    const transmit = (msg) => {
      if (ended || ws.readyState !== WebSocket.OPEN) return false;
      const data = Buffer.isBuffer(msg) ? msg : JSON.stringify(msg);
      if (Buffer.byteLength(data) > MAX_UPSTREAM_BYTES || ws.bufferedAmount > MAX_BUFFER_BYTES) {
        stop("Your connection is too slow. Please reconnect.", 1008); return false;
      }
      ws.send(data);
      return true;
    };
    const report = (message) => transmit({ type: "error", message });
    const capTimer = setTimeout(() => stop("The five-minute session limit was reached."), sessionMs);
    const setupTimer = setTimeout(() => stop("Voice service setup timed out. Please try again.", 1011), 45_000);
    const heartbeat = setInterval(() => {
      if (!alive) { stop("Connection lost.", 1001); return; }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15_000);
    function stop(message, code = 1000) {
      if (ended) return;
      if (message) transmit({ type: "ended", message });
      ended = true;
      abort.abort();
      clearTimeout(capTimer); clearTimeout(setupTimer); clearInterval(heartbeat);
      ws.close(code, "Session ended");
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref();
      ws.once("close", () => clearTimeout(timer));
      void connection?.dispose().catch(() => {});
    }
    slot.stop = () => stop("Server is restarting.", 1001);
    function queue(action, size = 0) {
      if (++queuedMessages > 120 || (queuedBytes += size) > 96_000) {
        stop("Input queue limit reached.", 1008); return;
      }
      sends = sends.then(async () => { if (!ended) await action(); })
        .catch(() => { report("The voice service connection failed."); stop(undefined, 1011); })
        .finally(() => { queuedMessages--; queuedBytes -= size; });
    }
    function interrupt(manual = false) {
      if (!audioItem && !activeResponse) return;
      pendingPlayed = new Map([...emittedItems].map(([key, item]) => [key, { ...item }]));
      droppedResponses.add(activeResponse || audioItem?.responseId);
      if (droppedResponses.size > 32) droppedResponses.delete(droppedResponses.values().next().value);
      audioItem = undefined;
      transmit({ type: "interrupted" });
      if (manual && activeResponse) {
        // Native Azure-voice responses may have outward IDs that cannot be
        // used for cancellation. Cancel the active response without an ID.
        queue(() => connection.cancelResponse());
      }
    }
    ws.on("pong", () => { alive = true; });
    ws.on("error", () => stop(undefined, 1011));
    ws.on("close", () => stop());
    ws.on("message", (data, binary) => {
      try {
        if (ended) return;
        if (!limiter.allow(data.length)) throw new Error("Input rate exceeded.");
        if (binary) {
          if (!ready || !data.length || data.length % 2 || data.length > MAX_PCM_BYTES) throw new Error("Invalid PCM input.");
          queue(() => connection.sendAudio(data), data.length);
          return;
        }
        const msg = parseControl(data);
        if (msg.type === "end") { stop(); return; }
        if (!ready) throw new Error("Not ready.");
        if (msg.type === "interrupt") {
          if (Date.now() - lastInterrupt < 500) throw new Error("Interrupt rate exceeded.");
          lastInterrupt = Date.now();
          interrupt(true);
        } else if (msg.type === "played") {
          const item = pendingPlayed?.get(`${msg.itemId}:${msg.contentIndex}`);
          if (!item || item.itemId !== msg.itemId || item.contentIndex !== msg.contentIndex ||
              msg.audioEndMs > Math.ceil(item.bytes / 48)) throw new Error("Invalid playback acknowledgement.");
          pendingPlayed = undefined;
          // Startup greeting audio is not a persisted conversation item in
          // the native service, so attempting to truncate it is rejected.
          if (item.truncatable) queue(() => connection.sendEvent({ type: "conversation.item.truncate",
            item_id: item.itemId, content_index: item.contentIndex, audio_end_ms: msg.audioEndMs }));
        }
      } catch { report("Invalid or excessive input. Session ended."); stop(undefined, 1008); }
    });
    void (async () => {
      try {
        connection = await native.connect(abort.signal);
        greetingPending = Boolean(native.hasStartupGreeting);
        if (ended) return;
        for await (const event of connection) {
          if (ended) break;
          switch (event.type) {
            case "session.updated":
              if (!ready) {
                ready = true; clearTimeout(setupTimer);
                transmit({ type: "ready", sampleRate: 24000, expiresAt });
              }
              break;
            case "input_audio_buffer.speech_started":
              interrupt(); transmit({ type: "state", state: "Listening" }); break;
            case "input_audio_buffer.speech_stopped":
              transmit({ type: "state", state: "Thinking" }); break;
            case "response.created":
              activeResponse = event.response.id;
              if (greetingPending) { greetingResponse = event.response.id; greetingPending = false; }
              break;
            case "response.output_audio.delta": {
              if (droppedResponses.has(event.response_id)) break;
              const bytes = Buffer.from(event.delta);
              if (bytes.length % 2 || bytes.length > MAX_UPSTREAM_BYTES) throw new Error("Invalid upstream audio.");
              if (audioItem?.itemId !== event.item_id || audioItem?.contentIndex !== event.content_index) {
                audioItem = { itemId: event.item_id, contentIndex: event.content_index,
                  responseId: event.response_id, bytes: 0, truncatable: event.response_id !== greetingResponse };
              }
              audioItem.bytes += bytes.length;
              emittedItems.set(`${audioItem.itemId}:${audioItem.contentIndex}`, audioItem);
              if (emittedItems.size > 32) emittedItems.delete(emittedItems.keys().next().value);
              transmit({ type: "audio", itemId: event.item_id, contentIndex: event.content_index });
              transmit(bytes);
              break;
            }
            case "response.output_audio_transcript.delta":
            case "response.output_text.delta":
              if (!droppedResponses.has(event.response_id)) transmit({ type: "transcript", role: "agent",
                itemId: event.item_id, channel: event.type.includes("audio") ? "audio" : "text", delta: event.delta });
              break;
            case "response.output_audio_transcript.done":
            case "response.output_text.done":
              if (!droppedResponses.has(event.response_id)) transmit({ type: "transcript", role: "agent",
                itemId: event.item_id, channel: event.type.includes("audio") ? "audio" : "text",
                text: event.transcript ?? event.text, done: true });
              break;
            case "conversation.item.input_audio_transcription.delta":
              transmit({ type: "transcript", role: "user", itemId: event.item_id, delta: event.delta }); break;
            case "conversation.item.input_audio_transcription.completed":
              transmit({ type: "transcript", role: "user", itemId: event.item_id, text: event.transcript, done: true }); break;
            case "conversation.item.input_audio_transcription.failed":
              transmit({ type: "notice", message: "Speech could not be transcribed. Please try speaking again." }); break;
            case "response.done":
              if (event.response.id === activeResponse) activeResponse = undefined;
              if (event.response.status === "failed") throw new Error("Upstream response failed.");
              transmit({ type: "state", state: "Listening" }); break;
            case "error":
              if (event.error?.code === "response_cancel_not_active") break;
              throw new Error("Native voice service reported an error.");
          }
        }
        if (!ended) stop("The voice service ended the connection.", 1000);
      } catch {
        if (!ended) { report("Unable to connect to the voice agent. Please try again later."); stop(undefined, 1011); }
        console.warn("Voice session failed (details withheld; no tokens, audio or transcripts logged).");
      } finally {
        stop();
        try { await connection?.dispose(); } catch {}
        sessions.delete(slot);
      }
    })();
  }

  return { server, sessions, async close() {
    shuttingDown = true;
    for (const session of sessions) session.stop();
    await new Promise((resolve) => server.close(resolve));
    wss.close();
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = loadConfig();
    const app = await createApp(config);
    app.server.listen(config.port, "0.0.0.0", () => console.log(`Foundry voice app listening on ${config.port}`));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
      void app.close();
      const timer = setTimeout(() => process.exit(0), 5000);
      timer.unref();
    });
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

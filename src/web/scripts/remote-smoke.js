import { fileURLToPath } from "node:url";
import WebSocket from "ws";

export async function smokeRemote(originValue, timeoutMs = 60_000) {
  const origin = new URL(originValue || "");
  if (origin.href !== `${origin.origin}/` || origin.username || origin.password ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Supply one HTTPS app origin; HTTP localhost is allowed.");
  }
  const health = await fetch(new URL("/healthz", origin), {
    signal: AbortSignal.timeout(10_000), redirect: "error"
  });
  if (!health.ok || (await health.json()).status !== "ok") throw new Error("Health check failed.");
  const url = new URL("/api/voice", origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Origin: origin.origin, "Sec-Fetch-Site": "same-origin" },
      handshakeTimeout: 10_000, maxPayload: 262144, perMessageDeflate: false,
      followRedirects: false
    });
    let ready = false, finished = false;
    const timer = setTimeout(() => finish(new Error("Session readiness/closure timed out.")), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(error);
      else resolve();
    }
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(new Error(`Upgrade rejected: HTTP ${response.statusCode} (check origin, ingress, capacity or rate limit).`));
    });
    ws.on("error", () => finish(new Error("Remote WebSocket connection failed.")));
    ws.on("message", (data, binary) => {
      // Ignore startup greeting PCM; this test uses no audio device, stores
      // no transcript/recording and sends no speech or arbitrary protocol event.
      if (binary) return;
      try {
        const event = JSON.parse(data.toString());
        if (event.type === "error") throw new Error("Remote voice session reported an error.");
        if (event.type === "ready") {
          const remaining = event.expiresAt - Date.now();
          if (ready || event.sampleRate !== 24000 || !Number.isFinite(remaining) ||
              remaining <= 0 || remaining > 305_000) throw new Error("Invalid session readiness/limit.");
          ready = true;
          ws.send('{"type":"end"}');
        }
      } catch (error) { finish(error); }
    });
    ws.on("close", (code) => {
      if (!ready || code !== 1000) finish(new Error(`Remote session closed before successful readiness/end (code ${code}).`));
      else finish();
    });
  });
  return { health: 200, ready: true, sampleRate: 24000, cleanClose: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await smokeRemote(process.argv[2] || process.env.PUBLIC_ORIGIN);
    console.log(`Remote native voice session PASS: health=${result.health}, ready, PCM=${result.sampleRate}Hz, clean end. No client Azure credentials or audio device used.`);
  } catch (error) {
    console.error(`Remote native voice session FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

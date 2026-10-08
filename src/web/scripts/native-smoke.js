import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { createNative } from "../native.js";

const config = loadConfig();
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 90_000);
let connection;
let audioBytes = 0, transcripts = 0, ready = false, inputSent = false, completed = false;
const pcmPath = process.argv[2];
let sender = Promise.resolve();
try {
  const pcm = pcmPath ? await readFile(pcmPath) : undefined;
  if (pcm && (!pcm.length || pcm.length % 2 || pcm.length > 48_000 * 30)) {
    throw new Error("Input must be PCM16 little-endian, mono, 24kHz, at most 30 seconds.");
  }
  const native = createNative(config);
  const definition = await native.definition(abort.signal);
  const hasGreeting = definition.greeting !== undefined && definition.greeting !== null;
  connection = await native.connect(abort.signal);
  async function startInput() {
    inputSent = true;
    if (!pcm) { await connection.sendText("In one short sentence, say hello."); return; }
    sender = (async () => {
      for (let i = 0; i < pcm.length && !abort.signal.aborted; i += 4800) {
        const chunk = pcm.subarray(i, i + 4800);
        await connection.sendAudio(chunk);
        await delay(chunk.length / 48, undefined, { signal: abort.signal });
      }
      for (let i = 0; i < 10 && !abort.signal.aborted; i++) {
        await connection.sendAudio(new Uint8Array(4800));
        await delay(100, undefined, { signal: abort.signal });
      }
    })();
    sender.catch(() => abort.abort());
  }
  for await (const event of connection) {
    if (event.type === "session.updated" && !ready) {
      ready = true;
      if (!hasGreeting) await startInput();
    } else if (event.type === "response.output_audio.delta" && inputSent) {
      audioBytes += event.delta.byteLength;
    } else if (event.type === "response.output_audio_transcript.done" && inputSent) {
      transcripts++;
    } else if (event.type === "response.done") {
      if (!inputSent) await startInput();
      else if (event.response.status === "completed" && audioBytes > 0) {
        completed = true; break;
      } else if (event.response.status === "failed") throw new Error("Native response failed.");
    } else if (event.type === "error") {
      const detail = String(event.error.message || "").slice(0, 1000)
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/https?:\/\/\S+/gi, "[URL]");
      throw new Error(`Native service ${event.error.code || "error"}: ${detail}`);
    }
  }
  if (!ready || !completed || !audioBytes || !transcripts) throw new Error("Incomplete native voice response.");
  console.log(`Native voice PASS: agent=${config.agent}, version=${config.version}, PCM16/mono/24000Hz, audio=${audioBytes} bytes, transcript=${transcripts}, input=${pcm ? "PCM audio" : "typed voice turn"}.`);
} catch (error) {
  console.error(`Native voice FAIL: ${error.name}: ${error.message}`);
  // SDK errors can contain upstream request URLs; never print token-bearing
  // headers or response bodies. The cause type is useful without those details.
  if (error.cause) console.error(`Cause type: ${error.cause.name || "unknown"}`);
  process.exitCode = 1;
} finally {
  abort.abort();
  await sender.catch(() => {});
  await connection?.dispose().catch(() => {});
  clearTimeout(timeout);
}

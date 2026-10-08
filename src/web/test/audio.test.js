import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { sessionConfig } from "../native.js";

const code = await readFile(new URL("../public/pcm-worklet.js", import.meta.url), "utf8");
function worklet(rate) {
  let Processor;
  const messages = [];
  const context = vm.createContext({
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data) => messages.push(data) }; } },
    sampleRate: rate, registerProcessor: (_name, ctor) => { Processor = ctor; }
  });
  vm.runInContext(code, context);
  const processor = new Processor();
  const send = (data) => processor.port.onmessage({ data });
  const process = (mic = new Float32Array(128)) => {
    const output = new Float32Array(128);
    processor.process([[mic]], [[output]]);
    return output;
  };
  return { processor, send, process, messages };
}
for (const rate of [24000, 44100, 48000]) {
  test(`microphone ${rate}Hz resamples to little-endian mono 24kHz PCM16`, () => {
    const { send, process, messages } = worklet(rate);
    send({ type: "capture", enabled: true });
    const mic = new Float32Array(128).fill(0.5);
    const frames = Math.ceil(rate / 128);
    for (let i = 0; i < frames; i++) process(mic);
    const pcm = messages.filter((m) => m.type === "pcm");
    assert.equal(pcm.length, 10);
    assert.equal(pcm[0].buffer.byteLength, 4800);
    assert.equal(new DataView(pcm[0].buffer).getInt16(0, true), 16384);
  });
}
test("playback emits audible PCM and interruption clears queued output with played position", () => {
  const { send, process, messages } = worklet(24000);
  const buffer = new ArrayBuffer(4800);
  const view = new DataView(buffer);
  for (let i = 0; i < 2400; i++) view.setInt16(i * 2, 8192, true);
  send({ type: "audio", buffer, itemId: "item1", contentIndex: 0 });
  const output = process();
  assert.ok(output.every((value) => Math.abs(value - 0.25) < 0.001));
  send({ type: "clear" });
  const clear = messages.find((m) => m.type === "cleared");
  assert.equal(clear.itemId, "item1");
  assert.ok(clear.audioEndMs >= 5 && clear.audioEndMs <= 6);
  assert.ok(process().every((value) => value === 0));
});
test("playback buffer is bounded to twenty seconds", () => {
  const { send, messages } = worklet(24000);
  send({ type: "audio", buffer: new ArrayBuffer(24000 * 21 * 2), itemId: "item1", contentIndex: 0 });
  assert.ok(messages.some((m) => m.type === "error"));
});
test("session config preserves Azure voice provider, VAD type and transcription", () => {
  const agent = { audio: { input: { turn_detection: { type: "azure_semantic_vad", auto_truncate: true },
    transcription: { model: "azure-speech" } },
  output: { voice: "en-US-Ava:DragonHDLatestNeural", voice_type: "azure-standard" } } };
  const config = sessionConfig(agent);
  assert.equal(config.audio.output.voice_type, "azure-standard");
  assert.equal(config.audio.output.voice, agent.audio.output.voice);
  assert.equal(config.audio.input.turn_detection.type, "azure_semantic_vad");
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.deepEqual(config.audio.input.transcription, agent.audio.input.transcription);
  assert.equal(config.audio.output.format.rate, 24000);
  assert.ok(!("instructions" in config));
});

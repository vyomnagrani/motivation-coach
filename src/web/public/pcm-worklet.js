class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = new Float32Array(0);
    this.position = 0;
    this.capture = new Int16Array(2400);
    this.captureOffset = 0;
    this.enabled = false;
    this.queue = [];
    this.queuedSamples = 0;
    this.current = null;
    this.outputPhase = 0;
    this.a = 0;
    this.b = 0;
    this.playing = false;
    this.exhausted = false;
    this.played = 0;
    this.lastMeta = null;
    this.meterCounter = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "capture") this.enabled = data.enabled;
      if (data.type === "audio") {
        const view = new DataView(data.buffer);
        const samples = new Float32Array(view.byteLength / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        if (this.queuedSamples + samples.length > 24000 * 20) {
          this.port.postMessage({ type: "error", message: "Playback queue overflow. Please reconnect." }); return;
        }
        this.queue.push({ samples, offset: 0, itemId: data.itemId, contentIndex: data.contentIndex });
        this.queuedSamples += samples.length;
      }
      if (data.type === "clear") {
        const meta = this.lastMeta || this.current || this.queue[0];
        this.port.postMessage({ type: "cleared", itemId: meta?.itemId,
          contentIndex: meta?.contentIndex, audioEndMs: Math.floor(this.played / 24) });
        this.queue = [];
        this.queuedSamples = 0;
        this.current = null;
        this.lastMeta = null;
        this.playing = false;
        this.exhausted = false;
        this.played = 0;
        this.outputPhase = 0;
        this.a = this.b = 0;
      }
    };
  }
  nextSample() {
    if (!this.current || this.current.offset >= this.current.samples.length) this.current = this.queue.shift() || null;
    if (!this.current) return null;
    if (this.lastMeta?.itemId !== this.current.itemId || this.lastMeta?.contentIndex !== this.current.contentIndex) {
      this.lastMeta = { itemId: this.current.itemId, contentIndex: this.current.contentIndex };
      this.played = 0;
    }
    this.queuedSamples--;
    this.played++;
    return this.current.samples[this.current.offset++];
  }
  process(inputs, outputs) {
    const mic = inputs[0]?.[0];
    if (mic && this.enabled) {
      const merged = new Float32Array(this.input.length + mic.length);
      merged.set(this.input); merged.set(mic, this.input.length);
      const ratio = sampleRate / 24000;
      while (this.position + 1 < merged.length) {
        const i = Math.floor(this.position);
        const f = this.position - i;
        const value = Math.max(-1, Math.min(1, merged[i] * (1 - f) + merged[i + 1] * f));
        this.capture[this.captureOffset++] = Math.round(value < 0 ? value * 32768 : value * 32767);
        this.position += ratio;
        if (this.captureOffset === this.capture.length) {
          const buffer = new ArrayBuffer(this.capture.length * 2);
          const view = new DataView(buffer);
          for (let n = 0; n < this.capture.length; n++) view.setInt16(n * 2, this.capture[n], true);
          this.port.postMessage({ type: "pcm", buffer }, [buffer]);
          this.captureOffset = 0;
        }
      }
      const consumed = Math.min(Math.floor(this.position), merged.length);
      this.input = merged.slice(consumed);
      this.position -= consumed;
      if (++this.meterCounter % 20 === 0) {
        let energy = 0;
        for (const value of mic) energy += value * value;
        this.port.postMessage({ type: "level", value: Math.min(1, Math.sqrt(energy / mic.length) * 4) });
      }
    }
    const output = outputs[0]?.[0];
    if (output) {
      for (let i = 0; i < output.length; i++) {
        if (!this.playing) {
          const a = this.nextSample();
          if (a === null) { output[i] = 0; continue; }
          this.a = a;
          this.b = this.nextSample() ?? a;
          this.playing = true;
          this.exhausted = false;
          this.outputPhase = 0;
        }
        output[i] = this.a + (this.b - this.a) * this.outputPhase;
        this.outputPhase += 24000 / sampleRate;
        while (this.outputPhase >= 1) {
          this.outputPhase--;
          if (this.exhausted) { this.playing = false; break; }
          this.a = this.b;
          const next = this.nextSample();
          if (next === null) { this.exhausted = true; this.b = this.a; break; }
          this.b = next;
        }
      }
      for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(output);
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);

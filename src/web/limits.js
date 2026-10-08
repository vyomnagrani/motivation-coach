export const SESSION_MS = 5 * 60_000;
export const MAX_SESSIONS = 3;
export const MAX_PCM_BYTES = 9600;
export const MAX_UPSTREAM_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 1024 * 1024;

export class StartLimiter {
  constructor() { this.clients = new Map(); }
  allow(ip, now = Date.now()) {
    for (const [key, value] of this.clients) {
      if (now - value.last >= 3_600_000) this.clients.delete(key);
    }
    let record = this.clients.get(ip);
    if (!record) {
      if (this.clients.size >= 10_000) return false;
      record = { last: now, times: [] };
      this.clients.set(ip, record);
    }
    record.times = record.times.filter((time) => now - time < 3_600_000);
    if (record.times.length >= 10 || record.times.filter((time) => now - time < 60_000).length >= 3) return false;
    record.times.push(now);
    record.last = now;
    return true;
  }
}

export class StreamLimiter {
  constructor(now = Date.now()) { this.time = now; this.messages = 120; this.bytes = 96_000; }
  allow(size, now = Date.now()) {
    const elapsed = Math.max(0, now - this.time) / 1000;
    this.time = now;
    this.messages = Math.min(120, this.messages + elapsed * 60);
    this.bytes = Math.min(96_000, this.bytes + elapsed * 60_000);
    if (this.messages < 1 || this.bytes < size) return false;
    this.messages--;
    this.bytes -= size;
    return true;
  }
}

export function parseControl(data) {
  if (data.length > 512) throw new Error("Control too large.");
  const msg = JSON.parse(data.toString());
  if (!msg || Array.isArray(msg) || typeof msg !== "object") throw new Error("Invalid control.");
  const keys = Object.keys(msg).sort().join(",");
  if (msg.type === "end" && keys === "type") return msg;
  if (msg.type === "interrupt" && keys === "type") return msg;
  if (msg.type === "played" && keys === "audioEndMs,contentIndex,itemId,type" &&
      typeof msg.itemId === "string" && /^[\w-]{1,128}$/.test(msg.itemId) &&
      Number.isInteger(msg.contentIndex) && msg.contentIndex >= 0 && msg.contentIndex < 32 &&
      Number.isInteger(msg.audioEndMs) && msg.audioEndMs >= 0 && msg.audioEndMs <= SESSION_MS) return msg;
  throw new Error("Unsupported control.");
}

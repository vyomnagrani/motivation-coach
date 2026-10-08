import { loadPageContent } from "./content-view.js";

void loadPageContent(document);

const $ = (id) => document.getElementById(id);
const start = $("start"), end = $("end"), interrupt = $("interrupt");
let current = null;
const turns = new Map();

function state(text, hint) {
  $("status").textContent = text;
  if (hint) $("hint").textContent = hint;
}
function showError(message) { $("error").textContent = message; $("error").hidden = false; }
function send(session, message) {
  if (!session.closed && session.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(message));
}
function finish(session, message = "Conversation ended") {
  if (session.closed) return;
  session.closed = true;
  clearInterval(session.clock);
  clearTimeout(session.timeout);
  session.stream?.getTracks().forEach((track) => track.stop());
  session.source?.disconnect();
  session.worklet?.disconnect();
  void session.context?.close().catch(() => {});
  session.ws?.close(1000, "Session ended");
  if (current === session) {
    current = null;
    start.disabled = false; end.disabled = true; interrupt.disabled = true;
    $("level").value = 0; $("orb").classList.remove("active");
    state(message, "Start another conversation whenever you're ready.");
    $("clock").textContent = "05:00 max";
  }
}
function transcript(msg) {
  if (typeof msg.itemId !== "string") return;
  $("empty").hidden = true;
  let turn = turns.get(msg.itemId);
  if (!turn) {
    const article = document.createElement("article");
    article.className = `turn ${msg.role === "user" ? "user" : "agent"}`;
    const label = document.createElement("h3");
    label.textContent = msg.role === "user" ? "You" : "Assistant";
    const text = document.createElement("p");
    article.append(label, text); $("transcript").append(article);
    turn = { article, text, value: "", channel: msg.channel };
    turns.set(msg.itemId, turn);
    if (turns.size > 100) {
      const oldest = turns.keys().next().value;
      turns.get(oldest).article.remove(); turns.delete(oldest);
    }
  }
  // Some agents emit both text and audio transcripts for the same item.
  if (turn.channel === "audio" && msg.channel === "text") return;
  if (turn.channel === "text" && msg.channel === "audio") turn.value = "";
  if (msg.channel) turn.channel = msg.channel;
  turn.value = (typeof msg.text === "string" ? msg.text : turn.value + (msg.delta || "")).slice(0, 16000);
  turn.text.textContent = turn.value || "…";
  const log = $("transcript");
  log.scrollTop = log.scrollHeight;
}

start.addEventListener("click", async () => {
  if (current) return;
  $("error").hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    showError("Microphone streaming needs a modern browser over HTTPS (or localhost)."); return;
  }
  const session = current = { closed: false };
  start.disabled = true; end.disabled = false;
  turns.clear(); $("transcript").replaceChildren(); $("empty").hidden = false;
  state("Opening microphone…", "Allow microphone access to begin.");
  try {
    session.context = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
    await session.context.resume();
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
    });
    if (session.closed) { session.stream.getTracks().forEach((track) => track.stop()); return; }
    await session.context.audioWorklet.addModule("/pcm-worklet.js");
    if (session.closed) return;
    session.worklet = new AudioWorkletNode(session.context, "pcm-processor", { outputChannelCount: [1] });
    session.source = session.context.createMediaStreamSource(session.stream);
    session.source.connect(session.worklet); session.worklet.connect(session.context.destination);
    const ws = session.ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/voice`);
    ws.binaryType = "arraybuffer";
    session.timeout = setTimeout(() => {
      showError("Connection timed out. Check microphone permission and try again."); finish(session);
    }, 50_000);
    state("Connecting…", "Opening a secure native Foundry voice session.");
    session.worklet.port.onmessage = ({ data }) => {
      if (session.closed) return;
      if (data.type === "pcm" && session.ready && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 96_000) {
          showError("Your connection is too slow to stream audio."); finish(session); return;
        }
        ws.send(data.buffer);
      } else if (data.type === "level") $("level").value = data.value;
      else if (data.type === "cleared" && data.itemId) send(session, { type: "played",
        itemId: data.itemId, contentIndex: data.contentIndex, audioEndMs: data.audioEndMs });
      else if (data.type === "error") { showError(data.message); finish(session); }
    };
    ws.onmessage = ({ data }) => {
      if (session.closed) return;
      try {
        if (data instanceof ArrayBuffer) {
          if (!session.audioMeta || data.byteLength % 2 || data.byteLength > 262144) throw new Error("Invalid audio.");
          session.worklet.port.postMessage({ type: "audio", ...session.audioMeta, buffer: data }, [data]);
          session.audioMeta = null;
          state("Assistant speaking", "You can speak at any time to interrupt.");
          return;
        }
        const msg = JSON.parse(data);
        switch (msg.type) {
          case "ready":
            clearTimeout(session.timeout);
            session.ready = true;
            session.worklet.port.postMessage({ type: "capture", enabled: true });
            interrupt.disabled = false; $("orb").classList.add("active");
            state("Listening", "Say hello. Natural pauses end your turn.");
            session.clock = setInterval(() => {
              const remaining = Math.max(0, Math.ceil((msg.expiresAt - Date.now()) / 1000));
              $("clock").textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left`;
              if (!remaining) { send(session, { type: "end" }); finish(session, "Session limit reached"); }
            }, 1000);
            break;
          case "audio": session.audioMeta = { itemId: msg.itemId, contentIndex: msg.contentIndex }; break;
          case "interrupted":
            session.worklet.port.postMessage({ type: "clear" });
            state("Listening", "Go ahead — the assistant has stopped."); break;
          case "transcript": transcript(msg); break;
          case "state": state(msg.state); break;
          case "notice": showError(msg.message); break;
          case "error": showError(msg.message); finish(session, "Connection unavailable"); break;
          case "ended": finish(session, msg.message); break;
        }
      } catch { showError("Unexpected voice service message. Please reconnect."); finish(session); }
    };
    ws.onerror = () => {
      showError("Could not open the voice session. It may be busy, rate-limited, or unavailable. Wait a minute and try again.");
      finish(session, "Connection unavailable");
    };
    ws.onclose = (event) => {
      if (session.closed) return;
      if (event.code !== 1000) showError("Connection interrupted. Start a new conversation to reconnect.");
      finish(session);
    };
    session.stream.getAudioTracks()[0].addEventListener("ended", () => {
      if (!session.closed) { showError("The microphone was disconnected."); finish(session); }
    });
  } catch (error) {
    if (!session.closed) {
      showError(error.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in browser settings and try again." :
        "Could not start audio. Check your microphone, browser audio settings and device.");
      finish(session, "Audio unavailable");
    }
  }
});
end.addEventListener("click", () => {
  if (current) { send(current, { type: "end" }); finish(current); }
});
interrupt.addEventListener("click", () => {
  if (current) send(current, { type: "interrupt" });
});
window.addEventListener("pagehide", () => { if (current) finish(current); });

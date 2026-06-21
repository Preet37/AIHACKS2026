/**
 * Offscreen document — Chrome MV3 USER_MEDIA context.
 *
 * Lives in a hidden offscreen document that Chrome grants full getUserMedia
 * access to (resolves the macOS "Permission dismissed" error that extension
 * side-panel pages hit). Background creates this document on first VOICE_START,
 * then forwards VOICE_START / VOICE_STOP to it.
 */

const VOICE_BAR_COUNT = 20;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let amplitudeTimer: ReturnType<typeof setInterval> | null = null;

function bestMimeType(): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

function startAmplitudeReporting() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  amplitudeTimer = setInterval(() => {
    if (!analyser) return;
    analyser.getByteFrequencyData(buf);
    const usable = Math.floor(buf.length * 0.5);
    const step = Math.max(1, Math.floor(usable / VOICE_BAR_COUNT));
    const bars = Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += buf[i * step + j] ?? 0;
      return Math.min(1, (sum / step / 255) * 2.5);
    });
    chrome.runtime.sendMessage({ type: "VOICE_AMPLITUDE", bars }).catch(() => {});
  }, 50);
}

function stopAmplitudeReporting() {
  if (amplitudeTimer !== null) {
    clearInterval(amplitudeTimer);
    amplitudeTimer = null;
  }
}

function cleanup() {
  stopAmplitudeReporting();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  analyser = null;
  recorder = null;
  chunks = [];
}

chrome.runtime.onMessage.addListener(
  (msg: { target?: string; type: string; backendUrl?: string }, _sender, sendResponse) => {
    if (msg.target !== "offscreen-voice") return false;

    if (msg.type === "VOICE_START") {
      (async () => {
        try {
          cleanup();
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

          audioCtx = new AudioContext();
          if (audioCtx.state === "suspended") await audioCtx.resume();
          const source = audioCtx.createMediaStreamSource(stream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.7;
          source.connect(analyser);

          const mimeType = bestMimeType();
          recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          chunks = [];
          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.start(100);
          startAmplitudeReporting();
          sendResponse({ ok: true });
        } catch (err) {
          cleanup();
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    if (msg.type === "VOICE_STOP") {
      stopAmplitudeReporting();
      const rec = recorder;
      if (!rec || rec.state === "inactive") {
        cleanup();
        sendResponse({ ok: false, error: "Not recording" });
        return true;
      }
      (async () => {
        try {
          await new Promise<void>((resolve) => {
            rec.onstop = () => resolve();
            rec.requestData();
            rec.stop();
          });
          const mimeType = rec.mimeType || "audio/webm";
          const capturedChunks = [...chunks];
          cleanup();

          if (capturedChunks.length === 0) {
            sendResponse({ ok: false, error: "No audio captured — check mic access" });
            return;
          }

          const blob = new Blob(capturedChunks, { type: mimeType });
          if (blob.size < 200) {
            sendResponse({ ok: false, error: "Recording too short — speak closer to your mic" });
            return;
          }

          const backendUrl = msg.backendUrl || "http://localhost:8000";
          console.log(`[offscreen] POST ${blob.size} bytes → ${backendUrl}/voice/transcribe`);
          const response = await fetch(`${backendUrl}/voice/transcribe`, {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: blob,
          });

          if (!response.ok) {
            const body = await response.json().catch(() => null) as { detail?: string } | null;
            throw new Error(body?.detail ?? `HTTP ${response.status}`);
          }

          const data = await response.json() as { transcript: string };
          console.log("[offscreen] transcript:", data.transcript);
          sendResponse({ ok: true, transcript: data.transcript });
        } catch (err) {
          cleanup();
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    return false;
  }
);

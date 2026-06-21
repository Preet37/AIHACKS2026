/**
 * Wispr-style voice loop.
 *
 * Hold Alt/Option  → PTT: records while held, sends on release.
 * Double-tap Alt   → lock mode: tap Alt once more to stop + send.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CONJURE_CONFIG } from "../shared/config";

export type VoiceState = "idle" | "listening" | "locked" | "transcribing" | "speaking";
export const VOICE_BAR_COUNT = 20;

export interface UseVoiceOptions {
  onTranscript: (text: string) => void;
}

export interface UseVoiceReturn {
  voiceState: VoiceState;
  voiceError: string | null;
  barAmplitudes: number[];
  permissionState: PermissionState | null;
  requestPermission: () => Promise<void>;
  speakText: (text: string) => Promise<void>;
}

function bestMimeType(): string {
  for (const mime of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

const DOUBLE_TAP_MS = 350;

export function useVoice({ onTranscript }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [barAmplitudes, setBarAmplitudes] = useState<number[]>(() =>
    Array(VOICE_BAR_COUNT).fill(0)
  );
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const isHoldingRef = useRef(false);
  const isLockedRef = useRef(false);
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReleaseRef = useRef(false);

  // ── Amplitude loop ────────────────────────────────────────────────────────

  const startAmplitudeLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const usable = Math.floor(buf.length * 0.5);
      const step = Math.max(1, Math.floor(usable / VOICE_BAR_COUNT));
      const vals = Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += buf[i * step + j];
        return Math.min(1, (sum / step / 255) * 2.5);
      });
      setBarAmplitudes(vals);
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const stopAmplitudeLoop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setBarAmplitudes(Array(VOICE_BAR_COUNT).fill(0));
  }, []);

  // ── Stream helpers ────────────────────────────────────────────────────────

  const stopStream = useCallback(() => {
    stopAmplitudeLoop();
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, [stopAmplitudeLoop]);

  // ── Open mic ──────────────────────────────────────────────────────────────

  const openMic = useCallback(async (): Promise<boolean> => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      setPermissionState("granted");

      // AudioContext may be suspended in extension context — resume it
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const mimeType = bestMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => console.error("[voice] recorder error", e);
      recorder.start(100);
      recorderRef.current = recorder;
      startAmplitudeLoop();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[voice] openMic failed:", msg);
      if (msg.includes("Permission denied") || msg.includes("NotAllowed") || msg.includes("NotFoundError")) {
        setVoiceError("blocked");
        setPermissionState("denied");
      } else {
        setVoiceError(msg);
      }
      stopStream();
      return false;
    }
  }, [startAmplitudeLoop, stopStream]);

  // ── Close mic + transcribe ────────────────────────────────────────────────

  const closeMicAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    stopAmplitudeLoop();

    if (!recorder || recorder.state === "inactive") {
      console.warn("[voice] recorder not active, aborting transcription");
      stopStream();
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");

    // Flush remaining audio and wait for onstop
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.requestData(); // flush any buffered chunk
      recorder.stop();
    });

    const mimeType = recorder.mimeType || "audio/webm";
    const chunks = chunksRef.current.splice(0);
    stopStream();
    recorderRef.current = null;

    if (chunks.length === 0) {
      console.warn("[voice] no audio chunks captured — mic may not be working");
      setVoiceError("No audio captured. Check mic permissions and try again.");
      setVoiceState("idle");
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    console.log(`[voice] sending ${blob.size} bytes (${mimeType}) to backend`);

    if (blob.size < 200) {
      console.warn("[voice] blob too small:", blob.size);
      setVoiceError("Recording too short — speak closer to your mic.");
      setVoiceState("idle");
      return;
    }

    try {
      const url = `${CONJURE_CONFIG.backendUrl}/voice/transcribe`;
      console.log("[voice] POST", url);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: blob,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail ?? `HTTP ${response.status}`);
      }
      const data = await response.json() as { transcript: string };
      console.log("[voice] transcript:", data.transcript);
      if (data.transcript.trim()) {
        onTranscript(data.transcript.trim());
      } else {
        setVoiceError("Couldn't hear anything — try speaking louder.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[voice] transcription error:", msg);
      setVoiceError(`Transcription failed: ${msg}`);
    } finally {
      setVoiceState("idle");
    }
  }, [onTranscript, stopAmplitudeLoop, stopStream]);

  // ── Request permission (from UI) ──────────────────────────────────────────

  const requestPermission = useCallback(async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionState("granted");
    } catch {
      setVoiceError("blocked");
      setPermissionState("denied");
    }
  }, []);

  // ── TTS ───────────────────────────────────────────────────────────────────

  const speakText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setVoiceState("speaking");
    try {
      const response = await fetch(`${CONJURE_CONFIG.backendUrl}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("TTS failed");
      const audioBlob = await response.blob();
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => resolve();
        void audio.play();
      });
    } catch (err) {
      console.error("[voice] TTS error:", err);
    } finally {
      setVoiceState("idle");
    }
  }, []);

  // ── Keyboard handler (stable — uses refs, no state deps) ──────────────────

  const closeMicRef = useRef(closeMicAndTranscribe);
  const openMicRef = useRef(openMic);
  useEffect(() => { closeMicRef.current = closeMicAndTranscribe; }, [closeMicAndTranscribe]);
  useEffect(() => { openMicRef.current = openMic; }, [openMic]);

  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "Alt" || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();

      // Locked → single tap stops + transcribes
      if (isLockedRef.current) {
        isLockedRef.current = false;
        isHoldingRef.current = false;
        if (pttTimerRef.current) { clearTimeout(pttTimerRef.current); pttTimerRef.current = null; }
        pendingReleaseRef.current = false;
        await closeMicRef.current();
        return;
      }

      // Second tap while PTT-release timer is pending → lock mode
      if (pendingReleaseRef.current && pttTimerRef.current !== null) {
        clearTimeout(pttTimerRef.current);
        pttTimerRef.current = null;
        pendingReleaseRef.current = false;
        isLockedRef.current = true;
        isHoldingRef.current = false;
        setVoiceState("locked");
        return;
      }

      if (isHoldingRef.current) return;
      isHoldingRef.current = true;
      const ok = await openMicRef.current();
      if (ok) setVoiceState("listening");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      if (!isHoldingRef.current || isLockedRef.current) return;
      isHoldingRef.current = false;
      pendingReleaseRef.current = true;

      pttTimerRef.current = setTimeout(async () => {
        pttTimerRef.current = null;
        pendingReleaseRef.current = false;
        if (!isLockedRef.current) {
          await closeMicRef.current();
        }
      }, DOUBLE_TAP_MS);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ── Initial permission check ──────────────────────────────────────────────

  useEffect(() => {
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((r) => {
        setPermissionState(r.state);
        r.onchange = () => setPermissionState(r.state);
      })
      .catch(() => {});
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => () => {
    if (pttTimerRef.current) clearTimeout(pttTimerRef.current);
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
    stopStream();
  }, [stopStream]);

  return { voiceState, voiceError, barAmplitudes, permissionState, requestPermission, speakText };
}

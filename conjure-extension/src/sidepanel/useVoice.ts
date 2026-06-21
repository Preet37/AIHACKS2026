/**
 * Wispr-style voice loop.
 *
 * Hold  Alt/Option  → push-to-talk (PTT): records while held, sends on release.
 * Double-tap Alt    → lock mode: mic stays open; tap Alt once more to stop + send.
 *
 * Exposes per-bar frequency amplitudes (0–1) via a Float32Array so the UI can
 * render a live spectrum waveform without polling.
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
  /** Per-bar frequency magnitudes (0–1), length = VOICE_BAR_COUNT, updates ~60fps while listening/locked */
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

/** ms window for second keydown to count as double-tap */
const DOUBLE_TAP_MS = 350;

export function useVoice({ onTranscript }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [barAmplitudes, setBarAmplitudes] = useState<number[]>(() => Array(VOICE_BAR_COUNT).fill(0));
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const isHoldingRef = useRef(false);
  const isLockedRef = useRef(false);
  /** Timer set on keyup; cancelled if a second keydown arrives quickly (double-tap) */
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while a PTT-release timer is pending so we know the mic is still open */
  const pendingReleaseRef = useRef(false);

  // ── Amplitude / spectrum loop ─────────────────────────────────────────────

  const startAmplitudeLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(buf);
      // Map frequency bins → VOICE_BAR_COUNT bars (emphasise lower-mid for voice)
      const usableBins = Math.floor(buf.length * 0.5); // 0–50% of spectrum covers speech
      const step = Math.max(1, Math.floor(usableBins / VOICE_BAR_COUNT));
      const vals = Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += buf[i * step + j];
        return Math.min(1, (sum / step / 255) * 2.5); // amplify a bit
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermissionState("granted");

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const mimeType = bestMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(100);
      startAmplitudeLoop();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission denied") || msg.includes("NotAllowed")) {
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
    if (!recorder || recorder.state === "inactive") {
      stopStream();
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");
    stopAmplitudeLoop();

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    stopStream();

    if (blob.size < 2000) {
      setVoiceState("idle");
      return;
    }

    try {
      const response = await fetch(`${CONJURE_CONFIG.backendUrl}/voice/transcribe`, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: blob,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail ?? `Transcription failed (${response.status})`);
      }
      const { transcript } = await response.json() as { transcript: string };
      if (transcript.trim()) onTranscript(transcript.trim());
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Transcription error");
    } finally {
      setVoiceState("idle");
    }
  }, [onTranscript, stopAmplitudeLoop, stopStream]);

  // ── Request permission explicitly (from UI button) ───────────────────────

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

  // ── TTS speak-back ────────────────────────────────────────────────────────

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
    } catch {
      // TTS is best-effort; don't surface errors
    } finally {
      setVoiceState("idle");
    }
  }, []);

  // ── Keyboard handlers ─────────────────────────────────────────────────────

  // Use refs for the callbacks so the effect doesn't need to re-register on
  // every voiceState change (avoids stale-closure issues).
  const closeMicRef = useRef(closeMicAndTranscribe);
  const openMicRef = useRef(openMic);
  useEffect(() => { closeMicRef.current = closeMicAndTranscribe; }, [closeMicAndTranscribe]);
  useEffect(() => { openMicRef.current = openMic; }, [openMic]);

  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "Alt" || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();

      // ── If locked → stop and transcribe ──
      if (isLockedRef.current) {
        isLockedRef.current = false;
        isHoldingRef.current = false;
        if (pttTimerRef.current) { clearTimeout(pttTimerRef.current); pttTimerRef.current = null; }
        pendingReleaseRef.current = false;
        await closeMicRef.current();
        return;
      }

      // ── Second tap while PTT-release timer is pending → enter lock mode ──
      if (pendingReleaseRef.current && pttTimerRef.current !== null) {
        clearTimeout(pttTimerRef.current);
        pttTimerRef.current = null;
        pendingReleaseRef.current = false;
        isLockedRef.current = true;
        isHoldingRef.current = false;
        setVoiceState("locked");
        return;
      }

      // ── First tap: start listening ──
      if (isHoldingRef.current) return; // guard against extra events
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

      // Wait briefly: if a second keydown comes before the timer fires it's a double-tap
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
  }, []); // stable — no state deps needed thanks to refs

  // ── Initial permission check ──────────────────────────────────────────────

  useEffect(() => {
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((result) => {
        setPermissionState(result.state);
        result.onchange = () => setPermissionState(result.state);
      })
      .catch(() => {});
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => () => {
    if (pttTimerRef.current) clearTimeout(pttTimerRef.current);
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
    stopStream();
  }, [stopStream]);

  return { voiceState, voiceError, barAmplitudes, permissionState, requestPermission, speakText };
}

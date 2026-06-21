/**
 * Wispr-style voice loop.
 *
 * Hold  Alt/Option  → push-to-talk (PTT): records while held, sends on release.
 * Double-tap Alt    → lock mode: mic stays open; tap Alt once more to stop + send.
 *
 * Exposes amplitude data (0–1) every animation frame so the UI can render
 * a live waveform without polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CONJURE_CONFIG } from "../shared/config";

export type VoiceState = "idle" | "listening" | "locked" | "transcribing" | "speaking";

export interface UseVoiceOptions {
  onTranscript: (text: string) => void;
}

export interface UseVoiceReturn {
  voiceState: VoiceState;
  voiceError: string | null;
  amplitude: number; // 0–1, updates ~60fps while listening/locked
  permissionState: PermissionState | null; // "granted" | "denied" | "prompt"
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

const DOUBLE_TAP_MS = 300; // max gap between two taps to count as double-tap

export function useVoice({ onTranscript }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Key state tracking
  const isHoldingRef = useRef(false);
  const isLockedRef = useRef(false);
  const lastAltUpRef = useRef(0); // timestamp of last Alt keyup for double-tap detection

  // ── Amplitude loop ────────────────────────────────────────────────────────

  const startAmplitudeLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      setAmplitude(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const stopAmplitudeLoop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setAmplitude(0);
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

  // ── Core: open mic ────────────────────────────────────────────────────────

  const openMic = useCallback(async (): Promise<boolean> => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermissionState("granted");

      // Wire up Web Audio analyser for amplitude
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
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
        setVoiceError("Mic blocked. Click the 🔒 icon in Chrome's address bar → Allow microphone.");
        setPermissionState("denied");
      } else {
        setVoiceError(msg);
      }
      stopStream();
      return false;
    }
  }, [startAmplitudeLoop, stopStream]);

  // ── Core: close mic + transcribe ─────────────────────────────────────────

  const closeMicAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      stopStream();
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");

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
      if (transcript.trim()) {
        onTranscript(transcript.trim());
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Transcription error");
    } finally {
      setVoiceState("idle");
    }
  }, [onTranscript, stopStream]);

  // ── Public: request permission explicitly (from UI button) ───────────────

  const requestPermission = useCallback(async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionState("granted");
    } catch {
      setVoiceError("Mic blocked. Click the 🔒 icon in Chrome's address bar → Allow microphone.");
      setPermissionState("denied");
    }
  }, []);

  // ── Public: TTS speak-back ────────────────────────────────────────────────

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
        audio.onerror = () => resolve(); // non-fatal
        void audio.play();
      });
    } catch {
      // TTS is best-effort
    } finally {
      setVoiceState("idle");
    }
  }, []);

  // ── Keyboard handlers ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "Alt" || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();

      // Already in a non-idle, non-listening state — ignore
      if (voiceState === "transcribing" || voiceState === "speaking") return;

      // ── If locked: single Alt press stops and transcribes ──
      if (isLockedRef.current) {
        isLockedRef.current = false;
        isHoldingRef.current = false;
        await closeMicAndTranscribe();
        return;
      }

      // ── Ignore key-repeat ──
      if (e.repeat || isHoldingRef.current) return;

      isHoldingRef.current = true;
      const ok = await openMic();
      if (ok) setVoiceState("listening");
    };

    const onKeyUp = async (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();

      if (!isHoldingRef.current) return;

      const now = Date.now();
      const gap = now - lastAltUpRef.current;
      lastAltUpRef.current = now;

      // ── Double-tap: gap < DOUBLE_TAP_MS → switch to lock mode ──
      if (gap < DOUBLE_TAP_MS && !isLockedRef.current) {
        isLockedRef.current = true;
        isHoldingRef.current = false;
        setVoiceState("locked");
        return; // keep recording
      }

      // ── Single release: PTT → stop ──
      if (!isLockedRef.current) {
        isHoldingRef.current = false;
        await closeMicAndTranscribe();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [voiceState, openMic, closeMicAndTranscribe]);

  // ── Check initial permission state ───────────────────────────────────────

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

  useEffect(
    () => () => {
      try { recorderRef.current?.stop(); } catch { /* ignore */ }
      stopStream();
    },
    [stopStream]
  );

  return { voiceState, voiceError, amplitude, permissionState, requestPermission, speakText };
}

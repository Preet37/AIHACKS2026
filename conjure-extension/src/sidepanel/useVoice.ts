/**
 * Wispr-style voice loop.
 *
 * Hold  Option (Mac) / Alt (Windows)  → mic opens, Deepgram streams STT.
 * Release                              → recording stops, transcript submitted.
 * After the agent replies             → call speakText() to TTS the response.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CONJURE_CONFIG } from "../shared/config";

export type VoiceState = "idle" | "listening" | "transcribing" | "speaking";

interface UseVoiceOptions {
  /** Called with the final transcript so the caller can submit it as a chat message. */
  onTranscript: (text: string) => void;
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

export function useVoice({ onTranscript }: UseVoiceOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // prevent Alt key repeat triggers
  const listeningRef = useRef(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    if (listeningRef.current) return;
    listeningRef.current = true;
    setVoiceError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = bestMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(200);
      setVoiceState("listening");
    } catch (err) {
      listeningRef.current = false;
      setVoiceError(err instanceof Error ? err.message : "Microphone access denied");
      setVoiceState("idle");
    }
  }, []);

  const stopListeningAndTranscribe = useCallback(async () => {
    if (!listeningRef.current) return;
    listeningRef.current = false;

    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    stopStream();

    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];

    // Ignore recordings shorter than ~300 ms of audio data
    if (blob.size < 3000) {
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
        const body = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(body?.detail ?? `Transcription failed (${response.status})`);
      }

      const { transcript } = (await response.json()) as { transcript: string };
      if (transcript.trim()) {
        onTranscript(transcript.trim());
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Transcription error");
    } finally {
      setVoiceState("idle");
    }
  }, [onTranscript, stopStream]);

  /** Speak *text* aloud via Deepgram Aura TTS. Non-fatal — errors are swallowed. */
  const speakText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setVoiceState("speaking");
    try {
      const response = await fetch(`${CONJURE_CONFIG.backendUrl}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("TTS request failed");
      const audioBlob = await response.blob();
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = () => reject(new Error("Audio playback error"));
        void audio.play();
      });
    } catch {
      // TTS is best-effort — never block the UI
    } finally {
      setVoiceState("idle");
    }
  }, []);

  // Global Alt / Option key listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        void startListening();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        e.preventDefault();
        void stopListeningAndTranscribe();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startListening, stopListeningAndTranscribe]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      try {
        recorderRef.current?.stop();
      } catch {
        // ignore
      }
      stopStream();
    },
    [stopStream]
  );

  return { voiceState, voiceError, speakText };
}

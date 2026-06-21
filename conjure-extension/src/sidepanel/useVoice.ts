/**
 * Click-to-record voice — audio is captured inside the active web tab
 * (which already has mic permission) via chrome.scripting.executeScript.
 *
 * Click mic → start.  Click mic again → stop + transcribe → text in input box.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BACKGROUND_MESSAGE } from "../shared/messages";
import { CONJURE_CONFIG } from "../shared/config";

export type VoiceState = "idle" | "recording" | "transcribing" | "speaking";
export const VOICE_BAR_COUNT = 20;

export interface UseVoiceOptions {
  onTranscript: (text: string) => void;
}

export interface UseVoiceReturn {
  voiceState: VoiceState;
  voiceError: string | null;
  barAmplitudes: number[];
  permissionState: PermissionState | null;
  activateMic: () => Promise<void>;
  speakText: (text: string, opts?: { autoListen?: boolean }) => Promise<void>;
}

export function useVoice({ onTranscript }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [barAmplitudes, setBarAmplitudes] = useState<number[]>(() =>
    Array(VOICE_BAR_COUNT).fill(0)
  );
  const [permissionState] = useState<PermissionState | null>(null);

  const isRecordingRef = useRef(false);

  // Stable ref so keyboard handlers don't go stale
  const activateMicRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Amplitude + hotkey relay both handled in the useEffect below

  const activateMic = useCallback(async () => {
    // ── STOP + TRANSCRIBE ────────────────────────────────────────────────────
    if (isRecordingRef.current) {
      isRecordingRef.current = false;
      setVoiceState("transcribing");
      setBarAmplitudes(Array(VOICE_BAR_COUNT).fill(0));

      try {
        const response = (await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE.VOICE_STOP,
          backendUrl: CONJURE_CONFIG.backendUrl,
        })) as { ok: boolean; data?: { transcript: string }; error?: string } | undefined;

        console.log("[voice] stop response:", JSON.stringify(response));

        if (response?.ok) {
          const text = (response.data?.transcript ?? "").trim();
          if (text) {
            onTranscript(text);
            setVoiceError(null);
          } else {
            setVoiceError("Couldn't hear anything — try speaking louder.");
          }
        } else {
          setVoiceError(response?.error ?? "Transcription failed");
        }
      } catch (err) {
        setVoiceError(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setVoiceState("idle");
      }
      return;
    }

    // ── START RECORDING ───────────────────────────────────────────────────────
    setVoiceError(null);
    console.log("[voice] sending VOICE_START to background...");

    try {
      const response = (await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE.VOICE_START,
        backendUrl: CONJURE_CONFIG.backendUrl,
      })) as { ok: boolean; data?: { started: boolean }; error?: string } | undefined;

      console.log("[voice] start response:", JSON.stringify(response));

      if (response?.ok) {
        isRecordingRef.current = true;
        setVoiceState("recording");
      } else {
        setVoiceError(response?.error ?? "Could not start mic");
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Could not start mic");
    }
  }, [onTranscript]);

  // Keep ref current so keyboard handlers always call latest version
  useEffect(() => { activateMicRef.current = activateMic; }, [activateMic]);

  // ── Option / Alt key — push-to-talk ───────────────────────────────────────
  // Press = start recording. Release = stop + transcribe.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || e.repeat || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      if (!isRecordingRef.current) void activateMicRef.current();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      if (isRecordingRef.current) void activateMicRef.current();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // Relay from content script (web page has focus, not the side panel)
  useEffect(() => {
    const onMsg = (msg: { type?: string; event?: string; bars?: number[] }) => {
      if (msg.type === "VOICE_AMPLITUDE" && Array.isArray(msg.bars)) {
        setBarAmplitudes(msg.bars);
        return;
      }
      if (msg.type !== "conjure:voice_hotkey") return;
      if (msg.event === "keydown" && !isRecordingRef.current) {
        void activateMicRef.current();
      } else if (msg.event === "keyup" && isRecordingRef.current) {
        void activateMicRef.current();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // ── TTS ───────────────────────────────────────────────────────────────────
  const speakText = useCallback(async (text: string, opts?: { autoListen?: boolean }) => {
    if (!text.trim()) return;
    setVoiceState("speaking");
    try {
      const res = await fetch(`${CONJURE_CONFIG.backendUrl}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
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
    // If LLM ended with a question, automatically open the mic for the reply
    if (opts?.autoListen && !isRecordingRef.current) {
      await activateMicRef.current();
    }
  }, []);

  return { voiceState, voiceError, barAmplitudes, permissionState, activateMic, speakText };
}

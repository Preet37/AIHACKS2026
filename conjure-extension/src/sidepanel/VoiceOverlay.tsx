import { Loader2, Mic, Volume2 } from "lucide-react";
import type { VoiceState } from "./useVoice";
import { VOICE_BAR_COUNT } from "./useVoice";

interface Props {
  voiceState: VoiceState;
  voiceError: string | null;
  barAmplitudes: number[];
  permissionState: PermissionState | null;
  onActivateMic: () => void;
}

function Waveform({ barAmplitudes }: { barAmplitudes: number[] }) {
  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
        const raw = barAmplitudes[i] ?? 0;
        const minH = 0.06 + Math.sin((i / (VOICE_BAR_COUNT - 1)) * Math.PI) * 0.04;
        const h = Math.max(minH, raw);
        return (
          <span
            key={i}
            className="waveform-bar"
            style={{ height: `${Math.min(100, h * 100).toFixed(1)}%` }}
          />
        );
      })}
    </div>
  );
}

export function VoiceOverlay({ voiceState, voiceError, barAmplitudes }: Props) {
  if (voiceState === "idle" && !voiceError) return null;

  if (voiceState === "idle" && voiceError) {
    return (
      <div className="voice-overlay voice-overlay--error" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="vo-text">
          <strong>Voice error</strong>
          <span>{voiceError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`voice-overlay voice-overlay--${voiceState}`} role="status" aria-live="polite">
      <div className="vo-header">
        <span className="vo-icon-wrap">
          {voiceState === "transcribing" ? (
            <Loader2 className="vo-icon spin" aria-hidden="true" />
          ) : voiceState === "speaking" ? (
            <Volume2 className="vo-icon" aria-hidden="true" />
          ) : (
            <Mic className="vo-icon" aria-hidden="true" />
          )}
        </span>
        <span className="vo-label">
          {voiceState === "recording" && "Listening — click 🎙 to send"}
          {voiceState === "transcribing" && "Transcribing…"}
          {voiceState === "speaking" && "Speaking…"}
        </span>
        {voiceState === "recording" && <span className="vo-badge">REC</span>}
      </div>
      {voiceState === "recording" && <Waveform barAmplitudes={barAmplitudes} />}
    </div>
  );
}

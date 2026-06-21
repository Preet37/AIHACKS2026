/**
 * Wispr-style voice overlay — shown whenever voice is active.
 * Displays a live waveform driven by amplitude data, mode label, and hint text.
 */
import { Loader2, Mic, MicOff, Volume2 } from "lucide-react";
import type { VoiceState } from "./useVoice";

const BAR_COUNT = 20;

interface Props {
  voiceState: VoiceState;
  voiceError: string | null;
  amplitude: number; // 0–1
  permissionState: PermissionState | null;
  onRequestPermission: () => void;
}

function Waveform({ amplitude, active }: { amplitude: number; active: boolean }) {
  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => {
        // Bars in the middle are taller than edges (bell shape)
        const center = (BAR_COUNT - 1) / 2;
        const dist = Math.abs(i - center) / center; // 0 at middle, 1 at edges
        const shape = 1 - dist * 0.6; // middle bars can go up to 100%, edge bars up to 40%
        const base = 0.08;
        const height = active
          ? base + shape * amplitude * 0.92
          : base + Math.sin((i / BAR_COUNT) * Math.PI) * 0.05;
        return (
          <span
            key={i}
            className="waveform-bar"
            style={{ "--bar-h": `${Math.min(1, height) * 100}%` } as React.CSSProperties}
          />
        );
      })}
    </div>
  );
}

export function VoiceOverlay({ voiceState, voiceError, amplitude, permissionState, onRequestPermission }: Props) {
  // Permission denied — show fix guidance
  if (permissionState === "denied" || (voiceError && voiceError.includes("Mic blocked"))) {
    return (
      <div className="voice-overlay voice-overlay--error">
        <MicOff className="vo-icon" aria-hidden="true" />
        <div className="vo-text">
          <strong>Microphone blocked</strong>
          <span>Click the 🔒 in Chrome's address bar → Allow microphone</span>
        </div>
        <button className="vo-fix-btn" onClick={onRequestPermission} type="button">
          Retry
        </button>
      </div>
    );
  }

  if (voiceState === "idle") return null;

  const isRecording = voiceState === "listening" || voiceState === "locked";

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
          {voiceState === "listening" && "Listening"}
          {voiceState === "locked" && "Locked · tap Alt to send"}
          {voiceState === "transcribing" && "Transcribing…"}
          {voiceState === "speaking" && "Speaking…"}
        </span>

        {voiceState === "locked" && (
          <span className="vo-badge">LOCK</span>
        )}
      </div>

      {isRecording && (
        <Waveform amplitude={amplitude} active={isRecording} />
      )}

      {(voiceState === "listening") && (
        <span className="vo-hint">Release Alt to send · double-tap Alt to lock</span>
      )}
    </div>
  );
}

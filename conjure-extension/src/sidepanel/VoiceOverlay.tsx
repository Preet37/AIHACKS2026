import { Loader2, Mic, MicOff, Volume2 } from "lucide-react";
import type { VoiceState } from "./useVoice";
import { VOICE_BAR_COUNT } from "./useVoice";

interface Props {
  voiceState: VoiceState;
  voiceError: string | null;
  barAmplitudes: number[];
  permissionState: PermissionState | null;
  onRequestPermission: () => void;
}

function Waveform({ barAmplitudes, active }: { barAmplitudes: number[]; active: boolean }) {
  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
        const raw = active ? barAmplitudes[i] ?? 0 : 0;
        // Minimum idle height so bars are always visible
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

export function VoiceOverlay({
  voiceState,
  voiceError,
  barAmplitudes,
  permissionState,
  onRequestPermission,
}: Props) {
  // Permission denied
  if (permissionState === "denied" || voiceError === "blocked") {
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
    <div
      className={`voice-overlay voice-overlay--${voiceState}`}
      role="status"
      aria-live="polite"
    >
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

        {voiceState === "locked" && <span className="vo-badge">LOCK</span>}
      </div>

      {isRecording && (
        <Waveform barAmplitudes={barAmplitudes} active={isRecording} />
      )}

      {voiceState === "listening" && (
        <span className="vo-hint">Release Alt to send · double-tap Alt to lock</span>
      )}
    </div>
  );
}

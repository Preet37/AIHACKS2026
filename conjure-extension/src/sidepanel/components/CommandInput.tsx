// §6 — full-width bar with `▶` marker, mic, faint placeholder, ⌘K chip.
// `large` is the command-palette size; `bar` is the persistent command bar.
// The block cursor is rendered via accent caret-color.
// While recording (Wispr-Flow push-to-talk via Alt/Option) the input is
// replaced by a live waveform driven by barAmplitudes.
import { Loader2, Mic, Volume2 } from "lucide-react";

type VoiceState = "idle" | "recording" | "transcribing" | "speaking";

interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  size?: "bar" | "large";
  showShortcut?: boolean;
  showMic?: boolean;
  onMic?: () => void;
  autoFocus?: boolean;
  ariaLabel?: string;
  voiceState?: VoiceState;
  barAmplitudes?: number[];
}

export function CommandInput({
  value,
  onChange,
  onSubmit,
  placeholder = "ask or speak to conjure…",
  size = "bar",
  showShortcut = true,
  showMic = true,
  onMic,
  autoFocus = false,
  ariaLabel = "Command input",
  voiceState = "idle",
  barAmplitudes = []
}: CommandInputProps) {
  const recording = voiceState === "recording";
  const classes = [
    "cj-cmd",
    size === "large" ? "cj-cmd--large" : "",
    voiceState !== "idle" ? `cj-cmd--voice cj-cmd--voice-${voiceState}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  const micIcon =
    voiceState === "transcribing" ? (
      <Loader2 aria-hidden="true" className="cj-spin" />
    ) : voiceState === "speaking" ? (
      <Volume2 aria-hidden="true" />
    ) : (
      <Mic aria-hidden="true" />
    );

  return (
    <form
      className={classes}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <span className="cj-cmd__marker" aria-hidden="true">
        ▶
      </span>
      {recording ? (
        <div className="cj-cmd__wave" aria-label="Listening">
          {(barAmplitudes.length ? barAmplitudes : Array(20).fill(0)).map((amp, i) => (
            <span
              key={i}
              className="cj-cmd__wave-bar"
              style={{ transform: `scaleY(${Math.max(0.08, amp)})` }}
            />
          ))}
        </div>
      ) : (
        <input
          className="cj-cmd__input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={voiceState === "transcribing" ? "transcribing…" : placeholder}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          disabled={voiceState === "transcribing"}
        />
      )}
      {showMic ? (
        <button
          type="button"
          className={`cj-cmd__mic${voiceState !== "idle" ? " cj-cmd__mic--active" : ""}`}
          onClick={onMic}
          aria-label="Voice input"
          title={voiceState === "speaking" ? "Interrupt and listen" : "Hold Alt / Option to talk"}
        >
          {micIcon}
        </button>
      ) : null}
      {showShortcut ? (
        <span className="cj-cmd__chip" aria-hidden="true">
          ⌘K
        </span>
      ) : null}
    </form>
  );
}

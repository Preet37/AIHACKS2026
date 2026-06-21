// §6 — full-width bar with `▶` marker, mic, faint placeholder, ⌘K chip.
// `large` is the command-palette size; `bar` is the persistent command bar.
// The block cursor is rendered via accent caret-color.
import { Mic } from "lucide-react";

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
  ariaLabel = "Command input"
}: CommandInputProps) {
  const classes = ["cj-cmd", size === "large" ? "cj-cmd--large" : ""].filter(Boolean).join(" ");

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
      <input
        className="cj-cmd__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
      />
      {showMic ? (
        <button type="button" className="cj-cmd__mic" onClick={onMic} aria-label="Voice input">
          <Mic aria-hidden="true" />
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

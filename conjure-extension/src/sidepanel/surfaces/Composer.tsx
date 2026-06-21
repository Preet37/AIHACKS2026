// The persistent command bar at the foot of the panel (§5/§7).
// Refactored to the CommandInput primitive (▶ marker + mic + ⌘K).
// Submit fires on enter (CommandInput's inner form) and is gated on non-empty input.
import { CommandInput } from "../components";
import { useSurface } from "../surfaceContext";
import "./Invoke.css";

export function Composer() {
  const { input, setInput, handleCommandSubmit, voiceState, voiceError, barAmplitudes, activateMic } =
    useSurface();

  const handleSubmit = () => {
    if (!input.trim()) return;
    handleCommandSubmit(input);
  };

  const micLabel =
    voiceState === "recording" ? "Stop recording"
    : voiceState === "transcribing" ? "Transcribing…"
    : voiceState === "speaking" ? "Speaking…"
    : "Hold Alt / Option to talk";

  return (
    <div
      className={`cj-composer${voiceState !== "idle" ? " cj-composer--voice-active" : ""}`}
      aria-label="Command bar"
    >
      <CommandInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        placeholder="ask or speak to conjure…"
        size="bar"
        showMic
        onMic={voiceState !== "transcribing" ? () => void activateMic() : undefined}
        showShortcut
        ariaLabel={micLabel}
        voiceState={voiceState}
        barAmplitudes={barAmplitudes}
      />
      {voiceError ? <p className="cj-composer__voice-error">{voiceError}</p> : null}
    </div>
  );
}

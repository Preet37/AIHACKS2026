// The persistent command bar at the foot of the panel (§5/§7).
// Refactored to the CommandInput primitive (▶ marker + mic + ⌘K).
// Submit fires on enter (CommandInput's inner form) and is gated on non-empty input.
import { CommandInput } from "../components";
import { useSurface } from "../surfaceContext";
import "./Invoke.css";

export function Composer() {
  const { input, setInput, handleCommandSubmit } = useSurface();

  const handleSubmit = () => {
    if (!input.trim()) return;
    handleCommandSubmit(input);
  };

  return (
    <div className="cj-composer" aria-label="Command bar">
      {/*
        CommandInput size="bar" renders the ▶ marker, mic icon, ⌘K chip.
        The primitive's inner <form> fires onSubmit on enter; we gate on
        non-empty input and delegate to surfaceContext.handleCommandSubmit.
      */}
      <CommandInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        placeholder="ask or speak to conjure…"
        size="bar"
        showMic
        showShortcut
        ariaLabel="Ask or speak to Conjure"
      />
    </div>
  );
}

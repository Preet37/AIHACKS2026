// Invoke — command bar (§7). ⌘K overlay over a dimmed page: CommandInput
// (large) + routed suggestion rows (first highlighted) + nav/esc footer.
// Refactored to §6 primitives: CommandInput, StatusBlock.
import "./Invoke.css";
import { useState } from "react";
import { CommandInput, StatusBlock } from "../components";
import { useSurface } from "../surfaceContext";

interface SuggestionRow {
  id: string;
  label: string;
  hint: string;
  onSelect: () => void;
}

export function CommandPalette() {
  const { input, setInput, handleCommandSubmit, setMode, setShowCommand } = useSurface();
  const [selected, setSelected] = useState(0);

  const rows: SuggestionRow[] = [
    {
      id: "create-mod",
      label: "create mod from this prompt",
      hint: "enter",
      onSelect: () => {
        void handleCommandSubmit(input);
      }
    },
    {
      id: "ask-planning",
      label: "ask in planning mode",
      hint: "→",
      onSelect: () => {
        setMode("planning");
        setShowCommand(false);
      }
    },
    {
      id: "run-agent",
      label: "run an agent task",
      hint: "→",
      onSelect: () => {
        void handleCommandSubmit(input || "Run an agent task for the active tab");
      }
    }
  ];

  // Enter in the input commits the currently selected suggestion (§8 keyboard model).
  const handleSubmit = () => {
    rows[selected].onSelect();
  };

  return (
    <div
      className="cj-invoke-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(event) => {
        // Dismiss on backdrop click
        if (event.target === event.currentTarget) {
          setShowCommand(false);
        }
      }}
      onKeyDown={(event) => {
        // §8 keyboard model: ↑/↓ navigate suggestions, esc cancels, enter commits.
        if (event.key === "Escape") {
          setShowCommand(false);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelected((current) => (current + 1) % rows.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelected((current) => (current - 1 + rows.length) % rows.length);
        }
      }}
    >
      <div className="cj-invoke-palette">
        {/* Large CommandInput — ▶ marker + mic + ⌘K chip, accent caret */}
        <CommandInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="block youtube shorts"
          size="large"
          showMic
          showShortcut
          autoFocus
          ariaLabel="Command input"
        />

        {/* Suggestion rows — first row highlighted */}
        <ul className="cj-invoke-rows" role="listbox" aria-label="Suggestions">
          {rows.map((row, index) => (
            <li key={row.id} role="none">
              <button
                type="button"
                className={`cj-invoke-row${index === selected ? " cj-invoke-row--active" : ""}`}
                role="option"
                aria-selected={index === selected}
                onClick={row.onSelect}
                onMouseEnter={() => setSelected(index)}
              >
                {/* Leading accent ■ on the selected row, faint □ on the rest */}
                <StatusBlock state={index === selected ? "active" : "pending"} />
                <span className="cj-invoke-row__label">{row.label}</span>
                <span className="cj-invoke-row__hint">{row.hint}</span>
              </button>
            </li>
          ))}
        </ul>

        {/* Footer nav hints */}
        <footer className="cj-invoke-footer">
          <span className="cj-invoke-footer__key">
            <kbd>↑↓</kbd> navigate
          </span>
          <span className="cj-invoke-footer__key">
            <kbd>esc</kbd> cancel
          </span>
        </footer>
      </div>
    </div>
  );
}

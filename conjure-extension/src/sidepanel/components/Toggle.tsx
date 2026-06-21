// §6 — a 26×13 square. Off: faint knob left. On: accent border +
// accent-wash fill + accent knob right. No rounding, no slide beyond the
// knob position.

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  // required for screen readers — the switch has no visible text of its own
  label: string;
  id?: string;
}

export function Toggle({ checked, onChange, label, id }: ToggleProps) {
  const classes = ["cj-toggle", checked ? "cj-toggle--on" : ""].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      id={id}
      className={classes}
      onClick={() => onChange(!checked)}
    >
      <span className="cj-toggle__knob" aria-hidden="true" />
    </button>
  );
}

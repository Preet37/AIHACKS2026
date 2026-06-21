// §4 — the ■/□ status atom. The block glyph is a typed status indicator,
// never a round dot or spinner. Replaces every lucide circle icon and the
// old .status-square / .trace-pixel.

export type StatusState = "active" | "done" | "pending";

interface StatusBlockProps {
  // active = accent ■ (running/current/selected/connected)
  // done   = dim ■ (completed/present-but-inactive)
  // pending = faint □ (pending/off/not connected)
  state: StatusState;
  // running animation, if any, is the accent ■ pulsing opacity — nothing else
  pulse?: boolean;
  // "loud" recolors for use on the royal-indigo splash ground
  tone?: "default" | "loud";
  // when labelled it is announced; otherwise decorative
  label?: string;
  className?: string;
}

export function StatusBlock({ state, pulse = false, tone = "default", label, className }: StatusBlockProps) {
  const classes = [
    "cj-status",
    `cj-status--${state}`,
    tone === "loud" ? "cj-status--loud" : "",
    pulse && state === "active" ? "cj-status--pulse" : "",
    className || ""
  ]
    .filter(Boolean)
    .join(" ");

  if (label) {
    return <span className={classes} role="img" aria-label={label} />;
  }
  return <span className={classes} aria-hidden="true" />;
}

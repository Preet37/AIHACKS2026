// §6 — square, hairline, transparent fill. Primary uses the accent border.
// Hover raises to surface-2; active scales 0.98. Action buttons that kick off
// work read `[ run ↗ ]` / `[ build ↗ ]` (that text is passed as children).
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost";
}

export function Button({ variant = "default", className, type, children, ...rest }: ButtonProps) {
  const classes = ["cj-btn", `cj-btn--${variant}`, className || ""].filter(Boolean).join(" ");

  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
}

// §6 — a Pane with a hairline title bar (the WM idiom). Title text +
// `■ ✕` controls flush right. Never beveled or gradient. `active` paints
// the bar border accent for a running window.
import type { ReactNode } from "react";

interface WindowProps {
  title: string;
  active?: boolean;
  // optional status ■ before the title
  barLeft?: ReactNode;
  // optional action controls before the close box
  barRight?: ReactNode;
  onClose?: () => void;
  className?: string;
  bodyClassName?: string;
  ariaLabel?: string;
  children: ReactNode;
}

export function Window({
  title,
  active = false,
  barLeft,
  barRight,
  onClose,
  className,
  bodyClassName,
  ariaLabel,
  children
}: WindowProps) {
  const classes = ["cj-window", active ? "cj-window--active" : "", className || ""].filter(Boolean).join(" ");
  const bodyClasses = ["cj-window__body", bodyClassName || ""].filter(Boolean).join(" ");

  return (
    <section className={classes} aria-label={ariaLabel}>
      <header className="cj-window__bar">
        <span className="cj-window__title">
          {barLeft}
          <span>{title}</span>
        </span>
        <span className="cj-window__controls">
          {barRight}
          {onClose ? (
            <button type="button" className="cj-window__close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          ) : null}
        </span>
      </header>
      <div className={bodyClasses}>{children}</div>
    </section>
  );
}

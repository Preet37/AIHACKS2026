// §6 — square, hairline, token-driven. Header is a `// name` tag in faint.
// Body is rows or a metadata block. Tiles edge-to-edge; no floating card.
import type { ReactNode } from "react";

interface PaneProps {
  name?: string;
  // raise off the ground onto --cj-surface
  surface?: boolean;
  headerRight?: ReactNode;
  className?: string;
  bodyClassName?: string;
  ariaLabel?: string;
  children: ReactNode;
}

export function Pane({ name, surface = false, headerRight, className, bodyClassName, ariaLabel, children }: PaneProps) {
  const classes = ["cj-pane", surface ? "cj-pane--surface" : "", className || ""].filter(Boolean).join(" ");
  const bodyClasses = ["cj-pane__body", bodyClassName || ""].filter(Boolean).join(" ");

  return (
    <section className={classes} aria-label={ariaLabel}>
      {name ? (
        <header className="cj-pane__head">
          <span className="cj-pane__name">// {name}</span>
          {headerRight ? <span className="cj-pane__head-right">{headerRight}</span> : null}
        </header>
      ) : null}
      <div className={bodyClasses}>{children}</div>
    </section>
  );
}

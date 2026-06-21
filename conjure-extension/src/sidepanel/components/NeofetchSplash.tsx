// §6 (loud) — the one place the loud ground and pixel face appear. Left: the
// hand-built CSS pixel mark. Right: the `conjure` wordmark + a MetadataBlock
// (white values, on-loud-dim keys) + the five palette swatches. This is the
// neofetch splash — the loud moment that carries the identity.
import { MetadataBlock, type MetaRow } from "./MetadataBlock";

interface NeofetchSplashProps {
  rows: MetaRow[];
  ariaLabel?: string;
}

// 4×5 grid forming an open "C": top row, left column, bottom row.
const PIXEL_CELLS = 20;
const FILLED = new Set([0, 1, 2, 3, 4, 8, 12, 16, 17, 18, 19]);

export function NeofetchSplash({ rows, ariaLabel = "Conjure idle state" }: NeofetchSplashProps) {
  return (
    <section className="cj-splash" aria-label={ariaLabel}>
      <div className="cj-splash__mark" aria-hidden="true">
        {Array.from({ length: PIXEL_CELLS }).map((_, index) => (
          <span
            key={index}
            className={FILLED.has(index) ? "cj-splash__px cj-splash__px--on" : "cj-splash__px"}
          />
        ))}
      </div>
      <div className="cj-splash__readout">
        <h1 className="cj-splash__wordmark">conjure</h1>
        <MetadataBlock rows={rows} tone="loud" />
        <div className="cj-splash__palette" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </section>
  );
}

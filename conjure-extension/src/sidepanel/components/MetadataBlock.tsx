// §6 — the signature molecule. grid auto/1fr, keys dim+micro, values text.
// A row carrying state leads its value with a status ■. Used for mods, runs,
// inspector, splash, settings — the same molecule everywhere.
import type { ReactNode } from "react";
import { StatusBlock, type StatusState } from "./StatusBlock";

export interface MetaRow {
  key: string;
  value: ReactNode;
  state?: StatusState;
  pulse?: boolean;
}

interface MetadataBlockProps {
  rows: MetaRow[];
  tone?: "default" | "loud";
  className?: string;
}

export function MetadataBlock({ rows, tone = "default", className }: MetadataBlockProps) {
  const classes = ["cj-meta", tone === "loud" ? "cj-meta--loud" : "", className || ""]
    .filter(Boolean)
    .join(" ");

  return (
    <dl className={classes}>
      {rows.map((row) => (
        <div key={row.key} className="cj-meta__row">
          <dt className="cj-meta__key">{row.key}</dt>
          <dd className="cj-meta__val">
            {row.state ? <StatusBlock state={row.state} pulse={row.pulse} tone={tone} /> : null}
            <span>{row.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// §6 — design-mode selection. Four filled-square accent handles at the
// element's corners + a floating mono toolbar (move / text / color / delete)
// above it. Snap guides (when present) are 1px accent lines.
import type { ReactNode } from "react";
import { Move, Palette, Trash2, Type } from "lucide-react";

export interface OverlayTool {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
}

interface SelectionOverlayProps {
  tools?: OverlayTool[];
  className?: string;
  children: ReactNode;
}

const defaultTools: OverlayTool[] = [
  { id: "move", label: "move", icon: <Move aria-hidden="true" /> },
  { id: "text", label: "text", icon: <Type aria-hidden="true" /> },
  { id: "color", label: "color", icon: <Palette aria-hidden="true" /> },
  { id: "delete", label: "delete", icon: <Trash2 aria-hidden="true" /> }
];

export function SelectionOverlay({ tools = defaultTools, className, children }: SelectionOverlayProps) {
  const classes = ["cj-selection", className || ""].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <div className="cj-selection__toolbar" role="toolbar" aria-label="Element actions">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="cj-selection__tool"
            title={tool.label}
            aria-label={tool.label}
            onClick={tool.onClick}
          >
            {tool.icon}
            <span>{tool.label}</span>
          </button>
        ))}
      </div>
      {children}
      <span className="cj-selection__handle cj-selection__handle--tl" aria-hidden="true" />
      <span className="cj-selection__handle cj-selection__handle--tr" aria-hidden="true" />
      <span className="cj-selection__handle cj-selection__handle--bl" aria-hidden="true" />
      <span className="cj-selection__handle cj-selection__handle--br" aria-hidden="true" />
    </div>
  );
}

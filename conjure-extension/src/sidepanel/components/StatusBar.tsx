// §6 — the persistent top bar. Left: ■ accent + `conjure` + workspace blocks
// `[1][2][3]` (active block = accent border). Right: context slot
// (scope, ⌘K, idle ■). The tiling-WM chrome — one of the four signatures.
import type { ReactNode } from "react";
import { StatusBlock } from "./StatusBlock";

export interface Workspace {
  id: string;
  label: string;
}

interface StatusBarProps {
  workspaces: Workspace[];
  activeId: string;
  onSelect: (id: string) => void;
  onBrand?: () => void;
  right?: ReactNode;
}

export function StatusBar({ workspaces, activeId, onSelect, onBrand, right }: StatusBarProps) {
  return (
    <header className="cj-statusbar">
      <button type="button" className="cj-statusbar__brand" onClick={onBrand} title="Open command bar">
        <StatusBlock state="active" />
        <span>conjure</span>
      </button>
      <nav className="cj-statusbar__spaces" aria-label="Workspaces">
        {workspaces.map((workspace, index) => {
          const active = workspace.id === activeId;
          return (
            <button
              key={workspace.id}
              type="button"
              className={["cj-ws", active ? "cj-ws--active" : ""].filter(Boolean).join(" ")}
              onClick={() => onSelect(workspace.id)}
              aria-current={active ? "true" : undefined}
              aria-label={workspace.label}
              title={workspace.label}
            >
              <span className="cj-ws__n">[{index + 1}]</span>
              <span className="cj-ws__label">{workspace.label}</span>
            </button>
          );
        })}
      </nav>
      {right ? <div className="cj-statusbar__right">{right}</div> : null}
    </header>
  );
}

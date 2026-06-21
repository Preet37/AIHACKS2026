// Splash (loud) — the neofetch idle state shown in the workspace stage when
// home is idle / empty. Composes the NeofetchSplash primitive (§6).
// The loud ground, pixel face, and palette swatches live entirely inside the
// primitive — this file only builds the MetaRow data.
import type { MetaRow } from "../components";
import { NeofetchSplash } from "../components";
import { useSurface } from "../surfaceContext";

export function SplashStage() {
  const { mods, activeMods, agentRun, activeScope, statusText } = useSurface();

  // status row: active (accent ■ + pulse) when a run is in progress (§4)
  const rows: MetaRow[] = [
    {
      key: "mods",
      value: `${mods.length} (${activeMods.length} active)`
    },
    {
      key: "runs",
      value: agentRun.active ? "1 running" : "0 queued"
    },
    {
      key: "scope",
      value: activeScope
    },
    {
      key: "status",
      value: statusText,
      state: agentRun.active ? "active" : "done",
      pulse: agentRun.active
    }
  ];

  return <NeofetchSplash rows={rows} ariaLabel="Conjure idle state" />;
}

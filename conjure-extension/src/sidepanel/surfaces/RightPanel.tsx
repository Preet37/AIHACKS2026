// Router for the side panel body (right pane). Switches the surface by mode
// and appends the memory rules strip. Parent-owned and stable; the per-mode
// panel files are where surface agents work.
import { useSurface } from "../surfaceContext";
import { HomePanel } from "./HomePanel";
import { PlanningPanel } from "./PlanningPanel";
import { DesignPanel } from "./DesignPanel";
import { TracePanel } from "./TracePanel";
import { SettingsPanel } from "./SettingsPanel";

export function RightPanel() {
  const { mode, rules } = useSurface();

  return (
    <div className="panel-scroll">
      {mode === "home" ? <HomePanel /> : null}
      {mode === "planning" ? <PlanningPanel /> : null}
      {mode === "design" ? <DesignPanel /> : null}
      {mode === "trace" ? <TracePanel /> : null}
      {mode === "settings" ? <SettingsPanel /> : null}

      {rules.length ? (
        <section className="rules-strip" aria-label="Memory rules">
          {rules.slice(0, 3).map((rule) => (
            <span key={rule}>{rule}</span>
          ))}
        </section>
      ) : null}
    </div>
  );
}

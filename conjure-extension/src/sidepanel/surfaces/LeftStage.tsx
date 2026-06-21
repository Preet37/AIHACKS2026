// Router for the workspace stage (left pane). Design → canvas, Trace → step
// stage, everything else → the loud splash. Parent-owned and stable; the
// per-mode stage files are where surface agents work.
import { useSurface } from "../surfaceContext";
import { DesignStage } from "./DesignStage";
import { SplashStage } from "./SplashStage";
import { TraceStage } from "./TraceStage";

export function LeftStage() {
  const { mode } = useSurface();

  return (
    <section className={`workspace-stage mode-${mode}`} aria-label="Workspace preview">
      {mode === "design" ? <DesignStage /> : mode === "trace" ? <TraceStage /> : <SplashStage />}
    </section>
  );
}

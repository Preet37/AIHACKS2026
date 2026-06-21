// Monitor — run-trace stage (§7). Run-state header (StatusBlock) + numbered
// step log (StatusBlock per step, dim text for failed) + ProgressBar footer.
// Composes §6 primitives only. No hardcoded hex, no border-radius, no red.
import "./Trace.css";
import { Button, StatusBlock, ProgressBar } from "../components";
import { traceStatusState } from "../lib/format";
import { useSurface } from "../surfaceContext";

// Derive the agent-level StatusBlock state from agentStatusClass.
// "running" → active+pulse; "passed" → done; anything else (idle/failed) →
// pending for idle, done for failed (dim ■, not red — §3 + §4).
function agentBlockState(
  statusClass: string
): { state: "active" | "done" | "pending"; pulse: boolean; label: string } {
  if (statusClass === "running") {
    return { state: "active", pulse: true, label: "running" };
  }
  if (statusClass === "passed") {
    return { state: "done", pulse: false, label: "done" };
  }
  if (statusClass === "failed") {
    // Failed = dim ■ + text wording. NEVER red (§3 / §9).
    return { state: "done", pulse: false, label: "stopped" };
  }
  // "idle" or unknown
  return { state: "pending", pulse: false, label: "idle" };
}

export function TraceStage() {
  const {
    latestUser,
    agentRun,
    agentStatusClass,
    visibleTrace,
    completedTraceCount,
    traceEntries,
  } = useSurface();

  const { state, pulse, label } = agentBlockState(agentStatusClass);
  const isRunning = agentStatusClass === "running";

  return (
    <section className="ts-stage" aria-label="Execution trace">
      {/* Run-state header: goal text left, StatusBlock + state label right */}
      <header className="ts-stage__header">
        <span className="ts-stage__run-label">
          run —{" "}
          <span className="ts-stage__run-goal">
            {latestUser?.content || "idle"}
          </span>
        </span>
        <span
          className={
            "ts-stage__state" + (isRunning ? " ts-stage__state--active" : "")
          }
        >
          <StatusBlock
            state={state}
            pulse={pulse}
            label={`Agent: ${label}`}
          />
          {agentRun.active ? "running" : label}
          <Button variant="ghost" type="button" disabled={!agentRun.active}>
            [ stop ]
          </Button>
        </span>
      </header>

      {/* Numbered step log. 01/02/03 markers are correct here — real sequence. */}
      <ol className="ts-stage__log">
        {visibleTrace.map((entry, index) => {
          const stepState = traceStatusState(entry.status);
          const isFailed = entry.status === "failed";
          const isActive = entry.status === "running";

          return (
            <li
              key={entry.id}
              className={
                "ts-stage__step" +
                (isActive ? " ts-stage__step--active" : "") +
                (isFailed ? " ts-stage__step--failed" : "")
              }
            >
              {/* ■/□ status block — §4 semantics */}
              <StatusBlock state={stepState} pulse={isActive} />
              {/* Tabular index — real sequence, allowed per §7 */}
              <span className="ts-stage__step-num">
                {String(index + 1).padStart(2, "0")}
              </span>
              {/* Label + optional detail */}
              <span>
                <span className="ts-stage__step-label">{entry.label}</span>
                {entry.detail ? (
                  <>
                    {" "}
                    <span className="ts-stage__step-detail">
                      {entry.detail}
                    </span>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {/* 2px accent-fill ProgressBar — §6 primitive, n/total readout included */}
      <ProgressBar
        value={completedTraceCount}
        total={traceEntries.length}
      />
    </section>
  );
}

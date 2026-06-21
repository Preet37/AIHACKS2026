import { ExternalLink, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import { Button, Pane, StatusBlock, Window } from "../components";
import { useSurface } from "../surfaceContext";
import "./HomePanel.css";

export function HomePanel() {
  const {
    mods,
    refreshAndApplyMods,
    projectId,
    editingMod,
    setEditingMod,
    submitModChange,
    removeMod,
    agentRun,
    agentStatusClass,
    setMode,
    pullRequestLinks
  } = useSurface();

  const runState = agentRun.active
    ? "active"
    : agentStatusClass === "passed" || agentStatusClass === "failed"
      ? "done"
      : "pending";
  const runPhraseClass = agentStatusClass === "failed" ? "hp-run-dim" : "hp-run-phrase";

  return (
    <div className="hp-stack">
      <Pane
        name="MODS"
        ariaLabel="Mods"
        bodyClassName="hp-mods-body"
        headerRight={
          <Button
            variant="ghost"
            title="Refresh and re-apply mods"
            onClick={() => void refreshAndApplyMods(projectId)}
          >
            <RefreshCcw aria-hidden="true" />
          </Button>
        }
      >
        {mods.length === 0 ? (
          <p className="hp-empty">No mods yet. Press cmd K to build one.</p>
        ) : (
          <ul className="hp-mod-list">
            {mods.map((mod) => {
              const verified = mod.last_verified;
              const verdict = verified?.passed ? "verified" : verified ? "failed" : "unverified";
              const modState = mod.status === "active" ? "active" : "done";

              return (
                <li key={mod.id} className="hp-mod-row">
                  <div className="hp-mod-head">
                    <StatusBlock
                      state={modState}
                      label={mod.status === "active" ? "active" : "inactive"}
                    />
                    <span className="hp-mod-name">{mod.name}</span>
                    <span className="hp-mod-verdict">{verdict}</span>
                  </div>

                  <p className="hp-mod-prompt">{mod.prompt}</p>

                  {verified?.replay_url ? (
                    <a className="hp-mod-link" href={verified.replay_url} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      Sandbox replay
                    </a>
                  ) : null}

                  {editingMod && editingMod.id === mod.id ? (
                    <form className="hp-mod-edit" onSubmit={submitModChange}>
                      <textarea
                        value={editingMod.prompt}
                        onChange={(event) => setEditingMod({ id: mod.id, prompt: event.target.value })}
                        rows={2}
                      />
                      <div className="hp-mod-edit-actions">
                        <Button type="submit">Rebuild</Button>
                        <Button variant="ghost" type="button" onClick={() => setEditingMod(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="hp-mod-actions">
                      <Button
                        variant="ghost"
                        title="Change the prompt and rebuild this mod"
                        onClick={() => setEditingMod({ id: mod.id, prompt: mod.prompt })}
                      >
                        <Pencil aria-hidden="true" /> Change
                      </Button>
                      <Button variant="ghost" title="Remove this mod" onClick={() => void removeMod(mod)}>
                        <Trash2 aria-hidden="true" /> Remove
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Pane>

      <Window
        title="RUNS"
        active={agentRun.active}
        ariaLabel="Run status"
        barLeft={
          <StatusBlock
            state={runState}
            pulse={agentRun.active}
            label={
              agentRun.active
                ? "running"
                : agentStatusClass === "passed"
                  ? "passed"
                  : agentStatusClass === "failed"
                    ? "failed"
                    : "idle"
            }
          />
        }
        barRight={
          <Button variant="ghost" title="Open trace" onClick={() => setMode("trace")}>
            track
          </Button>
        }
      >
        <div className="hp-run-body">
          <div className="hp-run-status">
            <StatusBlock state={runState} pulse={agentRun.active} />
            <span className={runPhraseClass}>{agentRun.phrase}</span>
          </div>

          {agentRun.sessionUrl ? (
            <a className="hp-run-link" href={agentRun.sessionUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Agent session
            </a>
          ) : null}

          {pullRequestLinks.length > 0 ? (
            <ol className="hp-pr-list">
              {pullRequestLinks.map((url, index) => (
                <li key={url}>
                  <a className="hp-run-link" href={url} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    PR {index + 1}
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </Window>
    </div>
  );
}

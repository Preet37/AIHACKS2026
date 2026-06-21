// Manage — Home side panel (§7). Composes §6 primitives:
// Pane `MODS` → Window `RUNS` → Pane `CONVERSATION`.
// All status indicators use StatusBlock (■/□); no lucide circle/spinner icons.
import { ExternalLink, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import { Button, Pane, StatusBlock, Window } from "../components";
import { formatTime } from "../lib/format";
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
    pullRequestLinks,
    messages,
    messagesEndRef
  } = useSurface();

  // Derive run StatusBlock state from agentStatusClass / agentRun
  const runState = agentRun.active
    ? "active"
    : agentStatusClass === "passed" || agentStatusClass === "failed"
      ? "done"
      : "pending";

  // "failed" run shows dim text; no new hue — §3 forbids red/green
  const runPhraseClass = agentStatusClass === "failed" ? "hp-run-dim" : "hp-run-phrase";

  return (
    <div className="hp-stack">
      {/* ── MODS pane ──────────────────────────────────────────────────── */}
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
          <p className="hp-empty">No mods yet. Ask Conjure to build one.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {mods.map((mod) => {
              const verified = mod.last_verified;
              const verdict = verified?.passed ? "verified" : verified ? "failed" : "unverified";
              // Active mod = accent ■; inactive mod = dim ■ (§4)
              const modState = mod.status === "active" ? "active" : "done";

              return (
                <li key={mod.id} className="hp-mod-row">
                  {/* Row header: status ■ + name + verdict */}
                  <div className="hp-mod-head">
                    <StatusBlock
                      state={modState}
                      label={mod.status === "active" ? "active" : "inactive"}
                    />
                    <span className="hp-mod-name">{mod.name}</span>
                    {/* verdict dim text — "failed" stays dim, never red (§3) */}
                    <span className="hp-mod-verdict">{verdict}</span>
                  </div>

                  {/* Prompt */}
                  <p className="hp-mod-prompt">{mod.prompt}</p>

                  {/* Sandbox replay link */}
                  {verified?.replay_url ? (
                    <a className="hp-mod-link" href={verified.replay_url} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      Sandbox replay
                    </a>
                  ) : null}

                  {/* Inline edit form or action buttons */}
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
                      <Button
                        variant="ghost"
                        title="Remove this mod"
                        onClick={() => void removeMod(mod)}
                      >
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

      {/* ── RUNS window ────────────────────────────────────────────────── */}
      {/* Window is active (accent bar) when a run is in progress (§6) */}
      <Window
        title="RUNS"
        active={agentRun.active}
        ariaLabel="Run status"
        barLeft={
          <StatusBlock
            state={runState}
            pulse={agentRun.active}
            label={agentRun.active ? "running" : agentStatusClass === "passed" ? "passed" : agentStatusClass === "failed" ? "failed" : "idle"}
          />
        }
        barRight={
          <Button
            variant="ghost"
            title="Open trace"
            onClick={() => setMode("trace")}
          >
            trace ↗
          </Button>
        }
      >
        <div className="hp-run-body">
          {/* Status ■ + phrase — "failed" phrase is dim text, not red (§3) */}
          <div className="hp-run-status">
            <StatusBlock state={runState} pulse={agentRun.active} />
            <span className={runPhraseClass}>{agentRun.phrase}</span>
          </div>

          {/* Session replay link */}
          {agentRun.sessionUrl ? (
            <a className="hp-run-link" href={agentRun.sessionUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Agent session
            </a>
          ) : null}

          {/* PR links */}
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

      {/* ── CONVERSATION pane ──────────────────────────────────────────── */}
      {/* A pane in the stack, not a full-screen log (§5) */}
      <Pane
        name="CONVERSATION"
        ariaLabel="Conversation"
        headerRight={
          <span style={{ color: "var(--cj-faint)", fontSize: "var(--cj-fs-micro)" }}>
            {messages.length}
          </span>
        }
      >
        <div className="hp-chat-body">
          {messages.map((message) => (
            <article key={message.id} className="hp-msg">
              {/* Micro meta row: role / time / streaming status ■ */}
              <div className="hp-msg-meta">
                <span className="hp-msg-role">{message.role}</span>
                <time className="hp-msg-time">{formatTime(message.createdAt)}</time>
                {/* streaming = pulsing accent ■ via StatusBlock — never Loader2 (§4) */}
                {message.streaming ? (
                  <StatusBlock state="active" pulse label="streaming" />
                ) : null}
              </div>
              <p className="hp-msg-content">{message.content}</p>
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </Pane>
    </div>
  );
}

import { ExternalLink, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Button, Pane, StatusBlock, Window } from "../components";
import { formatTime } from "../lib/format";
import { useSurface } from "../surfaceContext";
import { FindingsPanel } from "./FindingsPanel";
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
    activeMods,
    traceEntries,
    messages,
    messagesEndRef
  } = useSurface();

  const runState = agentRun.active
    ? "active"
    : agentStatusClass === "passed" || agentStatusClass === "failed"
      ? "done"
      : "pending";
  const runPhraseClass = agentStatusClass === "failed" ? "hp-run-dim" : "hp-run-phrase";

  return (
    <div className="hp-stack">
      <FindingsPanel />

      <Pane
        name="MODS"
        ariaLabel="Mods"
        bodyClassName="hp-mods-body"
        headerRight={
          <span className="hp-pane-count">
            {mods.length} / {activeMods.length} active
            <Button
              variant="ghost"
              title="Refresh and re-apply mods"
              onClick={() => void refreshAndApplyMods(projectId)}
            >
              <RefreshCcw aria-hidden="true" />
            </Button>
          </span>
        }
      >
        {mods.length === 0 ? (
          <div className="hp-empty">
            <span className="hp-empty__mark">workspace</span>
            <span>No mods yet. Press cmd K to build one.</span>
          </div>
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
          <span className="hp-pane-count">
            {agentRun.active ? "1 active" : "0 active"}
            <Button variant="ghost" title="Open trace" onClick={() => setMode("trace")}>
              track
            </Button>
          </span>
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

          <ol className="hp-step-log" aria-label="Run steps">
            {(traceEntries.length ? traceEntries : [
              { id: "idle-1", label: "waiting for prompt", status: "pending" as const },
              { id: "idle-2", label: "agent idle", status: "pending" as const }
            ]).slice(0, 4).map((entry, index) => (
              <li key={entry.id} className="hp-step">
                <StatusBlock
                  state={entry.status === "running" ? "active" : entry.status === "done" ? "done" : "pending"}
                  pulse={entry.status === "running"}
                />
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span>{entry.label}</span>
              </li>
            ))}
          </ol>
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
              {message.role === "assistant" ? (
                <div className="hp-msg-content hp-msg-md">
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="hp-msg-content">{message.content}</p>
              )}
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </Pane>
    </div>
  );
}

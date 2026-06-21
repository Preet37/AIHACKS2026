// Splash / settings (§7). Stacked Panes (CONNECTORS / PERMISSIONS / project /
// MODE) of Toggle + StatusBlock rows + a square segmented control.
// Refactored to §6 primitives (Pane, Toggle, StatusBlock, Button).
import { RefreshCcw } from "lucide-react";
import { normalizeHotkey } from "../../shared/keybind";
import { Pane, Toggle, StatusBlock, Button } from "../components";
import { useSurface } from "../surfaceContext";
import "./Settings.css";

export function SettingsPanel() {
  const {
    provider,
    setProvider,
    clearConversation,
    deepgramStatus,
    voiceState,
    uiSettings,
    toggleUiSetting,
    projectId,
    setProjectId,
    connectionState,
    refreshTabs,
    activeTabs,
    commandShortcuts,
    fallbackHotkey,
    setFallbackHotkey,
    refreshCommandShortcuts,
    openShortcutSettings,
    testCommandOverlay
  } = useSurface();

  const connectors = [
    { key: "linkedin" as const, label: "LinkedIn" },
    { key: "gmail" as const, label: "Gmail" },
    { key: "calendar" as const, label: "Calendar" }
  ];
  const commandShortcut = commandShortcuts.find((command) => command.name === "toggle-command-bar");
  const commandLabel = commandShortcut?.shortcut || normalizeHotkey(fallbackHotkey);
  const commandState = commandLabel ? "active" : "pending";

  return (
    <div className="sp-stack" aria-label="Settings">

      <Pane name="AGENT" surface ariaLabel="Agent provider">
        <div className="sp-pane-body">
          <div className="sp-row">
            <span className="sp-row-label">Provider</span>
            <div className="sp-segment" role="group" aria-label="Agent provider">
              {(["anthropic", "groq"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`sp-seg-btn${provider === candidate ? " sp-seg-btn--active" : ""}`}
                  aria-pressed={provider === candidate}
                  onClick={() => setProvider(candidate)}
                >
                  {candidate === "anthropic" ? "Anthropic" : "Groq"}
                </button>
              ))}
            </div>
          </div>
          <div className="sp-kv-row">
            <span className="sp-kv-key">KEY</span>
            <span className="sp-kv-val">loaded from backend .env</span>
          </div>
        </div>
      </Pane>

      <Pane
        name="VOICE · DEEPGRAM"
        surface
        className="sp-deepgram"
        ariaLabel="Deepgram voice"
        headerRight={
          <span className="sp-conn-status">
            <StatusBlock
              state={deepgramStatus === "ready" ? "active" : deepgramStatus === "checking" ? "done" : "pending"}
              pulse={deepgramStatus === "checking" || voiceState !== "idle"}
              label={`Deepgram ${deepgramStatus}`}
            />
            <span>{deepgramStatus}</span>
          </span>
        }
      >
        <div className="sp-deepgram__body">
          <div className="sp-deepgram__brand">DEEPGRAM</div>
          <p className="sp-deepgram__copy">
            Real-time voice input and interruptible assistant speech.
          </p>
          <div className="sp-deepgram__models">
            <span><b>STT</b> Nova-2</span>
            <span><b>TTS</b> Aura Asteria</span>
          </div>
          <div className="sp-deepgram__hint">
            Hold Alt/Option to talk. Press it again while Conjure speaks to interrupt and listen.
          </div>
          {deepgramStatus === "missing" ? (
            <div className="sp-deepgram__warning">Set DEEPGRAM_API_KEY in the backend .env, then restart it.</div>
          ) : null}
        </div>
      </Pane>

      {/* CONNECTORS ─────────────────────────────────────────────────────── */}
      <Pane name="CONNECTORS" surface ariaLabel="Connectors">
        <div className="sp-pane-body">
          {connectors.map(({ key, label }) => {
            const connected = Boolean(uiSettings[key]);
            return (
              <div key={key} className="sp-row">
                <span className="sp-row-label">{label}</span>
                <span className="sp-row-right">
                  <span className="sp-conn-status">
                    <StatusBlock
                      state={connected ? "active" : "pending"}
                      label={connected ? "connected" : "not connected"}
                    />
                    <span>{connected ? "connected" : "not connected"}</span>
                  </span>
                  <Toggle
                    checked={connected}
                    onChange={() => toggleUiSetting(key)}
                    label={`Toggle ${label}`}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </Pane>

      {/* PERMISSIONS removed — always enabled */}

      {/* project ─────────────────────────────────────────────────────────── */}
      <Pane
        name="project"
        surface
        ariaLabel="Project"
        headerRight={
          <Button
            variant="ghost"
            title="Refresh active tabs"
            onClick={refreshTabs}
            aria-label="Refresh active tabs"
          >
            <RefreshCcw aria-hidden="true" />
          </Button>
        }
      >
        <div className="sp-pane-body">
          <div className="sp-kv-row">
            <span className="sp-kv-key">ID</span>
            <span className="sp-kv-val">
              <input
                id="projectId"
                className="sp-input"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={connectionState === "connected"}
                aria-label="Project ID"
              />
            </span>
          </div>
          {activeTabs.length > 0 && (
            <div className="sp-kv-row">
              <span className="sp-kv-key">TABS</span>
              <span className="sp-kv-val">
                <div className="sp-tabs-strip" aria-label="Open tabs">
                  {activeTabs.slice(0, 6).map((tab) => (
                    <div
                      key={tab.id}
                      className={`sp-tab-chip${tab.active ? " sp-tab-chip--active" : ""}`}
                      title={tab.url}
                    >
                      <span className="sp-tab-key">{tab.active ? "ACTIVE" : "TAB"}</span>
                      <span className="sp-tab-title">{tab.title}</span>
                    </div>
                  ))}
                </div>
              </span>
            </div>
          )}
        </div>
      </Pane>

      {/* MODE removed — agent auto-decides based on user intent */}

      <Pane
        name="KEYBIND"
        surface
        ariaLabel="Command keybind"
        headerRight={
          <Button variant="ghost" title="Refresh shortcut status" onClick={refreshCommandShortcuts}>
            <RefreshCcw aria-hidden="true" />
          </Button>
        }
      >
        <div className="sp-pane-body">
          <div className="sp-kv-row">
            <span className="sp-kv-key">COMMAND</span>
            <span className="sp-kv-val sp-kv-status">
              <StatusBlock state={commandState} label={`Chrome shortcut ${commandLabel}`} />
              <span>{commandLabel}</span>
            </span>
          </div>
          <div className="sp-kv-row">
            <span className="sp-kv-key">FALLBACK</span>
            <span className="sp-kv-val">
              <input
                className="sp-input"
                value={fallbackHotkey}
                onChange={(event) => setFallbackHotkey(event.target.value)}
                onBlur={(event) => setFallbackHotkey(normalizeHotkey(event.target.value))}
                aria-label="Fallback command hotkey"
              />
            </span>
          </div>
          <div className="sp-actions">
            <Button type="button" onClick={openShortcutSettings}>
              [ open chrome shortcuts ↗ ]
            </Button>
            <Button type="button" variant="primary" onClick={testCommandOverlay}>
              [ test overlay ]
            </Button>
          </div>
        </div>
      </Pane>

      <Pane name="DATA" surface ariaLabel="Conversation data">
        <div className="sp-pane-body">
          <div className="sp-row">
            <span className="sp-row-label">Conversation cache</span>
            <Button type="button" onClick={clearConversation}>
              [ clear conversation ]
            </Button>
          </div>
          <div className="sp-kv-row">
            <span className="sp-kv-key">KEEPS</span>
            <span className="sp-kv-val">mods, provider, and extension settings</span>
          </div>
        </div>
      </Pane>

    </div>
  );
}

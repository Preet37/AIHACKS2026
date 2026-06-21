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
    uiSettings,
    toggleUiSetting,
    setUiSettings,
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

  const permissions = [
    { key: "allowAuthenticatedTabs" as const, label: "Allow agents to act in authenticated tabs" },
    { key: "requireConfirmation" as const, label: "Require confirmation before each run" },
    { key: "voiceAlwaysListening" as const, label: "Voice always-listening" }
  ];
  const commandShortcut = commandShortcuts.find((command) => command.name === "toggle-command-bar");
  const commandState = commandShortcut?.shortcut ? "active" : commandShortcut ? "pending" : "pending";
  const commandLabel = commandShortcut?.shortcut || "unassigned";

  return (
    <div className="sp-stack" aria-label="Settings">

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

      {/* PERMISSIONS ─────────────────────────────────────────────────────── */}
      <Pane name="PERMISSIONS" surface ariaLabel="Permissions">
        <div className="sp-pane-body">
          {permissions.map(({ key, label }) => (
            <div key={key} className="sp-row">
              <span className="sp-row-label">{label}</span>
              <Toggle
                checked={Boolean(uiSettings[key])}
                onChange={() => toggleUiSetting(key)}
                label={`Toggle ${label}`}
              />
            </div>
          ))}
        </div>
      </Pane>

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

      {/* MODE ────────────────────────────────────────────────────────────── */}
      <Pane
        name="MODE"
        surface
        ariaLabel="Work mode"
        headerRight={
          <span className="sp-header-mode">{uiSettings.workMode}</span>
        }
      >
        <div className="sp-pane-body">
          <div className="sp-segment" role="group" aria-label="Work mode">
            <button
              type="button"
              className={`sp-seg-btn${uiSettings.workMode === "planning" ? " sp-seg-btn--active" : ""}`}
              aria-pressed={uiSettings.workMode === "planning"}
              onClick={() => setUiSettings((current) => ({ ...current, workMode: "planning" }))}
            >
              planning
            </button>
            <button
              type="button"
              className={`sp-seg-btn${uiSettings.workMode === "coding" ? " sp-seg-btn--active" : ""}`}
              aria-pressed={uiSettings.workMode === "coding"}
              onClick={() => setUiSettings((current) => ({ ...current, workMode: "coding" }))}
            >
              coding
            </button>
          </div>
        </div>
      </Pane>

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

    </div>
  );
}

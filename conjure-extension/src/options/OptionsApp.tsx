import { Eye, EyeOff, KeyRound } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { ClientProvider } from "../shared/messages";
import {
  clearDiagnosticLogs,
  readDiagnosticLogs,
  type DiagnosticLogEntry
} from "../shared/diagnosticLogs";
import {
  clearProviderSettings,
  readProviderSettings,
  saveProviderSettings
} from "../shared/providerSettings";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function OptionsApp() {
  const [provider, setProvider] = useState<ClientProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);

  useEffect(() => {
    readProviderSettings()
      .then((settings) => {
        setProvider(settings.provider);
        setApiKey(settings.apiKey);
      })
      .catch(() => setSaveState("error"));
  }, []);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaveState("saving");
    try {
      await saveProviderSettings({ provider, apiKey: apiKey.trim() });
      setApiKey(apiKey.trim());
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };

  const handleClear = async () => {
    setSaveState("saving");
    try {
      await clearProviderSettings();
      setProvider("anthropic");
      setApiKey("");
      setSaveState("idle");
    } catch {
      setSaveState("error");
    }
  };

  const handleToggleLogs = async () => {
    const next = !showLogs;
    setShowLogs(next);
    if (next) {
      try {
        setLogs(await readDiagnosticLogs());
      } catch {
        setSaveState("error");
      }
    }
  };

  const handleClearLogs = async () => {
    try {
      await clearDiagnosticLogs();
      setLogs([]);
    } catch {
      setSaveState("error");
    }
  };

  return (
    <main className="options-shell">
      <header>
        <div className="brand-mark"><KeyRound aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Chrome extension</p>
          <h1>Conjure settings</h1>
        </div>
      </header>

      <form onSubmit={handleSave}>
        <label>
          <span>Agent provider</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as ClientProvider);
              setApiKey("");
              setSaveState("idle");
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
          </select>
        </label>

        <label>
          <span>API key</span>
          <div className="api-key-field">
            <input
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaveState("idle");
              }}
              placeholder={provider === "groq" ? "gsk_…" : "sk-ant-…"}
              autoComplete="off"
              spellCheck={false}
              aria-label="API key"
            />
            <button
              type="button"
              className="reveal-button"
              title={showApiKey ? "Hide API key" : "Show API key"}
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
              onClick={() => setShowApiKey((current) => !current)}
            >
              {showApiKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
        </label>

        <p className="privacy-note">
          Chrome stores this in Conjure's extension-local storage. It is not encrypted, but web
          pages and Conjure content scripts cannot read it. Conjure sends it to your configured
          backend only when starting an agent run; the backend does not persist it.
        </p>

        <div className="actions">
          <button type="button" className="clear-button" onClick={handleClear}>Clear key</button>
          <span className={`save-status ${saveState}`} role="status">
            {saveState === "saved" ? "Saved" : saveState === "error" ? "Couldn't save" : ""}
          </span>
          <button type="submit" className="save-button" disabled={saveState === "saving"}>
            {saveState === "saving" ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="logs-heading">
          <button type="button" className="logs-toggle" onClick={handleToggleLogs}>
            {showLogs ? "Hide logs" : "Show logs"}
          </button>
          {showLogs && logs.length > 0 ? (
            <button type="button" className="logs-clear" onClick={handleClearLogs}>Clear logs</button>
          ) : null}
        </div>

        {showLogs ? (
          <section className="diagnostic-logs" aria-label="Diagnostic logs">
            {logs.length === 0 ? (
              <p>No errors recorded yet.</p>
            ) : (
              <ol>
                {logs.map((log) => (
                  <li key={log.id}>
                    <div>
                      <strong>{log.source}</strong>
                      <time>{new Date(log.timestamp).toLocaleString()}</time>
                    </div>
                    <pre>{log.message}</pre>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
      </form>
    </main>
  );
}

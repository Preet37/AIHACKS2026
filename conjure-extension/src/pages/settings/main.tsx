import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadExtensionFonts } from "../../shared/fonts";
import {
  DEFAULT_FALLBACK_HOTKEY,
  FALLBACK_HOTKEY_STORAGE_KEY
} from "../../shared/keybind";
import {
  DEFAULT_PROVIDER,
  readProvider,
  saveProvider
} from "../../shared/providerSettings";
import {
  BACKGROUND_MESSAGE,
  type ClientProvider,
  type CommandShortcutInfo,
  type RuntimeRequest,
  type RuntimeResult
} from "../../shared/messages";
import { StatusBar } from "../../sidepanel/components";
import { SurfaceProvider } from "../../sidepanel/surfaceContext";
import { SettingsPanel } from "../../sidepanel/surfaces/SettingsPanel";
import { createStaticSurfaceValue, defaultUiSettings } from "../shared/staticSurface";
import "../../sidepanel/tokens.css";
import "../../sidepanel/styles.css";
import "../../sidepanel/components/primitives.css";
import "../../sidepanel/surfaces/Settings.css";
import "../shared/page.css";

loadExtensionFonts();

const sendRuntimeMessage = async <T,>(message: RuntimeRequest): Promise<RuntimeResult<T> | undefined> => {
  try {
    if (!chrome.runtime?.id) return undefined;
    return (await chrome.runtime.sendMessage(message)) as RuntimeResult<T>;
  } catch {
    return undefined;
  }
};

function SettingsPage() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [uiSettings, setUiSettings] = useState(defaultUiSettings);
  const [projectId, setProjectId] = useState("local-demo");
  const [commandShortcuts, setCommandShortcuts] = useState<CommandShortcutInfo[]>([]);
  const [fallbackHotkey, setFallbackHotkeyState] = useState(DEFAULT_FALLBACK_HOTKEY);
  const [provider, setProviderState] = useState<ClientProvider>(DEFAULT_PROVIDER);

  const refreshCommandShortcuts = useCallback(async () => {
    const response = await sendRuntimeMessage<CommandShortcutInfo[]>({
      type: BACKGROUND_MESSAGE.GET_COMMAND_SHORTCUTS
    });
    if (response?.ok) setCommandShortcuts(response.data);
  }, []);

  const setFallbackHotkey = useCallback((value: string) => {
    setFallbackHotkeyState(value);
    chrome.storage?.local?.set({ [FALLBACK_HOTKEY_STORAGE_KEY]: value }).catch(() => undefined);
  }, []);

  const setProvider = useCallback((nextProvider: ClientProvider) => {
    setProviderState(nextProvider);
    void saveProvider(nextProvider);
  }, []);

  useEffect(() => {
    chrome.storage?.local
      ?.get(FALLBACK_HOTKEY_STORAGE_KEY)
      .then((stored) => {
        const value = stored[FALLBACK_HOTKEY_STORAGE_KEY];
        setFallbackHotkeyState(typeof value === "string" ? value : DEFAULT_FALLBACK_HOTKEY);
      })
      .catch(() => undefined);
    void refreshCommandShortcuts();
    void readProvider().then(setProviderState).catch(() => undefined);
  }, [refreshCommandShortcuts]);

  const surface = useMemo(
    () => {
      const base = createStaticSurfaceValue({
        messagesEndRef,
        uiSettings,
        setUiSettings,
        projectId,
        setProjectId
      });
      return {
        ...base,
        provider,
        setProvider,
        commandShortcuts,
        fallbackHotkey,
        setFallbackHotkey,
        refreshCommandShortcuts,
        openShortcutSettings: () => {
          void sendRuntimeMessage({ type: BACKGROUND_MESSAGE.OPEN_SHORTCUT_SETTINGS });
        },
        testCommandOverlay: () => {
          void sendRuntimeMessage({ type: BACKGROUND_MESSAGE.TOGGLE_COMMAND_BAR });
        }
      };
    },
    [commandShortcuts, fallbackHotkey, projectId, provider, refreshCommandShortcuts, setFallbackHotkey, setProvider, uiSettings]
  );

  return (
    <SurfaceProvider value={surface}>
      <main className="cj-page">
        <StatusBar
          workspaces={[{ id: "settings", label: "settings" }]}
          activeId="settings"
          onSelect={() => undefined}
          right={<span className="cj-statusbar__status">options</span>}
        />
        <section className="cj-page__settings" aria-label="Settings">
          <SettingsPanel />
        </section>
      </main>
    </SurfaceProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>
);

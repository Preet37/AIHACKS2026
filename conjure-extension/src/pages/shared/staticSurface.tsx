import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import type { ActiveTabSnapshot, ModRecord } from "../../shared/messages";
import { DEFAULT_FALLBACK_HOTKEY } from "../../shared/keybind";
import type {
  ChatMessage,
  EditingMod,
  SurfaceContextValue,
  TraceEntry,
  UiSettings
} from "../../sidepanel/surfaceContext";

interface StaticSurfaceOptions {
  messagesEndRef: RefObject<HTMLDivElement | null>;
  uiSettings: UiSettings;
  setUiSettings: Dispatch<SetStateAction<UiSettings>>;
  projectId: string;
  setProjectId: (value: string) => void;
  activeTabs?: ActiveTabSnapshot[];
  activeTab?: ActiveTabSnapshot;
}

const noop = () => undefined;

export const defaultUiSettings: UiSettings = {
  linkedin: true,
  gmail: true,
  calendar: false,
  allowAuthenticatedTabs: false,
  requireConfirmation: true,
  voiceAlwaysListening: false,
  workMode: "planning"
};

export const createStaticSurfaceValue = ({
  messagesEndRef,
  uiSettings,
  setUiSettings,
  projectId,
  setProjectId,
  activeTabs = [],
  activeTab
}: StaticSurfaceOptions): SurfaceContextValue => {
  const messages: ChatMessage[] = [
    {
      id: "static-message",
      role: "system",
      content: "Opened as an extension tab.",
      createdAt: Date.now()
    }
  ];
  const traceEntries: TraceEntry[] = [
    {
      id: "01",
      label: "route opened",
      detail: "extension tab mounted",
      status: "done",
      timestamp: Date.now()
    },
    {
      id: "02",
      label: "waiting for run",
      detail: "no active agent stream",
      status: "pending",
      timestamp: Date.now()
    }
  ];
  const mods: ModRecord[] = [];

  return {
    mode: "home",
    setMode: noop,
    mods,
    activeMods: mods,
    refreshAndApplyMods: noop,
    editingMod: null,
    setEditingMod: noop as Dispatch<SetStateAction<EditingMod | null>>,
    submitModChange: noop as (event: FormEvent) => void,
    removeMod: noop,
    agentRun: {
      active: false,
      phrase: "No active run.",
      pullRequests: []
    },
    agentStatusClass: "idle",
    providerLabel: "Agent",
    pullRequestLinks: [],
    messages,
    messagesEndRef,
    latestUser: undefined,
    traceEntries,
    visibleTrace: traceEntries,
    completedTraceCount: 1,
    traceProgress: 50,
    elapsedLabel: "0s",
    sandboxImageSrc: undefined,
    activeScope: activeTab?.url || "extension tab",
    activeTab,
    activeTabs,
    refreshTabs: noop,
    statusText: "Ready",
    connectionState: "idle",
    projectId,
    setProjectId,
    planningOptions: [],
    planningChoice: "",
    setPlanningChoice: noop,
    planningCustom: "",
    setPlanningCustom: noop,
    selectedPlanningOption: { id: "", title: "", detail: "" },
    runPlanningBuild: noop,
    provider: "anthropic",
    setProvider: noop,
    clearConversation: noop,
    uiSettings,
    toggleUiSetting: (key) => {
      setUiSettings((current) => {
        const value = current[key];
        return typeof value === "boolean" ? { ...current, [key]: !value } : current;
      });
    },
    setUiSettings,
    rules: [],
    commandShortcuts: [],
    fallbackHotkey: DEFAULT_FALLBACK_HOTKEY,
    setFallbackHotkey: noop,
    refreshCommandShortcuts: noop,
    openShortcutSettings: noop,
    testCommandOverlay: noop,
    finder: {
      status: "idle",
      findings: [],
      error: null,
      replayUrl: undefined,
      run: async () => {},
      clear: noop
    },
    input: "",
    setInput: noop,
    handleSubmit: noop as (event: FormEvent) => void,
    showCommand: false,
    setShowCommand: noop,
    handleCommandSubmit: noop,
    deepgramStatus: "checking",
    voiceState: "idle",
    voiceError: null,
    barAmplitudes: [],
    activateMic: noop
  };
};

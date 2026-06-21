// Shared surface seam. App.tsx owns all state and handlers and exposes them
// here once; each surface component (HomePanel, TracePanel, …) consumes the
// slice it needs via useSurface(). This lets surfaces live in separate files
// (composing §6 primitives) without 100-line prop drilling.
import { createContext, useContext, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import type { ActiveTabSnapshot, AgentProvider, AgentPullRequest, CommandShortcutInfo, ModRecord } from "../shared/messages";
import type { FinderSlice } from "./useFinder";

export type PanelMode = "home" | "planning" | "design" | "trace" | "settings";
export type WorkMode = "planning" | "coding";
export type TraceStatus = "running" | "done" | "failed" | "pending";
export type ConnectionState = "idle" | "connecting" | "connected" | "error";
export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  streaming?: boolean;
}

export interface AgentRunState {
  active: boolean;
  provider?: AgentProvider;
  phrase: string;
  status?: string;
  statusDetail?: string;
  sessionUrl?: string;
  pullRequests: AgentPullRequest[];
}

export interface TraceEntry {
  id: string;
  label: string;
  detail?: string;
  status: TraceStatus;
  timestamp: number;
  modId?: string;
  replayUrl?: string;
  screenshotData?: string;
  targetUrl?: string;
}

export interface PlanningOption {
  id: string;
  title: string;
  detail: string;
}

export interface UiSettings {
  linkedin: boolean;
  gmail: boolean;
  calendar: boolean;
  allowAuthenticatedTabs: boolean;
  requireConfirmation: boolean;
  voiceAlwaysListening: boolean;
  workMode: WorkMode;
}

export interface EditingMod {
  id: string;
  prompt: string;
}

export interface SurfaceContextValue {
  // mode
  mode: PanelMode;
  setMode: (mode: PanelMode) => void;

  // mods
  mods: ModRecord[];
  activeMods: ModRecord[];
  refreshAndApplyMods: (projectId: string) => void;
  editingMod: EditingMod | null;
  setEditingMod: Dispatch<SetStateAction<EditingMod | null>>;
  submitModChange: (event: FormEvent) => void;
  removeMod: (mod: ModRecord) => void;

  // run / agent
  agentRun: AgentRunState;
  agentStatusClass: string;
  providerLabel: string;
  pullRequestLinks: string[];

  // conversation
  messages: ChatMessage[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  latestUser: ChatMessage | undefined;

  // trace
  traceEntries: TraceEntry[];
  visibleTrace: TraceEntry[];
  completedTraceCount: number;
  traceProgress: number;
  elapsedLabel: string;
  sandboxImageSrc: string | undefined;

  // context / tabs
  activeScope: string;
  activeTab: ActiveTabSnapshot | undefined;
  activeTabs: ActiveTabSnapshot[];
  refreshTabs: () => void;
  statusText: string;
  connectionState: ConnectionState;
  projectId: string;
  setProjectId: (value: string) => void;

  // planning
  planningOptions: PlanningOption[];
  planningChoice: string;
  setPlanningChoice: (id: string) => void;
  planningCustom: string;
  setPlanningCustom: (value: string) => void;
  selectedPlanningOption: PlanningOption;
  runPlanningBuild: () => void;

  // settings
  uiSettings: UiSettings;
  toggleUiSetting: (key: keyof UiSettings) => void;
  setUiSettings: Dispatch<SetStateAction<UiSettings>>;
  rules: string[];
  commandShortcuts: CommandShortcutInfo[];
  fallbackHotkey: string;
  setFallbackHotkey: (value: string) => void;
  refreshCommandShortcuts: () => void;
  openShortcutSettings: () => void;
  testCommandOverlay: () => void;

  // finder ("find on this page" off-device browser agent)
  finder: FinderSlice;

  // command bar / palette
  input: string;
  setInput: (value: string) => void;
  handleSubmit: (event: FormEvent) => void;
  showCommand: boolean;
  setShowCommand: (value: boolean) => void;
  handleCommandSubmit: (query: string) => void;
}

const SurfaceContext = createContext<SurfaceContextValue | null>(null);

export const SurfaceProvider = SurfaceContext.Provider;

export function useSurface(): SurfaceContextValue {
  const value = useContext(SurfaceContext);
  if (!value) {
    throw new Error("useSurface must be used within a SurfaceProvider.");
  }
  return value;
}

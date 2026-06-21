export const CONTENT_MESSAGE = {
  CONSOLE_EVENT: "conjure:console_event",
  GET_PAGE_CONTENT: "conjure:get_page_content",
  GET_ELEMENT_HTML: "conjure:get_element_html",
  TOGGLE_COMMAND_BAR: "conjure:toggle_command_bar"
} as const;

export const BACKGROUND_MESSAGE = {
  GET_ACTIVE_TABS: "conjure:get_active_tabs",
  GET_CONSOLE_LOGS: "conjure:get_console_logs",
  RELOAD_ALL_TABS_ONCE: "conjure:reload_all_tabs_once",
  APPLY_MODS: "conjure:apply_mods",
  REMOVE_MOD: "conjure:remove_mod",
  OPEN_DESIGN_TAB: "conjure:open_design_tab",
  OPEN_TRACE_TAB: "conjure:open_trace_tab",
  OPEN_SETTINGS_TAB: "conjure:open_settings_tab",
  GET_COMMAND_SHORTCUTS: "conjure:get_command_shortcuts",
  OPEN_SHORTCUT_SETTINGS: "conjure:open_shortcut_settings",
  TOGGLE_COMMAND_BAR: "conjure:toggle_command_bar"
} as const;

export const CLIENT_EVENT = {
  CHAT: "chat",
  TAB_CONTENT_RESPONSE: "tab_content_response",
  CONSOLE_LOGS_RESPONSE: "console_logs_response"
} as const;

export const SERVER_EVENT = {
  CONVERSATION_ID: "conversation_id",
  CONTENT: "content",
  TOOL_START: "tool_start",
  TOOL_END: "tool_end",
  THINKING: "thinking",
  REQUEST_TAB_CONTENT: "request_tab_content",
  REQUEST_CONSOLE_LOGS: "request_console_logs",
  AGENT_STATUS: "agent_status",
  SANDBOX_START: "sandbox_start",
  SANDBOX_SCREENSHOT: "sandbox_screenshot",
  SANDBOX_RESULT: "sandbox_result",
  SANDBOX_HEALING: "sandbox_healing",
  EXTENSION_READY: "extension_ready",
  MODS_UPDATED: "mods_updated",
  CONVERSATION_TITLE: "conversation_title",
  RULES_UPDATED: "rules_updated",
  DONE: "done",
  ERROR: "error"
} as const;

export type ConsoleLevel = "debug" | "info" | "log" | "warn" | "error";

export interface ActiveTabSnapshot {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
}

export interface ConsoleLogEntry {
  id: string;
  tabId?: number;
  frameId?: number;
  level: ConsoleLevel;
  text: string;
  args: string[];
  url: string;
  timestamp: number;
  source: "console" | "window" | "unhandledrejection";
}

export interface PageContentResult {
  requestId?: string;
  contentType: "page" | "element";
  url: string;
  title: string;
  text: string;
  html: string;
  selector?: string;
  truncated: boolean;
}

export interface RuntimeOk<T> {
  ok: true;
  data: T;
}

export interface RuntimeError {
  ok: false;
  error: string;
}

export type RuntimeResult<T> = RuntimeOk<T> | RuntimeError;

export interface ContentConsoleEventMessage {
  type: typeof CONTENT_MESSAGE.CONSOLE_EVENT;
  payload: Omit<ConsoleLogEntry, "id" | "tabId" | "frameId"> & {
    id?: string;
  };
}

export interface GetPageContentMessage {
  type: typeof CONTENT_MESSAGE.GET_PAGE_CONTENT;
  requestId?: string;
  includeHtml?: boolean;
  maxChars?: number;
}

export interface GetElementHtmlMessage {
  type: typeof CONTENT_MESSAGE.GET_ELEMENT_HTML;
  requestId?: string;
  selector: string;
  maxChars?: number;
}

export interface ToggleCommandBarContentMessage {
  type: typeof CONTENT_MESSAGE.TOGGLE_COMMAND_BAR;
}

export interface CommandShortcutInfo {
  name: string;
  description?: string;
  shortcut?: string;
}

export interface GetActiveTabsMessage {
  type: typeof BACKGROUND_MESSAGE.GET_ACTIVE_TABS;
}

export interface GetConsoleLogsMessage {
  type: typeof BACKGROUND_MESSAGE.GET_CONSOLE_LOGS;
  tabId?: number;
  level?: ConsoleLevel;
  since?: number;
  limit?: number;
}

export interface ReloadAllTabsOnceMessage {
  type: typeof BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE;
}

/** One mod's content-script bundle Conjure injects into the browser. */
export interface GeneratedBundle {
  mod_id?: string;
  name: string;
  matches: string[];
  run_at: string;
  js: string;
  css: string;
}

/** A mod record as tracked by the backend registry. */
export interface ModRecord {
  id: string;
  name: string;
  prompt: string;
  status: "active" | "disabled";
  created_at?: number;
  updated_at?: number;
  last_verified?: {
    passed: boolean;
    source?: string;
    target_url?: string;
    replay_url?: string;
    findings?: string[];
    at?: number;
  } | null;
}

export interface ApplyModsMessage {
  type: typeof BACKGROUND_MESSAGE.APPLY_MODS;
  bundles: GeneratedBundle[];
}

export interface RemoveModMessage {
  type: typeof BACKGROUND_MESSAGE.REMOVE_MOD;
  modId: string;
}

export interface OpenDesignTabMessage {
  type: typeof BACKGROUND_MESSAGE.OPEN_DESIGN_TAB;
}

export interface OpenTraceTabMessage {
  type: typeof BACKGROUND_MESSAGE.OPEN_TRACE_TAB;
}

export interface OpenSettingsTabMessage {
  type: typeof BACKGROUND_MESSAGE.OPEN_SETTINGS_TAB;
}

export interface GetCommandShortcutsMessage {
  type: typeof BACKGROUND_MESSAGE.GET_COMMAND_SHORTCUTS;
}

export interface OpenShortcutSettingsMessage {
  type: typeof BACKGROUND_MESSAGE.OPEN_SHORTCUT_SETTINGS;
}

export interface ToggleCommandBarBackgroundMessage {
  type: typeof BACKGROUND_MESSAGE.TOGGLE_COMMAND_BAR;
}

export interface ApplyModsResult {
  applied: number;
  removed: number;
  reloaded: number;
}

export type RuntimeRequest =
  | ContentConsoleEventMessage
  | GetPageContentMessage
  | GetElementHtmlMessage
  | ToggleCommandBarContentMessage
  | GetActiveTabsMessage
  | GetConsoleLogsMessage
  | ReloadAllTabsOnceMessage
  | ApplyModsMessage
  | RemoveModMessage
  | OpenDesignTabMessage
  | OpenTraceTabMessage
  | OpenSettingsTabMessage
  | GetCommandShortcutsMessage
  | OpenShortcutSettingsMessage
  | ToggleCommandBarBackgroundMessage;

export interface ChatClientEvent {
  type: typeof CLIENT_EVENT.CHAT;
  query: string;
  conversation_id?: string;
  active_tabs: ActiveTabSnapshot[];
  /** When set, this turn edits (re-generates) the named mod. */
  mod_id?: string;
}

export interface TabContentResponseClientEvent {
  type: typeof CLIENT_EVENT.TAB_CONTENT_RESPONSE;
  request_id: string;
  content: string;
}

export interface ConsoleLogsResponseClientEvent {
  type: typeof CLIENT_EVENT.CONSOLE_LOGS_RESPONSE;
  request_id: string;
  content: string;
}

export type ClientToServerEvent =
  | ChatClientEvent
  | TabContentResponseClientEvent
  | ConsoleLogsResponseClientEvent;

export interface ToolStatusEvent {
  type: typeof SERVER_EVENT.TOOL_START | typeof SERVER_EVENT.TOOL_END;
  name: string;
  args?: Record<string, unknown>;
}

export interface SandboxResult {
  passed: boolean;
  findings: string[];
  replay_url?: string;
}

export interface AgentPullRequest {
  pr_url?: string;
  url?: string;
  html_url?: string;
  title?: string;
}

export type AgentProvider = "devin" | "claude" | "nemotron";

export type ServerToClientEvent =
  | { type: typeof SERVER_EVENT.CONVERSATION_ID; conversation_id: string }
  | { type: typeof SERVER_EVENT.CONTENT; content: string }
  | ToolStatusEvent
  | { type: typeof SERVER_EVENT.THINKING }
  | {
      type: typeof SERVER_EVENT.AGENT_STATUS;
      provider: AgentProvider;
      phrase: string;
      status?: string;
      status_detail?: string;
      session_id?: string;
      session_url?: string;
      pull_requests?: AgentPullRequest[];
      active?: boolean;
    }
  | {
      type: typeof SERVER_EVENT.REQUEST_TAB_CONTENT;
      request_id: string;
      tab_id?: number;
      selector?: string;
      include_html?: boolean;
    }
  | {
      type: typeof SERVER_EVENT.REQUEST_CONSOLE_LOGS;
      request_id: string;
      tab_id?: number;
      level?: ConsoleLevel;
      since?: number;
    }
  | { type: typeof SERVER_EVENT.SANDBOX_START; target_url?: string }
  | { type: typeof SERVER_EVENT.SANDBOX_SCREENSHOT; url?: string; data?: string }
  | { type: typeof SERVER_EVENT.SANDBOX_RESULT; passed: boolean; findings?: string[]; replay_url?: string }
  | { type: typeof SERVER_EVENT.SANDBOX_HEALING; iteration: number; fix_summary?: string }
  | {
      type: typeof SERVER_EVENT.EXTENSION_READY;
      path: string;
      project_id?: string;
      bundles?: GeneratedBundle[];
    }
  | {
      type: typeof SERVER_EVENT.MODS_UPDATED;
      project_id?: string;
      mods: ModRecord[];
    }
  | { type: typeof SERVER_EVENT.CONVERSATION_TITLE; title: string }
  | { type: typeof SERVER_EVENT.RULES_UPDATED; rules: string[] }
  | { type: typeof SERVER_EVENT.DONE; conversation_id?: string; content?: string }
  | { type: typeof SERVER_EVENT.ERROR; message: string };

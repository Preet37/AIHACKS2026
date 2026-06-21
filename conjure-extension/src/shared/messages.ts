export const CONTENT_MESSAGE = {
  CONSOLE_EVENT: "conjure:console_event",
  GENERATED_MOD_ERROR: "conjure:generated_mod_error",
  GET_PAGE_CONTENT: "conjure:get_page_content",
  GET_ELEMENT_HTML: "conjure:get_element_html",
  VISUAL_EDIT_SELECTION: "conjure:visual_edit_selection",
  VISUAL_EDIT_PREVIEW: "conjure:visual_edit_preview",
  VISUAL_EDIT_COMMIT: "conjure:visual_edit_commit"
} as const;

export const PAGE_HOOK_SOURCE = "conjure-page-hook" as const;

export const BACKGROUND_MESSAGE = {
  GET_ACTIVE_TABS: "conjure:get_active_tabs",
  GET_CONSOLE_LOGS: "conjure:get_console_logs",
  RELOAD_ALL_TABS_ONCE: "conjure:reload_all_tabs_once",
  APPLY_MODS: "conjure:apply_mods",
  REMOVE_MOD: "conjure:remove_mod",
  START_VISUAL_EDIT: "conjure:start_visual_edit",
  STOP_VISUAL_EDIT: "conjure:stop_visual_edit",
  APPLY_VISUAL_EDIT: "conjure:apply_visual_edit",
  COMMIT_VISUAL_EDITS: "conjure:commit_visual_edits",
  DISCARD_VISUAL_EDITS: "conjure:discard_visual_edits"
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

export type VisualEditOperationType = "setText" | "setStyle" | "hide" | "setBox";

export interface VisualEditRect {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface VisualEditComputedStyle {
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  padding: string;
  margin: string;
  borderRadius: string;
  display: string;
  position: string;
  width: string;
  height: string;
  transform: string;
  opacity: string;
}

export interface VisualEditSelection {
  selector: string;
  text: string;
  tag: string;
  attributes: Record<string, string>;
  computedStyle: VisualEditComputedStyle;
  rect: VisualEditRect;
  url: string;
  editable: boolean;
  notEditableReason?: string;
  ownership: {
    conjureOwned: boolean;
    modId?: string;
    hints: string[];
  };
}

export type VisualEditOperation =
  | {
      id: string;
      type: "setText";
      selector: string;
      value: string;
      url?: string;
      stale?: boolean;
    }
  | {
      id: string;
      type: "setStyle";
      selector: string;
      styles: Partial<
        Pick<
          VisualEditComputedStyle,
          "color" | "backgroundColor" | "fontSize" | "padding" | "margin" | "borderRadius" | "opacity"
        >
      >;
      url?: string;
      stale?: boolean;
    }
  | {
      id: string;
      type: "hide";
      selector: string;
      hidden: boolean;
      url?: string;
      stale?: boolean;
    }
  | {
      id: string;
      type: "setBox";
      selector: string;
      box: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        fontScale?: number;
        sizing?: {
          width?: "fixed" | "hug";
          height?: "fixed" | "hug";
        };
        hug?: {
          left?: number;
          right?: number;
          top?: number;
          bottom?: number;
        };
      };
      url?: string;
      stale?: boolean;
    };

export interface VisualEditSessionState {
  active: boolean;
  modId?: string;
  selected?: VisualEditSelection;
  operations: VisualEditOperation[];
  undoDepth: number;
  redoDepth: number;
  staleOperationIds: string[];
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

export type GeneratedModErrorSource =
  | "sync"
  | "event_listener"
  | "timer"
  | "interval"
  | "animation_frame"
  | "promise_rejection";

export interface GeneratedModErrorPayload {
  projectId?: string;
  scriptId?: string;
  modId: string;
  modName: string;
  url: string;
  message: string;
  stack: string;
  source: GeneratedModErrorSource;
  line?: number;
  column?: number;
}

export interface GeneratedModErrorMessage {
  type: typeof CONTENT_MESSAGE.GENERATED_MOD_ERROR;
  payload: GeneratedModErrorPayload;
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
  visual_edits?: VisualEditOperation[];
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
  projectId?: string;
  bundles: GeneratedBundle[];
}

export interface RemoveModMessage {
  type: typeof BACKGROUND_MESSAGE.REMOVE_MOD;
  modId: string;
}

export interface StartVisualEditMessage {
  type: typeof BACKGROUND_MESSAGE.START_VISUAL_EDIT;
  tabId?: number;
  modId?: string;
  visualEdits?: VisualEditOperation[];
}

export interface StopVisualEditMessage {
  type: typeof BACKGROUND_MESSAGE.STOP_VISUAL_EDIT;
  tabId?: number;
}

export interface ApplyVisualEditMessage {
  type: typeof BACKGROUND_MESSAGE.APPLY_VISUAL_EDIT;
  tabId?: number;
  operation: VisualEditOperation;
}

export interface CommitVisualEditsMessage {
  type: typeof BACKGROUND_MESSAGE.COMMIT_VISUAL_EDITS;
  tabId?: number;
  operations: VisualEditOperation[];
}

export interface DiscardVisualEditsMessage {
  type: typeof BACKGROUND_MESSAGE.DISCARD_VISUAL_EDITS;
  tabId?: number;
}

export interface VisualEditSelectionMessage {
  type: typeof CONTENT_MESSAGE.VISUAL_EDIT_SELECTION;
  payload: VisualEditSelection;
}

export interface VisualEditPreviewMessage {
  type: typeof CONTENT_MESSAGE.VISUAL_EDIT_PREVIEW;
  payload: {
    ok: boolean;
    operation?: VisualEditOperation;
    staleOperationIds?: string[];
    error?: string;
  };
}

export interface VisualEditCommitMessage {
  type: typeof CONTENT_MESSAGE.VISUAL_EDIT_COMMIT;
  payload: {
    ok: boolean;
    operations: VisualEditOperation[];
    staleOperationIds?: string[];
    error?: string;
  };
}

export interface ApplyModsResult {
  applied: number;
  removed: number;
  reloaded: number;
}

export type RuntimeRequest =
  | ContentConsoleEventMessage
  | GeneratedModErrorMessage
  | VisualEditSelectionMessage
  | VisualEditPreviewMessage
  | VisualEditCommitMessage
  | GetPageContentMessage
  | GetElementHtmlMessage
  | GetActiveTabsMessage
  | GetConsoleLogsMessage
  | ReloadAllTabsOnceMessage
  | ApplyModsMessage
  | RemoveModMessage
  | StartVisualEditMessage
  | StopVisualEditMessage
  | ApplyVisualEditMessage
  | CommitVisualEditsMessage
  | DiscardVisualEditsMessage;

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

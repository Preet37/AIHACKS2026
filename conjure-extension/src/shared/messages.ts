export const CONTENT_MESSAGE = {
  CONSOLE_EVENT: "conjure:console_event",
  GET_PAGE_CONTENT: "conjure:get_page_content",
  GET_ELEMENT_HTML: "conjure:get_element_html"
} as const;

export const BACKGROUND_MESSAGE = {
  GET_ACTIVE_TABS: "conjure:get_active_tabs",
  GET_CONSOLE_LOGS: "conjure:get_console_logs",
  RELOAD_ALL_TABS_ONCE: "conjure:reload_all_tabs_once"
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

export type RuntimeRequest =
  | ContentConsoleEventMessage
  | GetPageContentMessage
  | GetElementHtmlMessage
  | GetActiveTabsMessage
  | GetConsoleLogsMessage
  | ReloadAllTabsOnceMessage;

export interface ChatClientEvent {
  type: typeof CLIENT_EVENT.CHAT;
  query: string;
  conversation_id?: string;
  active_tabs: ActiveTabSnapshot[];
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
  | { type: typeof SERVER_EVENT.EXTENSION_READY; path: string }
  | { type: typeof SERVER_EVENT.CONVERSATION_TITLE; title: string }
  | { type: typeof SERVER_EVENT.RULES_UPDATED; rules: string[] }
  | { type: typeof SERVER_EVENT.DONE; conversation_id?: string; content?: string }
  | { type: typeof SERVER_EVENT.ERROR; message: string };

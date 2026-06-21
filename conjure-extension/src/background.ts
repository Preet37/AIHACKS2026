import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "./shared/config";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  type ActiveTabSnapshot,
  type ConsoleLogEntry,
  type ConsoleLevel,
  type ContentConsoleEventMessage,
  type GetConsoleLogsMessage,
  type RuntimeRequest,
  type RuntimeResult
} from "./shared/messages";

const RELOAD_KEY = "conjure.tabsReloadedForContentHooks";
const consoleLogsByTab = new Map<number, ConsoleLogEntry[]>();

const initSentry = () => {
  if (!CONJURE_CONFIG.sentry.enabled) return;

  try {
    Sentry.init({
      dsn: CONJURE_CONFIG.sentry.dsn,
      environment: CONJURE_CONFIG.sentry.environment,
      release: CONJURE_CONFIG.sentry.release,
      tracesSampleRate: 0
    });
    Sentry.setTag("conjure.surface", "background");
  } catch {
    // Sentry is optional and must never break the extension surface.
  }
};

initSentry();

const captureException = (error: unknown) => {
  if (CONJURE_CONFIG.sentry.enabled) {
    Sentry.captureException(error);
  }
};

const makeId = () =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const activeTabSnapshot = (tab: chrome.tabs.Tab): ActiveTabSnapshot | null => {
  if (typeof tab.id !== "number") return null;

  return {
    id: tab.id,
    title: tab.title || "Untitled",
    url: tab.url || "",
    active: Boolean(tab.active),
    windowId: tab.windowId
  };
};

const appendConsoleLog = (
  message: ContentConsoleEventMessage,
  sender: chrome.runtime.MessageSender
): RuntimeResult<ConsoleLogEntry> => {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false, error: "Console event did not include a tab id." };
  }

  const entry: ConsoleLogEntry = {
    ...message.payload,
    id: message.payload.id || makeId(),
    tabId,
    frameId: sender.frameId
  };

  const buffer = consoleLogsByTab.get(tabId) || [];
  buffer.push(entry);

  if (buffer.length > CONJURE_CONFIG.consoleRingLimit) {
    buffer.splice(0, buffer.length - CONJURE_CONFIG.consoleRingLimit);
  }

  consoleLogsByTab.set(tabId, buffer);
  return { ok: true, data: entry };
};

const getConsoleLogs = (message: GetConsoleLogsMessage): RuntimeResult<ConsoleLogEntry[]> => {
  const tabs =
    typeof message.tabId === "number"
      ? [[message.tabId, consoleLogsByTab.get(message.tabId) || []] as const]
      : Array.from(consoleLogsByTab.entries());

  const levels = new Set<ConsoleLevel>(message.level ? [message.level] : []);
  const logs = tabs
    .flatMap(([, entries]) => entries)
    .filter((entry) => !message.since || entry.timestamp >= message.since)
    .filter((entry) => levels.size === 0 || levels.has(entry.level))
    .sort((a, b) => a.timestamp - b.timestamp);

  const limit = message.limit || 200;
  return { ok: true, data: logs.slice(Math.max(0, logs.length - limit)) };
};

const getActiveTabs = async (): Promise<RuntimeResult<ActiveTabSnapshot[]>> => {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    data: tabs
      .map(activeTabSnapshot)
      .filter((tab): tab is ActiveTabSnapshot => Boolean(tab))
  };
};

const reloadAllTabsOnce = async (): Promise<RuntimeResult<{ reloaded: boolean; count: number }>> => {
  const stored = await chrome.storage.local.get(RELOAD_KEY);
  if (stored[RELOAD_KEY]) {
    return { ok: true, data: { reloaded: false, count: 0 } };
  }

  const tabs = await chrome.tabs.query({});
  const reloadable = tabs.filter(
    (tab) => typeof tab.id === "number" && /^https?:\/\//.test(tab.url || "")
  );

  await Promise.allSettled(reloadable.map((tab) => chrome.tabs.reload(tab.id as number)));
  await chrome.storage.local.set({ [RELOAD_KEY]: true });

  return { ok: true, data: { reloaded: true, count: reloadable.length } };
};

const handleRuntimeMessage = async (
  message: RuntimeRequest,
  sender: chrome.runtime.MessageSender
): Promise<RuntimeResult<unknown>> => {
  switch (message.type) {
    case CONTENT_MESSAGE.CONSOLE_EVENT:
      return appendConsoleLog(message, sender);
    case BACKGROUND_MESSAGE.GET_CONSOLE_LOGS:
      return getConsoleLogs(message);
    case BACKGROUND_MESSAGE.GET_ACTIVE_TABS:
      return getActiveTabs();
    case BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE:
      return reloadAllTabsOnce();
    default:
      return { ok: false, error: "Unsupported runtime message." };
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(captureException);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(captureException);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleLogsByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      captureException(error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

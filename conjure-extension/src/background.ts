import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG, createModAgentUrl, createModsBundleUrl } from "./shared/config";
import { appendDiagnosticLog } from "./shared/diagnosticLogs";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  type ActiveTabSnapshot,
  type ApplyModsMessage,
  type ApplyModsResult,
  type ConsoleLogEntry,
  type ConsoleLevel,
  type ContentConsoleEventMessage,
  type GeneratedBundle,
  type GetConsoleLogsMessage,
  type ModAgentActionMessage,
  type RemoveModMessage,
  type RuntimeRequest,
  type RuntimeResult
} from "./shared/messages";

const RELOADED_CURRENT_TABS_KEY = "conjure.currentTabsReloadedForContentHooks";
const MOD_FINGERPRINTS_KEY = "conjure.modFingerprints";
const MOD_SCRIPT_PREFIX = "conjure-mod-";
const consoleLogsByTab = new Map<number, ConsoleLogEntry[]>();
const modAgentRequestsByTab = new Map<number, Promise<RuntimeResult<{ result: string }>>>();
const SUPPORTED_MOD_AGENT_ACTIONS = new Set(["explain-page", "send-hello-email"]);
let modSyncRequest: Promise<RuntimeResult<ApplyModsResult>> | null = null;

// chrome.userScripts is only present when the user has enabled developer mode
// (or the per-extension "Allow user scripts" toggle). Access it defensively so
// the rest of the worker keeps running when it is unavailable.
type UserScriptsApi = {
  register: (scripts: unknown[]) => Promise<void>;
  unregister: (filter: { ids: string[] }) => Promise<void>;
  getScripts: (filter?: { ids?: string[] }) => Promise<Array<{ id: string; matches?: string[] }>>;
  configureWorld?: (props: Record<string, unknown>) => Promise<void>;
};

const getUserScriptsApi = (): UserScriptsApi | undefined =>
  (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;

const modScriptId = (modId: string) => `${MOD_SCRIPT_PREFIX}${modId}`;

const bundleFingerprint = (bundle: GeneratedBundle): string => {
  const input = JSON.stringify([bundle.matches, bundle.run_at, bundle.js, bundle.css]);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const VALID_RUN_AT = new Set(["document_start", "document_end", "document_idle"]);

const currentTabMatchPattern = async (): Promise<string | null> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url || "");
    return ["http:", "https:"].includes(url.protocol)
      ? `${url.protocol}//${url.hostname}/*`
      : null;
  } catch {
    return null;
  }
};

const userScriptsUnavailableError =
  "Conjure can't auto-apply yet. Open chrome://extensions, find Conjure, and turn on " +
  "“Allow user scripts” (or enable Developer mode), then reload Conjure.";

/**
 * Build a single self-contained user-script string from the generated bundle.
 * The CSS is embedded as a JSON literal and injected as a <style> element, then
 * the generated JS runs. Both pieces are produced by the agent.
 */
const buildUserScriptCode = (bundle: GeneratedBundle, scriptId: string): string => {
  const cssLiteral = JSON.stringify(bundle.css || "");
  const idLiteral = JSON.stringify(scriptId);
  return [
    "(function () {",
    `  var __conjureCss = ${cssLiteral};`,
    "  if (__conjureCss && __conjureCss.trim()) {",
    "    var __existing = document.querySelector('style[data-conjure=' + JSON.stringify(" + idLiteral + ") + ']');",
    "    if (!__existing) {",
    "      var __style = document.createElement('style');",
    `      __style.setAttribute('data-conjure', ${idLiteral});`,
    "      __style.textContent = __conjureCss;",
    "      (document.head || document.documentElement).appendChild(__style);",
    "    }",
    "  }",
    "})();",
    bundle.js || ""
  ].join("\n");
};

const reloadCurrentMatchingTab = async (matches: string[]): Promise<number> => {
  const patterns = matches.filter((pattern) => pattern && pattern !== "<all_urls>");
  const matchesAllUrls = matches.includes("<all_urls>");
  if (patterns.length === 0 && !matchesAllUrls) return 0;
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      ...(!matchesAllUrls && patterns.length > 0 ? { url: patterns } : {})
    });
    const current = tabs.find(
      (tab) => typeof tab.id === "number" && /^https?:\/\//.test(tab.url || "")
    );
    if (typeof current?.id !== "number") return 0;
    await chrome.tabs.reload(current.id);
    return 1;
  } catch {
    return 0;
  }
};

/** Unregister every previously-registered mod script that is no longer present. */
const unregisterStaleMods = async (
  userScripts: UserScriptsApi,
  keepIds: Set<string>
): Promise<number> => {
  let removed = 0;
  try {
    const registered = await userScripts.getScripts();
    const stale = registered
      .map((script) => script.id)
      .filter((id) => id.startsWith(MOD_SCRIPT_PREFIX) && !keepIds.has(id));
    for (const id of stale) {
      await userScripts.unregister({ ids: [id] });
      removed += 1;
    }
  } catch {
    // best effort
  }
  return removed;
};

/** Register/refresh one mod as a persistent user script. */
const registerMod = async (
  userScripts: UserScriptsApi,
  bundle: GeneratedBundle,
  fingerprints: Record<string, string>
): Promise<boolean> => {
  if (!bundle.mod_id || !bundle.matches?.length) return false;
  const scriptId = modScriptId(bundle.mod_id);
  const runAt = VALID_RUN_AT.has(bundle.run_at) ? bundle.run_at : "document_idle";
  const existing = await userScripts.getScripts({ ids: [scriptId] });
  const fingerprint = bundleFingerprint(bundle);
  const sameMatches =
    existing.length > 0 &&
    JSON.stringify(existing[0].matches || []) === JSON.stringify(bundle.matches);
  if (sameMatches && fingerprints[scriptId] === fingerprint) return false;
  if (existing.length > 0) {
    await userScripts.unregister({ ids: [scriptId] });
  }
  await userScripts.register([
    {
      id: scriptId,
      matches: bundle.matches,
      js: [{ code: buildUserScriptCode(bundle, scriptId) }],
      runAt,
      world: "USER_SCRIPT"
    }
  ]);
  fingerprints[scriptId] = fingerprint;
  return true;
};

/**
 * Apply the full set of active mods: register/refresh each, unregister any that
 * disappeared, and reload the current tab when affected so changes show immediately.
 */
const applyMods = async (message: ApplyModsMessage): Promise<RuntimeResult<ApplyModsResult>> => {
  const userScripts = getUserScriptsApi();
  if (!userScripts) {
    return { ok: false, error: userScriptsUnavailableError };
  }

  const currentMatch = await currentTabMatchPattern();
  const bundles = (message.bundles || [])
    .filter((bundle) => bundle.mod_id)
    .map((bundle) =>
      bundle.scope_mode === "current_tab" && currentMatch
        ? { ...bundle, matches: [currentMatch] }
        : bundle
    );
  const keepIds = new Set(bundles.map((bundle) => modScriptId(bundle.mod_id as string)));
  const stored = await chrome.storage.local.get(MOD_FINGERPRINTS_KEY);
  const fingerprints =
    stored[MOD_FINGERPRINTS_KEY] && typeof stored[MOD_FINGERPRINTS_KEY] === "object"
      ? { ...(stored[MOD_FINGERPRINTS_KEY] as Record<string, string>) }
      : {};

  let applied = 0;
  const matchesToReload = new Set<string>();
  try {
    for (const bundle of bundles) {
      if (await registerMod(userScripts, bundle, fingerprints)) {
        applied += 1;
        bundle.matches.forEach((pattern) => matchesToReload.add(pattern));
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const removed = await unregisterStaleMods(userScripts, keepIds);
  Object.keys(fingerprints).forEach((id) => {
    if (!keepIds.has(id)) delete fingerprints[id];
  });
  await chrome.storage.local.set({ [MOD_FINGERPRINTS_KEY]: fingerprints });
  const reloaded = await reloadCurrentMatchingTab([...matchesToReload]);
  return { ok: true, data: { applied, removed, reloaded } };
};

const syncModsFromBackend = (): Promise<RuntimeResult<ApplyModsResult>> => {
  if (modSyncRequest) return modSyncRequest;
  modSyncRequest = (async () => {
    try {
      const response = await fetch(createModsBundleUrl(CONJURE_CONFIG.projectId), {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Mod bundle endpoint returned ${response.status}.`);
      }
      const body = (await response.json()) as { bundles?: GeneratedBundle[] };
      return await applyMods({
        type: BACKGROUND_MESSAGE.APPLY_MODS,
        bundles: body.bundles || []
      });
    } catch (error) {
      appendDiagnosticLog("Mod sync", error).catch(captureException);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      modSyncRequest = null;
    }
  })();
  return modSyncRequest;
};

/** Remove a single mod's user script (the backend deletes its files separately). */
const removeMod = async (message: RemoveModMessage): Promise<RuntimeResult<{ removed: boolean }>> => {
  const userScripts = getUserScriptsApi();
  if (!userScripts) {
    return { ok: false, error: userScriptsUnavailableError };
  }
  const scriptId = modScriptId(message.modId);
  let reloadMatches: string[] = [];
  try {
    const existing = await userScripts.getScripts({ ids: [scriptId] });
    const found = existing.find((script) => script.id === scriptId) as
      | { matches?: string[] }
      | undefined;
    reloadMatches = found?.matches || [];
    if (existing.length > 0) {
      await userScripts.unregister({ ids: [scriptId] });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await reloadCurrentMatchingTab(reloadMatches);
  return { ok: true, data: { removed: true } };
};

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

// API keys live in chrome.storage.local for persistence, but content scripts do
// not need storage access. Keep credentials available only to trusted extension
// pages (the side panel and service worker).
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(captureException);

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

const getCurrentTab = async (): Promise<RuntimeResult<ActiveTabSnapshot[]>> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    ok: true,
    data: tabs
      .map(activeTabSnapshot)
      .filter((tab): tab is ActiveTabSnapshot => Boolean(tab))
  };
};

const reloadCurrentTabOnce = async (): Promise<RuntimeResult<{ reloaded: boolean; count: number }>> => {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof current?.id !== "number" || !/^https?:\/\//.test(current.url || "")) {
    return { ok: true, data: { reloaded: false, count: 0 } };
  }

  const stored = await chrome.storage.local.get(RELOADED_CURRENT_TABS_KEY);
  const reloadedTabIds = Array.isArray(stored[RELOADED_CURRENT_TABS_KEY])
    ? (stored[RELOADED_CURRENT_TABS_KEY] as unknown[]).filter(
        (tabId): tabId is number => typeof tabId === "number"
      )
    : [];
  if (reloadedTabIds.includes(current.id)) {
    return { ok: true, data: { reloaded: false, count: 0 } };
  }

  await chrome.tabs.reload(current.id);
  await chrome.storage.local.set({
    [RELOADED_CURRENT_TABS_KEY]: [...reloadedTabIds, current.id].slice(-100)
  });

  return { ok: true, data: { reloaded: true, count: 1 } };
};

const runModAgentAction = async (
  message: ModAgentActionMessage,
  sender: chrome.runtime.MessageSender
): Promise<RuntimeResult<{ result: string }>> => {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || !SUPPORTED_MOD_AGENT_ACTIONS.has(message.action)) {
    return { ok: false, error: "Agent actions must come from a supported page control." };
  }
  const pending = modAgentRequestsByTab.get(tabId);
  if (pending) return pending;

  const request = (async (): Promise<RuntimeResult<{ result: string }>> => {
    try {
      const cookies = await chrome.cookies.getAll({
        url: message.action === "send-hello-email" ? "https://mail.google.com/" : message.url
      });
      const response = await fetch(createModAgentUrl(CONJURE_CONFIG.projectId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: message.action,
          url: message.url.slice(0, 2000),
          cookies
        })
      });
      const body = (await response.json()) as { result?: string; detail?: string };
      if (!response.ok || !body.result) {
        throw new Error(body.detail || `Agent endpoint returned ${response.status}.`);
      }
      return { ok: true, data: { result: body.result } };
    } catch (error) {
      appendDiagnosticLog("Mod agent", error).catch(captureException);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  modAgentRequestsByTab.set(tabId, request);
  try {
    return await request;
  } finally {
    modAgentRequestsByTab.delete(tabId);
  }
};

const handleRuntimeMessage = async (
  message: RuntimeRequest,
  sender: chrome.runtime.MessageSender
): Promise<RuntimeResult<unknown>> => {
  switch (message.type) {
    case CONTENT_MESSAGE.CONSOLE_EVENT:
      return appendConsoleLog(message, sender);
    case CONTENT_MESSAGE.SYNC_MODS:
      return syncModsFromBackend();
    case CONTENT_MESSAGE.AGENT_ACTION:
      return runModAgentAction(message, sender);
    case BACKGROUND_MESSAGE.GET_CONSOLE_LOGS:
      return getConsoleLogs(message);
    case BACKGROUND_MESSAGE.GET_CURRENT_TAB:
      return getCurrentTab();
    case BACKGROUND_MESSAGE.RELOAD_CURRENT_TAB_ONCE:
      return reloadCurrentTabOnce();
    case BACKGROUND_MESSAGE.APPLY_MODS:
      return applyMods(message as ApplyModsMessage);
    case BACKGROUND_MESSAGE.REMOVE_MOD:
      return removeMod(message as RemoveModMessage);
    default:
      return { ok: false, error: "Unsupported runtime message." };
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(captureException);
  void syncModsFromBackend();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(captureException);
  void syncModsFromBackend();
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

// Extension reloads start a fresh worker even when onInstalled/onStartup do not fire.
void syncModsFromBackend();

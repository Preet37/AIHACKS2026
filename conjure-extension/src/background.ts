import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "./shared/config";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  type ActiveTabSnapshot,
  type ApplyModsMessage,
  type ApplyModsResult,
  type ApplyVisualEditMessage,
  type CommitVisualEditsMessage,
  type ConsoleLogEntry,
  type ConsoleLevel,
  type ContentConsoleEventMessage,
  type DiscardVisualEditsMessage,
  type GeneratedBundle,
  type GetConsoleLogsMessage,
  type RemoveModMessage,
  type RuntimeRequest,
  type RuntimeResult,
  type StartVisualEditMessage,
  type StopVisualEditMessage
} from "./shared/messages";

const RELOAD_KEY = "conjure.tabsReloadedForContentHooks";
const MOD_SCRIPT_PREFIX = "conjure-mod-";
const consoleLogsByTab = new Map<number, ConsoleLogEntry[]>();

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

const VALID_RUN_AT = new Set(["document_start", "document_end", "document_idle"]);

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
  const modIdLiteral = JSON.stringify(bundle.mod_id || scriptId);
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
    "(function () {",
    `  var __conjureModId = ${modIdLiteral};`,
    "  var __conjureCounter = 0;",
    "  var __originalCreateElement = document.createElement.bind(document);",
    "  var __originalCreateElementNS = document.createElementNS.bind(document);",
    "  var __tagNode = function (node) {",
    "    try {",
    "      if (!__conjureModId || !node) return node;",
    "      var nodes = [];",
    "      if (node.nodeType === 1) nodes.push(node);",
    "      if (node.nodeType === 11 || node.nodeType === 1) {",
    "        var children = node.querySelectorAll ? node.querySelectorAll('*') : [];",
    "        for (var index = 0; index < children.length; index += 1) nodes.push(children[index]);",
    "      }",
    "      for (var itemIndex = 0; itemIndex < nodes.length; itemIndex += 1) {",
    "        var element = nodes[itemIndex];",
    "        if (!element.setAttribute) continue;",
    "        if (!element.hasAttribute('data-conjure-mod-id')) {",
    "          element.setAttribute('data-conjure-mod-id', __conjureModId);",
    "        }",
    "        if (!element.hasAttribute('data-conjure-owned')) {",
    "          element.setAttribute('data-conjure-owned', 'true');",
    "        }",
    "        if (!element.hasAttribute('data-conjure-element-id')) {",
    "          __conjureCounter += 1;",
    "          element.setAttribute('data-conjure-element-id', __conjureModId + '-' + __conjureCounter);",
    "        }",
    "      }",
    "    } catch (_error) {",
    "      return node;",
    "    }",
    "    return node;",
    "  };",
    "  window.__CONJURE_TAG_DOM_NODE__ = __tagNode;",
    "  window.__CONJURE_INSTALL_DOM_TAG_OBSERVER__ = function () {",
    "    if (typeof MutationObserver === 'undefined') return;",
    "    var root = document.documentElement || document.body;",
    "    if (!root) return;",
    "    var observer = new MutationObserver(function (mutations) {",
    "      for (var mutationIndex = 0; mutationIndex < mutations.length; mutationIndex += 1) {",
    "        var mutation = mutations[mutationIndex];",
    "        var target = mutation.target;",
    "        var ownedTarget = target && target.closest ? target.closest('[data-conjure-mod-id=\"' + __conjureModId + '\"]') : null;",
    "        if (!ownedTarget) continue;",
    "        for (var nodeIndex = 0; nodeIndex < mutation.addedNodes.length; nodeIndex += 1) {",
    "          __tagNode(mutation.addedNodes[nodeIndex]);",
    "        }",
    "      }",
    "    });",
    "    observer.observe(root, { childList: true, subtree: true });",
    "  };",
    "  document.createElement = function () {",
    "    return __tagNode(__originalCreateElement.apply(document, arguments));",
    "  };",
    "  document.createElementNS = function () {",
    "    return __tagNode(__originalCreateElementNS.apply(document, arguments));",
    "  };",
    "  window.__CONJURE_RESTORE_DOM_TAGGING__ = function () {",
    "    document.createElement = __originalCreateElement;",
    "    document.createElementNS = __originalCreateElementNS;",
    "    delete window.__CONJURE_RESTORE_DOM_TAGGING__;",
    "    delete window.__CONJURE_TAG_DOM_NODE__;",
    "    delete window.__CONJURE_INSTALL_DOM_TAG_OBSERVER__;",
    "  };",
    "  window.setTimeout(function () {",
    "    if (window.__CONJURE_RESTORE_DOM_TAGGING__) window.__CONJURE_RESTORE_DOM_TAGGING__();",
    "  }, 1000);",
    "})();",
    bundle.js || "",
    "(function () {",
    `  var __conjureModId = ${modIdLiteral};`,
    "  var __tagNode = window.__CONJURE_TAG_DOM_NODE__;",
    "  if (__tagNode) {",
    "    var __owned = document.querySelectorAll('[data-conjure-mod-id]');",
    "    for (var __index = 0; __index < __owned.length; __index += 1) {",
    "      if (__owned[__index].getAttribute('data-conjure-mod-id') === __conjureModId) {",
    "        __tagNode(__owned[__index]);",
    "      }",
    "    }",
    "  }",
    "  if (window.__CONJURE_INSTALL_DOM_TAG_OBSERVER__) window.__CONJURE_INSTALL_DOM_TAG_OBSERVER__();",
    "  if (window.__CONJURE_RESTORE_DOM_TAGGING__) window.__CONJURE_RESTORE_DOM_TAGGING__();",
    "})();"
  ].join("\n");
};

const reloadMatchingTabs = async (matches: string[]): Promise<number> => {
  const patterns = matches.filter((pattern) => pattern && pattern !== "<all_urls>");
  if (patterns.length === 0) return 0;
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    const reloadable = tabs.filter((tab) => typeof tab.id === "number");
    await Promise.allSettled(reloadable.map((tab) => chrome.tabs.reload(tab.id as number)));
    return reloadable.length;
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
const registerMod = async (userScripts: UserScriptsApi, bundle: GeneratedBundle): Promise<boolean> => {
  if (!bundle.mod_id || !bundle.matches?.length) return false;
  const scriptId = modScriptId(bundle.mod_id);
  const runAt = VALID_RUN_AT.has(bundle.run_at) ? bundle.run_at : "document_idle";
  const existing = await userScripts.getScripts({ ids: [scriptId] });
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
  return true;
};

/**
 * Apply the full set of active mods: register/refresh each, unregister any that
 * disappeared, and reload affected tabs so changes show immediately.
 */
const applyMods = async (message: ApplyModsMessage): Promise<RuntimeResult<ApplyModsResult>> => {
  const userScripts = getUserScriptsApi();
  if (!userScripts) {
    return { ok: false, error: userScriptsUnavailableError };
  }

  const bundles = (message.bundles || []).filter((bundle) => bundle.mod_id);
  const keepIds = new Set(bundles.map((bundle) => modScriptId(bundle.mod_id as string)));

  let applied = 0;
  const matchesToReload = new Set<string>();
  try {
    for (const bundle of bundles) {
      if (await registerMod(userScripts, bundle)) {
        applied += 1;
        bundle.matches.forEach((pattern) => matchesToReload.add(pattern));
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const removed = await unregisterStaleMods(userScripts, keepIds);
  const reloaded = await reloadMatchingTabs([...matchesToReload]);
  return { ok: true, data: { applied, removed, reloaded } };
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
  await reloadMatchingTabs(reloadMatches);
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

type VisualEditForwardMessage =
  | StartVisualEditMessage
  | StopVisualEditMessage
  | ApplyVisualEditMessage
  | CommitVisualEditsMessage
  | DiscardVisualEditsMessage;

const activeTabId = async (): Promise<number | undefined> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find((tab) => typeof tab.id === "number")?.id;
};

const forwardVisualEditMessage = async (
  message: VisualEditForwardMessage
): Promise<RuntimeResult<unknown>> => {
  const tabId = message.tabId ?? (await activeTabId());
  if (typeof tabId !== "number") {
    return { ok: false, error: "No active tab available for visual editing." };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response || { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
    case CONTENT_MESSAGE.VISUAL_EDIT_SELECTION:
    case CONTENT_MESSAGE.VISUAL_EDIT_PREVIEW:
    case CONTENT_MESSAGE.VISUAL_EDIT_COMMIT:
      return { ok: true, data: null };
    case BACKGROUND_MESSAGE.GET_CONSOLE_LOGS:
      return getConsoleLogs(message);
    case BACKGROUND_MESSAGE.GET_ACTIVE_TABS:
      return getActiveTabs();
    case BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE:
      return reloadAllTabsOnce();
    case BACKGROUND_MESSAGE.APPLY_MODS:
      return applyMods(message as ApplyModsMessage);
    case BACKGROUND_MESSAGE.REMOVE_MOD:
      return removeMod(message as RemoveModMessage);
    case BACKGROUND_MESSAGE.START_VISUAL_EDIT:
    case BACKGROUND_MESSAGE.STOP_VISUAL_EDIT:
    case BACKGROUND_MESSAGE.APPLY_VISUAL_EDIT:
    case BACKGROUND_MESSAGE.COMMIT_VISUAL_EDITS:
    case BACKGROUND_MESSAGE.DISCARD_VISUAL_EDITS:
      return forwardVisualEditMessage(message as VisualEditForwardMessage);
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

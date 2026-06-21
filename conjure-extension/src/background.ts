import * as Sentry from "@sentry/browser";
import { buildGeneratedModUserScriptCode } from "./generatedModWrapper";
import { CONJURE_CONFIG } from "./shared/config";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  type ActiveTabSnapshot,
  type ApplyModsMessage,
  type ApplyModsResult,
  type ApplyVisualEditMessage,
  type CommitVisualEditsMessage,
  type CommandShortcutInfo,
  type ConsoleLogEntry,
  type ConsoleLevel,
  type ContentConsoleEventMessage,
  type DiscardVisualEditsMessage,
  type GeneratedBundle,
  type GeneratedModErrorMessage,
  type GeneratedModErrorPayload,
  type GeneratedModErrorSource,
  type GetConsoleLogsMessage,
  type OpenDesignTabMessage,
  type OpenSettingsTabMessage,
  type OpenTraceTabMessage,
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

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

type RuntimeUserScriptMessageEvent = {
  addListener: (listener: RuntimeMessageListener) => void;
};

const getUserScriptsApi = (): UserScriptsApi | undefined =>
  (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;

const getUserScriptMessageEvent = (): RuntimeUserScriptMessageEvent | undefined =>
  (chrome.runtime as unknown as { onUserScriptMessage?: RuntimeUserScriptMessageEvent })
    .onUserScriptMessage;

const modScriptId = (modId: string) => `${MOD_SCRIPT_PREFIX}${modId}`;

const VALID_RUN_AT = new Set(["document_start", "document_end", "document_idle"]);

const userScriptsUnavailableError =
  "Conjure can't auto-apply yet. Open chrome://extensions, find Conjure, and turn on " +
  "“Allow user scripts” (or enable Developer mode), then reload Conjure.";

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

const configureUserScriptsMessaging = async (userScripts: UserScriptsApi): Promise<void> => {
  if (!userScripts.configureWorld) return;
  try {
    await userScripts.configureWorld({ messaging: true });
  } catch {
    // Messaging is preferred, but the postMessage bridge keeps reporting best effort.
  }
};

/** Register/refresh one mod as a persistent user script. */
const registerMod = async (
  userScripts: UserScriptsApi,
  bundle: GeneratedBundle,
  projectId?: string
): Promise<boolean> => {
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
      js: [{ code: buildGeneratedModUserScriptCode({ bundle, projectId, scriptId }) }],
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
  const projectId = message.projectId || CONJURE_CONFIG.projectId;

  let applied = 0;
  const matchesToReload = new Set<string>();
  try {
    await configureUserScriptsMessaging(userScripts);
    for (const bundle of bundles) {
      if (await registerMod(userScripts, bundle, projectId)) {
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
    try {
      Sentry.captureException(error);
    } catch {
      // Sentry is optional and must never break extension behavior.
    }
  }
};

const generatedModErrorSources = new Set<GeneratedModErrorSource>([
  "sync",
  "event_listener",
  "timer",
  "interval",
  "animation_frame",
  "promise_rejection"
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");

const tagValue = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown";

const normalizeGeneratedModErrorPayload = (
  payload: unknown,
  sender: chrome.runtime.MessageSender
): GeneratedModErrorPayload | null => {
  if (!isRecord(payload)) return null;

  const source = stringValue(payload.source);
  if (!generatedModErrorSources.has(source as GeneratedModErrorSource)) return null;

  const modId = stringValue(payload.modId);
  if (!modId) return null;

  const normalized: GeneratedModErrorPayload = {
    projectId: stringValue(payload.projectId) || CONJURE_CONFIG.projectId,
    scriptId: stringValue(payload.scriptId) || modScriptId(modId),
    modId,
    modName: stringValue(payload.modName) || "Conjure customization",
    url: stringValue(payload.url) || sender.url || sender.tab?.url || "",
    message: stringValue(payload.message) || "Generated mod error",
    stack: stringValue(payload.stack),
    source: source as GeneratedModErrorSource
  };

  if (typeof payload.line === "number" && Number.isFinite(payload.line)) {
    normalized.line = payload.line;
  }
  if (typeof payload.column === "number" && Number.isFinite(payload.column)) {
    normalized.column = payload.column;
  }

  return normalized;
};

const generatedModErrorFromPayload = (payload: GeneratedModErrorPayload): Error => {
  const error = new Error(payload.message);
  error.name = "GeneratedModError";
  if (payload.stack) {
    try {
      error.stack = payload.stack;
    } catch {
      // Some runtimes expose a readonly stack; the message still groups usefully.
    }
  }
  return error;
};

const captureGeneratedModError = (
  message: GeneratedModErrorMessage,
  sender: chrome.runtime.MessageSender
): RuntimeResult<null> => {
  const payload = normalizeGeneratedModErrorPayload(message.payload, sender);
  if (!payload) {
    return { ok: false, error: "Invalid generated mod error payload." };
  }

  if (!CONJURE_CONFIG.sentry.enabled) {
    return { ok: true, data: null };
  }

  const error = generatedModErrorFromPayload(payload);
  try {
    Sentry.captureException(error, {
      tags: {
        "conjure.surface": "generated_mod",
        "conjure.project_id": tagValue(payload.projectId || CONJURE_CONFIG.projectId),
        "conjure.mod_id": tagValue(payload.modId),
        "conjure.mod_name": tagValue(payload.modName),
        "conjure.error_source": tagValue(payload.source)
      },
      extra: {
        page_url: payload.url,
        script_id: payload.scriptId,
        run_source: payload.source,
        line: payload.line,
        column: payload.column,
        tab_id: sender.tab?.id,
        frame_id: sender.frameId
      }
    });
  } catch {
    // Keep generated mods running even if Sentry capture fails.
  }

  return { ok: true, data: null };
};

const isRuntimeAvailable = () => {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
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

const openExtensionTab = async (page: "design.html" | "run.html"): Promise<RuntimeResult<{ opened: boolean }>> => {
  if (!isRuntimeAvailable()) return { ok: false, error: "Extension runtime is unavailable." };
  await chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  return { ok: true, data: { opened: true } };
};

const openSettingsTab = async (): Promise<RuntimeResult<{ opened: boolean }>> => {
  if (!isRuntimeAvailable()) return { ok: false, error: "Extension runtime is unavailable." };
  await chrome.runtime.openOptionsPage();
  return { ok: true, data: { opened: true } };
};

const getCommandShortcuts = async (): Promise<RuntimeResult<CommandShortcutInfo[]>> => {
  if (!isRuntimeAvailable() || !chrome.commands?.getAll) {
    return { ok: false, error: "Command shortcuts are unavailable." };
  }
  const commands = await chrome.commands.getAll();
  return {
    ok: true,
    data: commands
      .filter((command): command is chrome.commands.Command & { name: string } => typeof command.name === "string")
      .map(({ name, description, shortcut }) => ({ name, description, shortcut }))
  };
};

const openShortcutSettings = async (): Promise<RuntimeResult<{ opened: boolean; url: string }>> => {
  const url = "chrome://extensions/shortcuts";
  if (!isRuntimeAvailable()) return { ok: false, error: "Extension runtime is unavailable." };
  try {
    await chrome.tabs.create({ url });
    return { ok: true, data: { opened: true, url } };
  } catch {
    return { ok: false, error: `Open ${url} manually.` };
  }
};

const isInjectableTab = (tab?: chrome.tabs.Tab) =>
  typeof tab?.id === "number" && /^https?:\/\//.test(tab.url || "");

const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return typeof tab?.id === "number" ? tab : undefined;
};

const getCommandTargetTab = async (sender?: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab | undefined> => {
  if (isInjectableTab(sender?.tab)) return sender?.tab;

  const active = await getActiveTab();
  if (isInjectableTab(active)) return active;

  const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });
  const currentWindowTarget = currentWindowTabs
    .filter(isInjectableTab)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (currentWindowTarget) return currentWindowTarget;

  const allTabs = await chrome.tabs.query({});
  return allTabs
    .filter(isInjectableTab)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
};

const openSidePanelFallback = async (tab?: chrome.tabs.Tab) => {
  try {
    if (typeof tab?.windowId === "number") {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    // Best-effort fallback for restricted pages.
  }
};

const ensureContentScript = async (tabId: number) => {
  try {
    const loader = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
    if (!loader) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [loader]
    });
  } catch {
    // Static content-script registration is the primary path. This best-effort
    // injection only helps already-open tabs after an extension reload.
  }
};

const toggleCommandBar = async (
  sender?: chrome.runtime.MessageSender
): Promise<RuntimeResult<{ delivered: boolean; fallback: boolean; tabId?: number }>> => {
  if (!isRuntimeAvailable()) return { ok: false, error: "Extension runtime is unavailable." };
  const tab = await getCommandTargetTab(sender);
  if (typeof tab?.id !== "number") {
    return { ok: false, error: "No normal webpage tab is available for the command overlay." };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: CONTENT_MESSAGE.TOGGLE_COMMAND_BAR });
    return { ok: true, data: { delivered: true, fallback: false, tabId: tab.id } };
  } catch {
    await ensureContentScript(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: CONTENT_MESSAGE.TOGGLE_COMMAND_BAR });
      return { ok: true, data: { delivered: true, fallback: false, tabId: tab.id } };
    } catch {
      await openSidePanelFallback(tab);
      return { ok: true, data: { delivered: false, fallback: true, tabId: tab.id } };
    }
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

/**
 * Voice capture via tab injection (Wispr-Flow push-to-talk).
 *
 * The side panel can't reliably getUserMedia on macOS, so we inject a recorder
 * into the active web tab — which already holds mic permission. Hold Alt/Option
 * to start, release to stop + transcribe. Amplitude streams back to the panel
 * via VOICE_AMPLITUDE broadcasts for the live waveform.
 */
const getActiveWebTabId = async (): Promise<number | null> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => /^https?:\/\//.test(t.url || ""));
  return typeof tab?.id === "number" ? tab.id : null;
};

type InjectedStartResult = { ok: true; mimeType: string } | { ok: false; error: string };
type InjectedStopResult = { ok: true; transcript: string } | { ok: false; error: string };

const handleVoiceStart = async (): Promise<RuntimeResult<{ started: boolean }>> => {
  const tabId = await getActiveWebTabId();
  if (tabId === null) {
    return { ok: false, error: "No active web page — open a website first, then try voice." };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (): Promise<InjectedStartResult> => {
        const w = window as Window & {
          __cqStream?: MediaStream;
          __cqRecorder?: MediaRecorder;
          __cqChunks?: Blob[];
          __cqAmpTimer?: ReturnType<typeof setInterval>;
          __cqAudioCtx?: AudioContext;
        };
        if (w.__cqAmpTimer !== undefined) clearInterval(w.__cqAmpTimer);
        w.__cqAudioCtx?.close().catch(() => {});
        w.__cqStream?.getTracks().forEach((t) => t.stop());

        try {
          w.__cqStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          w.__cqChunks = [];

          const mimeType =
            ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
              MediaRecorder.isTypeSupported(m)
            ) ?? "";

          w.__cqRecorder = new MediaRecorder(w.__cqStream, mimeType ? { mimeType } : undefined);
          w.__cqRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) w.__cqChunks!.push(e.data);
          };
          w.__cqRecorder.start(100);

          const ctx = new AudioContext();
          w.__cqAudioCtx = ctx;
          const src = ctx.createMediaStreamSource(w.__cqStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.7;
          src.connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);
          const BAR_COUNT = 20;
          w.__cqAmpTimer = setInterval(() => {
            analyser.getByteFrequencyData(buf);
            const usable = Math.floor(buf.length * 0.5);
            const step = Math.max(1, Math.floor(usable / BAR_COUNT));
            const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
              let sum = 0;
              for (let j = 0; j < step; j++) sum += buf[i * step + j] ?? 0;
              return Math.min(1, (sum / step / 255) * 2.5);
            });
            chrome.runtime.sendMessage({ type: "VOICE_AMPLITUDE", bars }).catch(() => {});
          }, 50);

          return { ok: true, mimeType: w.__cqRecorder.mimeType };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      }
    });

    const result = injection?.result as InjectedStartResult | undefined;
    if (result?.ok) return { ok: true, data: { started: true } };
    return { ok: false, error: (result && !result.ok && result.error) || "Could not start recording" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const handleVoiceStop = async (
  backendUrl: string
): Promise<RuntimeResult<{ transcript: string }>> => {
  const tabId = await getActiveWebTabId();
  if (tabId === null) {
    return { ok: false, error: "No active web page" };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (bUrl: string): Promise<InjectedStopResult> => {
        const w = window as Window & {
          __cqStream?: MediaStream;
          __cqRecorder?: MediaRecorder;
          __cqChunks?: Blob[];
          __cqAmpTimer?: ReturnType<typeof setInterval>;
          __cqAudioCtx?: AudioContext;
        };

        if (w.__cqAmpTimer !== undefined) clearInterval(w.__cqAmpTimer);
        w.__cqAudioCtx?.close().catch(() => {});

        const recorder = w.__cqRecorder;
        if (!recorder || recorder.state === "inactive") {
          w.__cqStream?.getTracks().forEach((t) => t.stop());
          return { ok: false, error: "Not recording" };
        }

        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          recorder.requestData();
          recorder.stop();
        });

        w.__cqStream?.getTracks().forEach((t) => t.stop());
        const mimeType = recorder.mimeType || "audio/webm";
        const chunks = w.__cqChunks ?? [];

        if (chunks.length === 0) return { ok: false, error: "No audio captured" };

        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 200) return { ok: false, error: "Recording too short — speak louder" };

        try {
          const res = await fetch(`${bUrl}/voice/transcribe`, {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: blob
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { detail?: string } | null;
            return { ok: false, error: body?.detail ?? `HTTP ${res.status}` };
          }
          const data = (await res.json()) as { transcript: string };
          return { ok: true, transcript: data.transcript ?? "" };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      args: [backendUrl]
    });

    const result = injection?.result as InjectedStopResult | undefined;
    if (result?.ok) return { ok: true, data: { transcript: result.transcript } };
    return { ok: false, error: (result && !result.ok && result.error) || "Transcription failed" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const handleRuntimeMessage = async (
  message: RuntimeRequest,
  sender: chrome.runtime.MessageSender
): Promise<RuntimeResult<unknown>> => {
  switch (message.type) {
    case CONTENT_MESSAGE.CONSOLE_EVENT:
      return appendConsoleLog(message, sender);
    case CONTENT_MESSAGE.GENERATED_MOD_ERROR:
      return captureGeneratedModError(message, sender);
    case CONTENT_MESSAGE.VISUAL_EDIT_SELECTION:
    case CONTENT_MESSAGE.VISUAL_EDIT_PREVIEW:
    case CONTENT_MESSAGE.VISUAL_EDIT_COMMIT:
      return { ok: true, data: null };
    case BACKGROUND_MESSAGE.GET_CONSOLE_LOGS:
      return getConsoleLogs(message);
    case BACKGROUND_MESSAGE.GET_ACTIVE_TABS:
      return getActiveTabs();
    case BACKGROUND_MESSAGE.OPEN_DESIGN_TAB:
      return openExtensionTab("design.html");
    case BACKGROUND_MESSAGE.OPEN_TRACE_TAB:
      return openExtensionTab("run.html");
    case BACKGROUND_MESSAGE.OPEN_SETTINGS_TAB:
      return openSettingsTab();
    case BACKGROUND_MESSAGE.GET_COMMAND_SHORTCUTS:
      return getCommandShortcuts();
    case BACKGROUND_MESSAGE.OPEN_SHORTCUT_SETTINGS:
      return openShortcutSettings();
    case BACKGROUND_MESSAGE.TOGGLE_COMMAND_BAR:
      return toggleCommandBar(sender);
    case BACKGROUND_MESSAGE.VOICE_START:
      return handleVoiceStart();
    case BACKGROUND_MESSAGE.VOICE_STOP:
      return handleVoiceStop(message.backendUrl || CONJURE_CONFIG.backendUrl);
    case CONTENT_MESSAGE.VOICE_HOTKEY:
      // Broadcast relay from content script; the side panel handles it directly.
      return { ok: true, data: null };
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

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-command-bar") {
    toggleCommandBar().catch(captureException);
  }
});

const respondToRuntimeMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => {
  if (!isRecord(message) || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "Unsupported runtime message." });
    return;
  }

  handleRuntimeMessage(message as unknown as RuntimeRequest, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      captureException(error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  respondToRuntimeMessage(message, sender, sendResponse);
  return true;
});

getUserScriptMessageEvent()?.addListener((message, sender, sendResponse) => {
  respondToRuntimeMessage(message, sender, sendResponse);
  return true;
});

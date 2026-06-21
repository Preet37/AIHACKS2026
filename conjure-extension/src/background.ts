import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "./shared/config";
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
  type RemoveModMessage,
  type RuntimeRequest,
  type RuntimeResult
} from "./shared/messages";
// Amplitude messages from the offscreen doc are forwarded directly to the side
// panel via the normal runtime broadcast — no routing needed here.

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
 * Voice capture via tab injection.
 *
 * Instead of asking the extension side panel for getUserMedia (which Chrome
 * often blocks on macOS), we inject a script into the active web tab. The tab
 * already has mic permission (granted by the user to e.g. youtube.com), so
 * getUserMedia succeeds immediately. Amplitude data comes back via
 * chrome.runtime.sendMessage broadcasts that the side panel listens to.
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
    const [result] = await chrome.scripting.executeScript<[], InjectedStartResult>({
      target: { tabId },
      func: async (): Promise<InjectedStartResult> => {
        const w = window as Window & {
          __cqStream?: MediaStream;
          __cqRecorder?: MediaRecorder;
          __cqChunks?: Blob[];
          __cqAmpTimer?: ReturnType<typeof setInterval>;
          __cqAudioCtx?: AudioContext;
        };
        // Clean up any previous session
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

          w.__cqRecorder = new MediaRecorder(
            w.__cqStream,
            mimeType ? { mimeType } : undefined
          );
          w.__cqRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) w.__cqChunks!.push(e.data);
          };
          w.__cqRecorder.start(100);

          // Real-time amplitude → side panel
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
      },
    });

    if (result?.result?.ok) return { ok: true, data: { started: true } };
    return { ok: false, error: result?.result?.error ?? "Could not start recording" };
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
    const [result] = await chrome.scripting.executeScript<[string], InjectedStopResult>({
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
            body: blob,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null) as { detail?: string } | null;
            return { ok: false, error: body?.detail ?? `HTTP ${res.status}` };
          }
          const data = await res.json() as { transcript: string };
          return { ok: true, transcript: data.transcript ?? "" };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      args: [backendUrl],
    });

    if (result?.result?.ok) return { ok: true, data: { transcript: result.result.transcript } };
    return { ok: false, error: result?.result?.error ?? "Transcription failed" };
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
    case BACKGROUND_MESSAGE.VOICE_START: {
      const m = message as unknown as { backendUrl?: string };
      return handleVoiceStart(m.backendUrl || "http://localhost:8000");
    }
    case BACKGROUND_MESSAGE.VOICE_STOP: {
      const m = message as unknown as { backendUrl?: string };
      return handleVoiceStop(m.backendUrl || "http://localhost:8000");
    }
    case CONTENT_MESSAGE.VOICE_HOTKEY:
      // Relayed from content script to all extension pages (side panel handles it)
      return { ok: true };
    default:
      return { ok: true }; // silently ignore unknown messages to avoid error logs
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

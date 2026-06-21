import * as Sentry from "@sentry/browser";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useVoice } from "./useVoice";
import {
  createConversationWsUrl,
  createModsBundleUrl,
  createModsUrl,
  createModUrl,
  CONJURE_CONFIG
} from "../shared/config";
import {
  BACKGROUND_MESSAGE,
  CLIENT_EVENT,
  CONTENT_MESSAGE,
  SERVER_EVENT,
  type ActiveTabSnapshot,
  type ApplyModsResult,
  type ClientToServerEvent,
  type ConsoleLogEntry,
  type GeneratedBundle,
  type GetElementHtmlMessage,
  type GetPageContentMessage,
  type ModRecord,
  type PageContentResult,
  type RuntimeResult,
  type ServerToClientEvent
} from "../shared/messages";
import { hostLabel } from "./lib/format";
import { StatusBar, StatusBlock } from "./components";
import {
  SurfaceProvider,
  type AgentRunState,
  type ChatMessage,
  type ConnectionState,
  type EditingMod,
  type PanelMode,
  type PlanningOption,
  type SurfaceContextValue,
  type TraceEntry,
  type TraceStatus,
  type UiSettings
} from "./surfaceContext";
import { LeftStage } from "./surfaces/LeftStage";
import { RightPanel } from "./surfaces/RightPanel";
import { Composer } from "./surfaces/Composer";
import { CommandPalette } from "./surfaces/CommandPalette";

const SESSION_STORAGE_KEY = "conjure.session";

interface PersistedSession {
  projectId: string;
  conversationId?: string;
  messages: ChatMessage[];
}

interface ToolRun {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done";
  startedAt: number;
  endedAt?: number;
}

// Workspace blocks for the StatusBar — the [n] index is added by the primitive.
const panelModes: Array<{ id: PanelMode; label: string }> = [
  { id: "home", label: "home" },
  { id: "planning", label: "plan" },
  { id: "design", label: "design" },
  { id: "trace", label: "trace" },
  { id: "settings", label: "settings" }
];

const planningOptions: PlanningOption[] = [
  {
    id: "inline",
    title: "Inline banner at top of page",
    detail: "Inject a full-width summary block above the site's header."
  },
  {
    id: "side-note",
    title: "Floating side note",
    detail: "Anchor a sticky card to the top-right corner."
  },
  {
    id: "panel-only",
    title: "Only in the Conjure panel",
    detail: "Pipe the result to the active side-panel view."
  }
];


const initSentry = () => {
  if (!CONJURE_CONFIG.sentry.enabled) return;

  try {
    Sentry.init({
      dsn: CONJURE_CONFIG.sentry.dsn,
      environment: CONJURE_CONFIG.sentry.environment,
      release: CONJURE_CONFIG.sentry.release,
      tracesSampleRate: 0
    });
    Sentry.setTag("conjure.surface", "sidepanel");
  } catch {
    // Sentry is optional and must never prevent the side panel from rendering.
  }
};

initSentry();

const makeId = () =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const captureException = (error: unknown) => {
  if (CONJURE_CONFIG.sentry.enabled) {
    Sentry.captureException(error);
  }
};

const getChromeApi = () => (typeof chrome === "undefined" ? undefined : chrome);

const previewTabSnapshot = (): ActiveTabSnapshot[] => [
  {
    id: 0,
    title: document.title || "Conjure preview",
    url: location.href,
    active: true
  }
];

const isRuntimeOk = <T,>(result: RuntimeResult<T> | undefined): result is { ok: true; data: T } =>
  Boolean(result?.ok);

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const readString = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
};

const readNumber = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) return Number(value);
  }
  return undefined;
};

const fallbackPageScript = (includeHtml: boolean, maxChars: number): PageContentResult => {
  const limit = (value: string) => {
    const text = value || "";
    return {
      value: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars
    };
  };
  const text = limit(document.body?.innerText || document.documentElement.innerText || "");
  const html = includeHtml
    ? limit(document.documentElement.outerHTML || "")
    : { value: "", truncated: false };

  return {
    contentType: "page",
    url: location.href,
    title: document.title,
    text: text.value,
    html: html.value,
    truncated: text.truncated || html.truncated
  };
};

const fallbackElementScript = (selector: string, maxChars: number): PageContentResult => {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`No element matched selector: ${selector}`);
  }

  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("script, iframe, object, embed, noscript").forEach((node) => node.remove());
  const all = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (const node of all) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        node.removeAttribute(attr.name);
      }
    }
  }

  const limit = (value: string) => {
    const text = value || "";
    return {
      value: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars
    };
  };
  const html = limit(clone.outerHTML);
  const text = limit((element as HTMLElement).innerText || element.textContent || "");

  return {
    contentType: "element",
    url: location.href,
    title: document.title,
    text: text.value,
    html: html.value,
    selector,
    truncated: text.truncated || html.truncated
  };
};

export default function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [projectId, setProjectId] = useState(CONJURE_CONFIG.projectId);
  const [conversationId, setConversationId] = useState<string>();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: makeId(),
      role: "assistant",
      content: "Tell me what to build for this browser. I will route the work to the configured agent and keep progress visible here.",
      createdAt: Date.now()
    }
  ]);
  const [activeTabs, setActiveTabs] = useState<ActiveTabSnapshot[]>([]);
  const [agentRun, setAgentRun] = useState<AgentRunState>({
    active: false,
    phrase: "Waiting for an agent run.",
    pullRequests: []
  });
  const [mods, setMods] = useState<ModRecord[]>([]);
  const [editingMod, setEditingMod] = useState<EditingMod | null>(null);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [statusText, setStatusText] = useState("Ready");
  const [mode, setMode] = useState<PanelMode>("home");
  const [showCommand, setShowCommand] = useState(false);
  const [planningChoice, setPlanningChoice] = useState(planningOptions[0].id);
  const [planningCustom, setPlanningCustom] = useState("");
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([]);
  const [uiSettings, setUiSettings] = useState<UiSettings>({
    linkedin: true,
    gmail: true,
    calendar: false,
    allowAuthenticatedTabs: false,
    requireConfirmation: true,
    voiceAlwaysListening: false,
    workMode: "planning"
  });

  const socketRef = useRef<WebSocket | null>(null);
  const pendingOpenRef = useRef<Promise<WebSocket> | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);
  const projectIdRef = useRef(projectId);
  const streamAccumRef = useRef<string>("");
  const submitChatRef = useRef<((query: string) => Promise<void>) | null>(null);

  const handleVoiceTranscript = useCallback((text: string) => {
    void submitChatRef.current?.(text);
  }, []);
  const { voiceState, voiceError, activateMic, speakText } = useVoice({ onTranscript: handleVoiceTranscript });

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const addSystemMessage = useCallback((content: string) => {
    setMessages((current) => [
      ...current,
      { id: makeId(), role: "system", content, createdAt: Date.now() }
    ]);
  }, []);

  const appendTrace = useCallback((entry: Omit<TraceEntry, "id" | "timestamp">) => {
    setTraceEntries((current) =>
      [
        ...current,
        {
          id: makeId(),
          timestamp: Date.now(),
          ...entry
        }
      ].slice(-80)
    );
  }, []);

  const toggleUiSetting = useCallback((key: keyof typeof uiSettings) => {
    setUiSettings((current) => {
      const value = current[key];
      if (typeof value !== "boolean") return current;
      return { ...current, [key]: !value };
    });
  }, []);

  // Register/refresh every active mod in the browser via the service worker.
  const applyModBundles = useCallback(
    async (bundles: GeneratedBundle[]) => {
      if (!bundles.length) return;
      const chromeApi = getChromeApi();
      if (!chromeApi?.runtime?.sendMessage) {
        setStatusText("Preview mode");
        return;
      }
      setStatusText("Applying mods to browser");
      try {
        const response = await chromeApi.runtime.sendMessage({
          type: BACKGROUND_MESSAGE.APPLY_MODS,
          projectId: projectIdRef.current,
          bundles
        });
        if (isRuntimeOk<ApplyModsResult>(response)) {
          const { applied, reloaded } = response.data;
          setStatusText(`Applied ${applied} mod(s)`);
          if (reloaded > 0) {
            addSystemMessage(`Applied ${applied} mod(s) and reloaded ${reloaded} matching tab(s).`);
          }
          return;
        }
        const error = response?.error || "Could not apply mods.";
        setStatusText("Apply failed");
        addSystemMessage(error);
      } catch (error) {
        setStatusText("Apply failed");
        addSystemMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [addSystemMessage]
  );

  // Pull the current mod list + active bundles from the backend and apply them.
  const refreshAndApplyMods = useCallback(
    async (targetProjectId: string) => {
      try {
        const [listResponse, bundleResponse] = await Promise.all([
          fetch(createModsUrl(targetProjectId), { cache: "no-store" }),
          fetch(createModsBundleUrl(targetProjectId), { cache: "no-store" })
        ]);
        if (listResponse.ok) {
          const data = (await listResponse.json()) as { mods?: ModRecord[] };
          setMods(data.mods || []);
        }
        if (bundleResponse.ok) {
          const data = (await bundleResponse.json()) as { bundles?: GeneratedBundle[] };
          await applyModBundles(data.bundles || []);
        }
      } catch (error) {
        captureException(error);
      }
    },
    [applyModBundles]
  );

  const removeMod = useCallback(
    async (mod: ModRecord) => {
      setStatusText(`Removing "${mod.name}"`);
      try {
        const response = await fetch(createModUrl(projectIdRef.current, mod.id), { method: "DELETE" });
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status} removing the mod.`);
        }
        const data = (await response.json()) as { mods?: ModRecord[] };
        setMods(data.mods || []);
        const chromeApi = getChromeApi();
        if (chromeApi?.runtime?.sendMessage) {
          await chromeApi.runtime.sendMessage({ type: BACKGROUND_MESSAGE.REMOVE_MOD, modId: mod.id });
        }
        setStatusText(`Removed "${mod.name}"`);
        addSystemMessage(`Removed mod "${mod.name}".`);
      } catch (error) {
        setStatusText("Remove failed");
        addSystemMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [addSystemMessage]
  );

  const activeTab = useMemo(() => activeTabs.find((tab) => tab.active) || activeTabs[0], [activeTabs]);

  const sendToServer = useCallback((payload: ClientToServerEvent) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected.");
    }
    socket.send(JSON.stringify(payload));
  }, []);

  const appendAssistantContent = useCallback((chunk: string) => {
    streamAccumRef.current += chunk;
    setMessages((current) => {
      const assistantId = currentAssistantIdRef.current || makeId();
      currentAssistantIdRef.current = assistantId;
      const existing = current.find((message) => message.id === assistantId);

      if (!existing) {
        return [
          ...current,
          {
            id: assistantId,
            role: "assistant",
            content: chunk,
            createdAt: Date.now(),
            streaming: true
          }
        ];
      }

      return current.map((message) =>
        message.id === assistantId
          ? { ...message, content: message.content + chunk, streaming: true }
          : message
      );
    });
  }, []);

  const finalizeAssistant = useCallback((content?: string) => {
    const fullText = content || streamAccumRef.current;
    streamAccumRef.current = "";

    setMessages((current) =>
      current.map((message) =>
        message.id === currentAssistantIdRef.current
          ? { ...message, content: fullText || message.content, streaming: false }
          : message
      )
    );
    currentAssistantIdRef.current = null;

    if (!fullText) return;

    // Build concise spoken summary (1-2 sentences, ≤ 160 chars)
    const forTTS = fullText
      .replace(/\*\*Plan:\*\*[\s\S]*/, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_#>]/g, "")
      .replace(/\n+/g, " ")
      .trim();

    const sentenceEnd = /[.!?]/g;
    let spoken = forTTS;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = sentenceEnd.exec(forTTS)) !== null) {
      count++;
      if (count >= 2) { spoken = forTTS.slice(0, match.index + 1); break; }
    }
    spoken = spoken.slice(0, 160).trim();
    if (spoken) {
      const endsWithQuestion = /\?\s*$/.test(spoken);
      void speakText(spoken, { autoListen: endsWithQuestion });
    }
  }, [speakText]);

  const getActiveTabs = useCallback(async () => {
    const chromeApi = getChromeApi();
    if (!chromeApi?.runtime?.sendMessage) {
      const previewTabs = previewTabSnapshot();
      setActiveTabs(previewTabs);
      return previewTabs;
    }

    const response = await chromeApi.runtime.sendMessage({
      type: BACKGROUND_MESSAGE.GET_ACTIVE_TABS
    });

    if (isRuntimeOk<ActiveTabSnapshot[]>(response)) {
      setActiveTabs(response.data);
      return response.data;
    }

    return [];
  }, []);

  const sendTabContentResponse = useCallback(
    (requestId: string, content: unknown) => {
      sendToServer({
        type: CLIENT_EVENT.TAB_CONTENT_RESPONSE,
        request_id: requestId,
        content: typeof content === "string" ? content : JSON.stringify(content)
      });
    },
    [sendToServer]
  );

  const sendConsoleLogsResponse = useCallback(
    (requestId: string, content: unknown) => {
      sendToServer({
        type: CLIENT_EVENT.CONSOLE_LOGS_RESPONSE,
        request_id: requestId,
        content: typeof content === "string" ? content : JSON.stringify(content)
      });
    },
    [sendToServer]
  );

  const getPageContentFromTab = useCallback(
    async (tabId: number, requestId: string, includeHtml: boolean, selector?: string) => {
      const chromeApi = getChromeApi();
      if (!chromeApi?.tabs || !chromeApi?.scripting) {
        throw new Error("Chrome extension tab APIs are not available in preview mode.");
      }

      try {
        if (selector) {
          const response = await chromeApi.tabs.sendMessage(tabId, {
            type: CONTENT_MESSAGE.GET_ELEMENT_HTML,
            requestId,
            selector,
            maxChars: CONJURE_CONFIG.pageContentMaxChars
          } satisfies GetElementHtmlMessage);

          if (isRuntimeOk<PageContentResult>(response)) return response.data;
          throw new Error(response?.error || "Content script could not read the selected element.");
        }

        const response = await chromeApi.tabs.sendMessage(tabId, {
          type: CONTENT_MESSAGE.GET_PAGE_CONTENT,
          requestId,
          includeHtml,
          maxChars: CONJURE_CONFIG.pageContentMaxChars
        } satisfies GetPageContentMessage);

        if (isRuntimeOk<PageContentResult>(response)) return response.data;
        throw new Error(response?.error || "Content script could not read the page.");
      } catch {
        const [{ result }] = selector
          ? await chromeApi.scripting.executeScript({
              target: { tabId },
              func: fallbackElementScript,
              args: [selector, CONJURE_CONFIG.pageContentMaxChars]
            })
          : await chromeApi.scripting.executeScript({
              target: { tabId },
              func: fallbackPageScript,
              args: [includeHtml, CONJURE_CONFIG.pageContentMaxChars]
            });

        return result as PageContentResult;
      }
    },
    []
  );

  const handleRequestTabContent = useCallback(
    async (event: Record<string, unknown>) => {
      const requestId = readString(event, "request_id", "requestId") || makeId();
      const tabId = readNumber(event, "tab_id", "tabId") || activeTab?.id;
      const selector = readString(event, "selector");
      const includeHtml = Boolean(event.include_html ?? event.includeHtml ?? true);

      if (!tabId) {
        sendTabContentResponse(requestId, { error: "No active tab available." });
        return;
      }

      try {
        const content = await getPageContentFromTab(tabId, requestId, includeHtml, selector);
        sendTabContentResponse(requestId, content);
      } catch (error) {
        captureException(error);
        sendTabContentResponse(requestId, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    [activeTab?.id, getPageContentFromTab, sendTabContentResponse]
  );

  const handleRequestConsoleLogs = useCallback(
    async (event: Record<string, unknown>) => {
      const requestId = readString(event, "request_id", "requestId") || makeId();
      const tabId = readNumber(event, "tab_id", "tabId") || activeTab?.id;

      try {
        const chromeApi = getChromeApi();
        if (!chromeApi?.runtime?.sendMessage) {
          sendConsoleLogsResponse(requestId, { error: "Console logs are unavailable in preview mode." });
          return;
        }

        const response = await chromeApi.runtime.sendMessage({
          type: BACKGROUND_MESSAGE.GET_CONSOLE_LOGS,
          tabId,
          level: readString(event, "level"),
          since: readNumber(event, "since"),
          limit: 300
        });

        if (isRuntimeOk<ConsoleLogEntry[]>(response)) {
          sendConsoleLogsResponse(requestId, response.data);
          return;
        }

        sendConsoleLogsResponse(requestId, { error: response?.error || "Could not read console logs." });
      } catch (error) {
        captureException(error);
        sendConsoleLogsResponse(requestId, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    [activeTab?.id, sendConsoleLogsResponse]
  );

  const handleServerEvent = useCallback(
    (event: ServerToClientEvent) => {
      const raw = readRecord(event);

      switch (event.type) {
        case SERVER_EVENT.CONVERSATION_ID:
          setConversationId(event.conversation_id);
          return;
        case SERVER_EVENT.CONTENT:
          appendAssistantContent(event.content);
          return;
        case SERVER_EVENT.TOOL_START:
          setTools((current) => [
            {
              id: `${event.name}-${Date.now()}`,
              name: event.name,
              args: event.args,
              status: "running",
              startedAt: Date.now()
            },
            ...current
          ]);
          appendTrace({
            label: `tool: ${event.name}`,
            detail: event.args ? JSON.stringify(event.args).slice(0, 160) : "started",
            status: "running"
          });
          setStatusText(`Running ${event.name}`);
          return;
        case SERVER_EVENT.TOOL_END:
          setTools((current) => {
            const index = current.findIndex((tool) => tool.name === event.name && tool.status === "running");
            if (index === -1) return current;
            return current.map((tool, toolIndex) =>
              toolIndex === index ? { ...tool, status: "done", endedAt: Date.now() } : tool
            );
          });
          appendTrace({
            label: `tool: ${event.name}`,
            detail: "completed",
            status: "done"
          });
          setStatusText("Tool complete");
          return;
        case SERVER_EVENT.AGENT_STATUS:
          setAgentRun({
            active: Boolean(event.active),
            provider: event.provider,
            phrase: event.phrase,
            status: event.status,
            statusDetail: event.status_detail,
            sessionUrl: event.session_url,
            pullRequests: event.pull_requests || []
          });
          appendTrace({
            label: `${event.provider || "agent"} status`,
            detail: event.status_detail || event.status || event.phrase,
            status:
              event.status === "error" || event.status === "suspended"
                ? "failed"
                : event.active
                  ? "running"
                  : "done"
          });
          setStatusText(event.phrase);
          return;
        case SERVER_EVENT.THINKING:
          setStatusText("Thinking");
          return;
        case SERVER_EVENT.REQUEST_TAB_CONTENT:
          void handleRequestTabContent(raw);
          return;
        case SERVER_EVENT.REQUEST_CONSOLE_LOGS:
          void handleRequestConsoleLogs(raw);
          return;
        case SERVER_EVENT.SANDBOX_START:
          appendTrace({
            label: "sandbox start",
            detail: readString(raw, "target_url", "targetUrl") || "verification started",
            status: "running",
            modId: readString(raw, "mod_id", "modId"),
            targetUrl: readString(raw, "target_url", "targetUrl")
          });
          setMode("trace");
          setStatusText("Sandbox running");
          return;
        case SERVER_EVENT.SANDBOX_SCREENSHOT:
          appendTrace({
            label: "sandbox screenshot",
            detail: "captured verification frame",
            status: "done",
            modId: readString(raw, "mod_id", "modId"),
            screenshotData: readString(raw, "data", "url")
          });
          setStatusText("Sandbox screenshot captured");
          return;
        case SERVER_EVENT.SANDBOX_RESULT: {
          const passed = Boolean(raw.passed);
          appendTrace({
            label: passed ? "sandbox passed" : "sandbox failed",
            detail: Array.isArray(raw.findings)
              ? raw.findings.map(String).join("; ")
              : readString(raw, "replay_url", "replayUrl") || "verification complete",
            status: passed ? "done" : "failed",
            modId: readString(raw, "mod_id", "modId"),
            replayUrl: readString(raw, "replay_url", "replayUrl")
          });
          setStatusText(passed ? "Sandbox passed" : "Sandbox failed");
          return;
        }
        case SERVER_EVENT.SANDBOX_HEALING:
          appendTrace({
            label: `sandbox healing ${readNumber(raw, "iteration") || ""}`.trim(),
            detail: readString(raw, "fix_summary", "fixSummary") || "repair iteration",
            status: "running"
          });
          setStatusText("Healing mod");
          return;
        case SERVER_EVENT.EXTENSION_READY: {
          const bundles = (event as { bundles?: GeneratedBundle[] }).bundles || [];
          setStatusText("Applying mods");
          void applyModBundles(bundles);
          return;
        }
        case SERVER_EVENT.MODS_UPDATED:
          setMods((event as { mods?: ModRecord[] }).mods || []);
          return;
        case SERVER_EVENT.CONVERSATION_TITLE:
          document.title = `${event.title} - Conjure`;
          return;
        case SERVER_EVENT.RULES_UPDATED:
          setRules(event.rules);
          return;
        case SERVER_EVENT.DONE:
          finalizeAssistant(event.content);
          setAgentRun((current) => ({ ...current, active: false }));
          appendTrace({
            label: "run complete",
            detail: event.content ? event.content.slice(0, 180) : "assistant finished",
            status: "done"
          });
          setStatusText("Ready");
          return;
        case SERVER_EVENT.ERROR:
          finalizeAssistant();
          setAgentRun({
            active: false,
            phrase: event.message,
            status: "error",
            pullRequests: []
          });
          setMessages((current) => [
            ...current,
            {
              id: makeId(),
              role: "system",
              content: event.message,
              createdAt: Date.now()
            }
          ]);
          appendTrace({
            label: "run error",
            detail: event.message,
            status: "failed"
          });
          setStatusText("Error");
          return;
        default:
          return;
      }
    },
    [
      appendAssistantContent,
      appendTrace,
      applyModBundles,
      finalizeAssistant,
      handleRequestConsoleLogs,
      handleRequestTabContent
    ]
  );

  const openSocket = useCallback((): Promise<WebSocket> => {
    const existing = socketRef.current;
    if (existing?.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (pendingOpenRef.current) return pendingOpenRef.current;

    setConnectionState("connecting");
    const socket = new WebSocket(createConversationWsUrl(projectId));
    socketRef.current = socket;

    pendingOpenRef.current = new Promise((resolve, reject) => {
      socket.onopen = () => {
        pendingOpenRef.current = null;
        setConnectionState("connected");
        setStatusText("Connected");
        resolve(socket);
      };

      socket.onerror = () => {
        pendingOpenRef.current = null;
        setConnectionState("error");
        setStatusText("Connection error");
        reject(new Error("WebSocket connection failed."));
      };

      socket.onclose = () => {
        pendingOpenRef.current = null;
        if (socketRef.current === socket) {
          setConnectionState("idle");
          setStatusText("Disconnected");
        }
      };

      socket.onmessage = (message) => {
        try {
          handleServerEvent(JSON.parse(message.data) as ServerToClientEvent);
        } catch (error) {
          captureException(error);
          setStatusText("Bad server event");
        }
      };
    });

    return pendingOpenRef.current;
  }, [handleServerEvent, projectId]);

  const submitChat = useCallback(
    async (query: string, modId?: string) => {
      currentAssistantIdRef.current = null;
      streamAccumRef.current = "";
      const startedAt = Date.now();
      setRunStartedAt(startedAt);
      setTraceEntries([
        {
          id: makeId(),
          label: modId ? "rebuild requested" : "run requested",
          detail: query,
          status: "running",
          timestamp: startedAt,
          modId
        }
      ]);
      setMode("trace");
      setShowCommand(false);
      setAgentRun({
        active: true,
        phrase: "Starting agent...",
        status: "running",
        pullRequests: []
      });
      setTools([]);
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "user",
          content: modId ? `Change mod: ${query}` : query,
          createdAt: Date.now()
        }
      ]);

      try {
        const tabs = await getActiveTabs();
        const socket = await openSocket();
        socket.send(
          JSON.stringify({
            type: CLIENT_EVENT.CHAT,
            query,
            conversation_id: conversationId,
            active_tabs: tabs,
            ...(modId ? { mod_id: modId } : {})
          } satisfies ClientToServerEvent)
        );
        setStatusText(modId ? "Rebuilding mod" : "Streaming");
      } catch (error) {
        captureException(error);
        addSystemMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [addSystemMessage, conversationId, getActiveTabs, openSocket]
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const query = input.trim();
    if (!query) return;
    setInput("");
    await submitChat(query);
  };

  const handleCommandSubmit = async (query: string) => {
    const command = query.trim();
    if (!command) return;
    setInput("");
    await submitChat(command);
  };

  // Keep ref in sync so voice transcript callback always calls latest submitChat
  submitChatRef.current = submitChat;

  const runPlanningBuild = async () => {
    const selected = planningOptions.find((option) => option.id === planningChoice);
    const custom = planningCustom.trim();
    const query = custom
      ? `Build this browser customization: ${custom}`
      : `Build this browser customization with ${selected?.title.toLowerCase() || "the selected planning option"}: ${selected?.detail || ""}`;
    await submitChat(query);
  };

  const submitModChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingMod) return;
    const prompt = editingMod.prompt.trim();
    if (!prompt) return;
    const modId = editingMod.id;
    setEditingMod(null);
    await submitChat(prompt, modId);
  };

  const refreshTabs = async () => {
    await getActiveTabs();
  };

  // Restore the previous session so closing/reopening the side panel (or a
  // backend restart) does not wipe the conversation. Runs once before the
  // persistence effect below is allowed to write.
  useEffect(() => {
    let cancelled = false;
    const chromeApi = getChromeApi();
    if (!chromeApi?.storage?.local) {
      try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        const session = raw ? (JSON.parse(raw) as PersistedSession) : undefined;
        if (session) {
          if (session.projectId) setProjectId(session.projectId);
          if (session.conversationId) setConversationId(session.conversationId);
          if (Array.isArray(session.messages) && session.messages.length > 0) {
            setMessages(session.messages.map((message) => ({ ...message, streaming: false })));
          }
        }
      } catch (error) {
        captureException(error);
      }
      hydratedRef.current = true;
      return () => {
        cancelled = true;
      };
    }

    chromeApi.storage.local
      .get(SESSION_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        const session = stored[SESSION_STORAGE_KEY] as PersistedSession | undefined;
        if (session) {
          if (session.projectId) setProjectId(session.projectId);
          if (session.conversationId) setConversationId(session.conversationId);
          if (Array.isArray(session.messages) && session.messages.length > 0) {
            setMessages(session.messages.map((message) => ({ ...message, streaming: false })));
          }
        }
        hydratedRef.current = true;
      })
      .catch((error) => {
        captureException(error);
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the session on every change once hydration has completed.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const session: PersistedSession = { projectId, conversationId, messages };
    const chromeApi = getChromeApi();
    if (chromeApi?.storage?.local) {
      chromeApi.storage.local.set({ [SESSION_STORAGE_KEY]: session }).catch(captureException);
      return;
    }
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (error) {
      captureException(error);
    }
  }, [projectId, conversationId, messages]);

  useEffect(() => {
    void getActiveTabs();
    const chromeApi = getChromeApi();
    if (chromeApi?.runtime?.sendMessage) {
      chromeApi.runtime
        .sendMessage({ type: BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE })
        .catch(captureException);
    }
  }, [getActiveTabs]);

  // Load the mod list and (re)apply every active mod whenever the project changes.
  useEffect(() => {
    void refreshAndApplyMods(projectId);
  }, [refreshAndApplyMods, projectId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommand((current) => !current);
        return;
      }

      if (event.key === "Escape") {
        setShowCommand(false);
        return;
      }

      if (event.altKey) {
        const modeIndex = Number(event.key) - 1;
        const selectedMode = panelModes[modeIndex]?.id;
        if (selectedMode) {
          event.preventDefault();
          setMode(selectedMode);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(
    () => () => {
      socketRef.current?.close();
    },
    []
  );

  const agentStatusClass = agentRun.active
    ? "running"
    : agentRun.status === "exit"
      ? "passed"
      : agentRun.status === "error" || agentRun.status === "suspended" || agentRun.phrase.includes("blocked")
        ? "failed"
        : "idle";

  const pullRequestLinks = agentRun.pullRequests
    .map((pullRequest) => pullRequest.pr_url || pullRequest.url || pullRequest.html_url)
    .filter((url): url is string => Boolean(url));

  const providerLabel =
    agentRun.provider === "claude"
      ? "Claude"
      : agentRun.provider === "nemotron"
        ? "Nemotron"
        : agentRun.provider === "devin"
          ? "Devin"
          : "Agent";

  const activeMods = useMemo(() => mods.filter((mod) => mod.status === "active"), [mods]);
  const latestUser = useMemo(
    () => [...messages].reverse().find((message) => message.role === "user"),
    [messages]
  );
  const visibleTrace = traceEntries.length
    ? traceEntries
    : [
        {
          id: "idle",
          label: "waiting for command",
          detail: "No active run yet.",
          status: "pending" as TraceStatus,
          timestamp: Date.now()
        }
      ];
  const completedTraceCount = traceEntries.filter((entry) => entry.status === "done").length;
  const traceProgress = traceEntries.length
    ? Math.max(8, Math.round((completedTraceCount / Math.max(traceEntries.length, 1)) * 100))
    : 0;
  const elapsedLabel = runStartedAt
    ? `${Math.max(0, Math.round((Date.now() - runStartedAt) / 1000))}s`
    : "0s";
  const latestScreenshot = [...traceEntries].reverse().find((entry) => entry.screenshotData);
  const sandboxImageSrc = latestScreenshot?.screenshotData
    ? latestScreenshot.screenshotData.startsWith("data:")
      ? latestScreenshot.screenshotData
      : `data:image/png;base64,${latestScreenshot.screenshotData}`
    : undefined;
  const activeScope = hostLabel(activeTab?.url);
  const selectedPlanningOption =
    planningOptions.find((option) => option.id === planningChoice) || planningOptions[0];

  const surfaceValue: SurfaceContextValue = {
    mode,
    setMode,
    mods,
    activeMods,
    refreshAndApplyMods,
    editingMod,
    setEditingMod,
    submitModChange,
    removeMod,
    agentRun,
    agentStatusClass,
    providerLabel,
    pullRequestLinks,
    messages,
    messagesEndRef,
    latestUser,
    traceEntries,
    visibleTrace,
    completedTraceCount,
    traceProgress,
    elapsedLabel,
    sandboxImageSrc,
    activeScope,
    activeTab,
    activeTabs,
    refreshTabs,
    statusText,
    connectionState,
    projectId,
    setProjectId,
    planningOptions,
    planningChoice,
    setPlanningChoice,
    planningCustom,
    setPlanningCustom,
    selectedPlanningOption,
    runPlanningBuild,
    uiSettings,
    toggleUiSetting,
    setUiSettings,
    rules,
    input,
    setInput,
    handleSubmit,
    showCommand,
    setShowCommand,
    handleCommandSubmit,
    voiceState,
    voiceError,
    activateMic
  };

  const connectionStatusState: "active" | "done" | "pending" =
    connectionState === "connected" ? "active" : connectionState === "idle" ? "done" : "pending";

  return (
    <SurfaceProvider value={surfaceValue}>
      <main className={`conjure-shell mode-${mode}`}>
        <LeftStage />

        <aside className="conjure-panel" aria-label="Conjure command interface">
          <StatusBar
            workspaces={panelModes}
            activeId={mode}
            onSelect={(id) => setMode(id as PanelMode)}
            onBrand={() => setShowCommand(true)}
            right={
              <>
                <StatusBlock
                  state={connectionStatusState}
                  pulse={connectionState === "connecting"}
                  label={`Connection: ${connectionState}`}
                />
                <span className="cj-statusbar__status">{statusText}</span>
              </>
            }
          />

          <RightPanel />

          <Composer />
        </aside>

        {showCommand ? <CommandPalette /> : null}
      </main>
    </SurfaceProvider>
  );
}

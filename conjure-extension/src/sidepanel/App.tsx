import * as Sentry from "@sentry/browser";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  MessageSquareText,
  Mic,
  Pencil,
  Puzzle,
  RefreshCcw,
  Send,
  Terminal,
  Trash2,
  Volume2,
  Wrench,
  XCircle
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceOverlay } from "./VoiceOverlay";
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

const SESSION_STORAGE_KEY = "conjure.session";

interface PersistedSession {
  projectId: string;
  conversationId?: string;
  messages: ChatMessage[];
}

type ConnectionState = "idle" | "connecting" | "connected" | "error";
type ChatRole = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  streaming?: boolean;
}

interface ToolRun {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done";
  startedAt: number;
  endedAt?: number;
}

interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done";
}

interface SandboxScreenshot {
  id: string;
  url?: string;
  data?: string;
  createdAt: number;
}

interface SandboxHealingStep {
  id: string;
  iteration: number;
  fixSummary?: string;
}

interface SandboxState {
  active: boolean;
  targetUrl?: string;
  screenshots: SandboxScreenshot[];
  healing: SandboxHealingStep[];
  result?: {
    passed: boolean;
    findings: string[];
    replayUrl?: string;
  };
}


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

const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);

export default function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [projectId, setProjectId] = useState(CONJURE_CONFIG.projectId);
  const [conversationId, setConversationId] = useState<string>();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: makeId(),
      role: "assistant",
      content: "Tell me what to build for this browser. I can inspect active tabs, stream tool work, and show sandbox results here.",
      createdAt: Date.now()
    }
  ]);
  const [activeTabs, setActiveTabs] = useState<ActiveTabSnapshot[]>([]);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [sandbox, setSandbox] = useState<SandboxState>({
    active: false,
    screenshots: [],
    healing: []
  });
  const [mods, setMods] = useState<ModRecord[]>([]);
  const [editingMod, setEditingMod] = useState<{ id: string; prompt: string } | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [modsExpanded, setModsExpanded] = useState(false);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [statusText, setStatusText] = useState("Ready");

  const socketRef = useRef<WebSocket | null>(null);
  const pendingOpenRef = useRef<Promise<WebSocket> | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);
  const projectIdRef = useRef(projectId);
  // Tracks whether the current session was voice-initiated so we know to TTS the reply
  const voiceInitiatedRef = useRef(false);
  const lastAssistantContentRef = useRef<string>("");

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // submitChat is defined later; we forward through a ref so the voice hook
  // can call it without stale-closure issues.
  const submitChatRef = useRef<((query: string) => Promise<void>) | null>(null);
  const handleVoiceTranscript = useCallback((text: string) => {
    voiceInitiatedRef.current = true;
    void submitChatRef.current?.(text);
  }, []);
  const { voiceState, voiceError, barAmplitudes, permissionState, requestPermission, speakText } = useVoice({ onTranscript: handleVoiceTranscript });

  const addSystemMessage = useCallback((content: string) => {
    setMessages((current) => [
      ...current,
      { id: makeId(), role: "system", content, createdAt: Date.now() }
    ]);
  }, []);

  // Register/refresh every active mod in the browser via the service worker.
  const applyModBundles = useCallback(
    async (bundles: GeneratedBundle[]) => {
      if (!bundles.length) return;
      setStatusText("Applying mods to browser");
      try {
        const response = await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE.APPLY_MODS,
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
        await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE.REMOVE_MOD, modId: mod.id });
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

  const finalizeAssistant = useCallback(
    (content?: string) => {
      setMessages((current) => {
        const updated = current.map((message) =>
          message.id === currentAssistantIdRef.current
            ? { ...message, content: content || message.content, streaming: false }
            : message
        );
        // Capture final text for TTS
        const finalMsg = updated.find((m) => m.id === currentAssistantIdRef.current);
        lastAssistantContentRef.current = finalMsg?.content ?? content ?? "";
        return updated;
      });
      currentAssistantIdRef.current = null;

      // Speak the reply if this turn was voice-initiated
      if (voiceInitiatedRef.current) {
        voiceInitiatedRef.current = false;
        const toSpeak = lastAssistantContentRef.current;
        if (toSpeak) void speakText(toSpeak.slice(0, 500)); // cap to ~500 chars so TTS isn't too long
      }
    },
    [speakText]
  );

  const getActiveTabs = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({
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
      try {
        if (selector) {
          const response = await chrome.tabs.sendMessage(tabId, {
            type: CONTENT_MESSAGE.GET_ELEMENT_HTML,
            requestId,
            selector,
            maxChars: CONJURE_CONFIG.pageContentMaxChars
          } satisfies GetElementHtmlMessage);

          if (isRuntimeOk<PageContentResult>(response)) return response.data;
          throw new Error(response?.error || "Content script could not read the selected element.");
        }

        const response = await chrome.tabs.sendMessage(tabId, {
          type: CONTENT_MESSAGE.GET_PAGE_CONTENT,
          requestId,
          includeHtml,
          maxChars: CONJURE_CONFIG.pageContentMaxChars
        } satisfies GetPageContentMessage);

        if (isRuntimeOk<PageContentResult>(response)) return response.data;
        throw new Error(response?.error || "Content script could not read the page.");
      } catch {
        const [{ result }] = selector
          ? await chrome.scripting.executeScript({
              target: { tabId },
              func: fallbackElementScript,
              args: [selector, CONJURE_CONFIG.pageContentMaxChars]
            })
          : await chrome.scripting.executeScript({
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
        const response = await chrome.runtime.sendMessage({
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
        case SERVER_EVENT.CONTENT: {
          appendAssistantContent(event.content);
          // Parse plan steps from "**Plan:**\n- [ ] N. title — why" pattern
          setMessages((current) => {
            const msg = current.find((m) => m.id === currentAssistantIdRef.current);
            if (!msg) return current;
            const full = msg.content + (event.content as string);
            const planBlock = /\*\*Plan:\*\*\n((?:- \[[ x]\].*\n?)+)/i.exec(full);
            if (planBlock) {
              const steps: PlanStep[] = [];
              for (const line of planBlock[1].split("\n")) {
                const m = /- \[[ x]\]\s+(\d+)\.\s+([^—–-]+)/.exec(line);
                if (m) steps.push({ id: m[1], title: m[2].trim(), status: "pending" });
              }
              if (steps.length > 0) setPlanSteps(steps);
            }
            return current;
          });
          return;
        }
        case SERVER_EVENT.TOOL_START:
          // Advance plan: mark the first pending step as running when tools start
          setPlanSteps((steps) => {
            const idx = steps.findIndex((s) => s.status === "pending");
            if (idx === -1) return steps;
            return steps.map((s, i) => i === idx ? { ...s, status: "running" } : s);
          });
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
          setStatusText(`Running ${event.name}`);
          return;
        case SERVER_EVENT.TOOL_END:
          // Advance plan: mark the running step as done
          setPlanSteps((steps) => {
            const idx = steps.findIndex((s) => s.status === "running");
            if (idx === -1) return steps;
            return steps.map((s, i) => i === idx ? { ...s, status: "done" } : s);
          });
          setTools((current) => {
            const index = current.findIndex((tool) => tool.name === event.name && tool.status === "running");
            if (index === -1) return current;
            return current.map((tool, toolIndex) =>
              toolIndex === index ? { ...tool, status: "done", endedAt: Date.now() } : tool
            );
          });
          setStatusText("Tool complete");
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
          setSandbox((current) => ({
            ...current,
            active: true,
            targetUrl: readString(raw, "target_url", "targetUrl"),
            result: undefined
          }));
          setStatusText("Sandbox running");
          return;
        case SERVER_EVENT.SANDBOX_SCREENSHOT:
          setSandbox((current) => ({
            ...current,
            active: true,
            screenshots: [
              {
                id: makeId(),
                url: readString(raw, "url"),
                data: readString(raw, "data"),
                createdAt: Date.now()
              },
              ...current.screenshots
            ].slice(0, 5)
          }));
          return;
        case SERVER_EVENT.SANDBOX_RESULT:
          setSandbox((current) => ({
            ...current,
            active: false,
            result: {
              passed: Boolean(raw.passed),
              findings: Array.isArray(raw.findings) ? raw.findings.map(String) : [],
              replayUrl: readString(raw, "replay_url", "replayUrl")
            }
          }));
          setStatusText(Boolean(raw.passed) ? "Sandbox passed" : "Sandbox failed");
          return;
        case SERVER_EVENT.SANDBOX_HEALING:
          setSandbox((current) => ({
            ...current,
            active: true,
            healing: [
              {
                id: makeId(),
                iteration: readNumber(raw, "iteration") || current.healing.length + 1,
                fixSummary: readString(raw, "fix_summary", "fixSummary")
              },
              ...current.healing
            ]
          }));
          setStatusText("Healing sandbox issue");
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
          setStatusText("Ready");
          return;
        case SERVER_EVENT.ERROR:
          finalizeAssistant();
          setMessages((current) => [
            ...current,
            {
              id: makeId(),
              role: "system",
              content: event.message,
              createdAt: Date.now()
            }
          ]);
          setStatusText("Error");
          return;
        default:
          return;
      }
    },
    [
      appendAssistantContent,
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
      setPlanSteps([]); // clear previous plan on new turn
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

  // Keep the ref up-to-date so the voice handler always calls the latest version
  submitChatRef.current = submitChat;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const query = input.trim();
    if (!query) return;
    setInput("");
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
    chrome.storage.local
      .get(SESSION_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        const session = stored[SESSION_STORAGE_KEY] as PersistedSession | undefined;
        if (session) {
          if (session.projectId) setProjectId(session.projectId);
          // Don't restore old messages — each session starts fresh
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

  // Persist projectId only — messages always start fresh on reload.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const session: PersistedSession = { projectId, conversationId, messages: [] };
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session }).catch(captureException);
  }, [projectId, conversationId]);

  useEffect(() => {
    void getActiveTabs();
    chrome.runtime
      .sendMessage({ type: BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE })
      .catch(captureException);
  }, [getActiveTabs]);

  // Load the mod list and (re)apply every active mod whenever the project changes.
  useEffect(() => {
    void refreshAndApplyMods(projectId);
  }, [refreshAndApplyMods, projectId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(
    () => () => {
      socketRef.current?.close();
    },
    []
  );

  const statusIcon =
    connectionState === "connected" ? (
      <CheckCircle2 aria-hidden="true" />
    ) : connectionState === "connecting" ? (
      <Loader2 aria-hidden="true" className="spin" />
    ) : connectionState === "error" ? (
      <XCircle aria-hidden="true" />
    ) : (
      <Circle aria-hidden="true" />
    );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <MessageSquareText aria-hidden="true" />
          </div>
          <div>
            <h1>conjure</h1>
            <p>{statusText}</p>
          </div>
        </div>
        <div className={`connection ${connectionState}`}>
          {statusIcon}
          <span>{connectionState}</span>
        </div>
      </header>

      <VoiceOverlay
        voiceState={voiceState}
        voiceError={voiceError}
        barAmplitudes={barAmplitudes}
        permissionState={permissionState}
        onRequestPermission={requestPermission}
      />

      {/* Project row and tabs strip hidden — config is internal */}

      <section className="chat-log" aria-label="Conversation">
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div className="message-meta">
              <span>{message.role}</span>
              <time>{formatTime(message.createdAt)}</time>
              {message.streaming ? <Loader2 aria-hidden="true" className="spin small" /> : null}
            </div>
            <p>{message.content}</p>
          </article>
        ))}
        <div ref={messagesEndRef} />
      </section>

      {planSteps.length > 0 && (
        <section className="plan-panel" aria-label="Execution plan">
          <div className="plan-header">
            <span className="plan-title">Plan</span>
            <span className="plan-progress">
              {planSteps.filter((s) => s.status === "done").length}/{planSteps.length}
            </span>
          </div>
          <ol className="plan-steps">
            {planSteps.map((step) => (
              <li key={step.id} className={`plan-step plan-step--${step.status}`}>
                <span className="plan-step-icon" aria-hidden="true">
                  {step.status === "done" ? "✓" : step.status === "running" ? "▶" : "○"}
                </span>
                <span className="plan-step-title">{step.title}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* workbench / sandbox hidden — only shown when there's active output */}
      {(sandbox.active || sandbox.result) && <section className="workbench" aria-label="Agent work">
        <div className="panel-section sandbox-panel">
          <div className="section-title">
            <Wrench aria-hidden="true" />
            <h2>Sandbox</h2>
          </div>
          {sandbox.active ? (
            <div className="status-line running">
              <Loader2 aria-hidden="true" className="spin" />
              <span>{sandbox.targetUrl || "Browserbase run in progress"}</span>
            </div>
          ) : sandbox.result ? (
            <div className={`status-line ${sandbox.result.passed ? "passed" : "failed"}`}>
              {sandbox.result.passed ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <AlertTriangle aria-hidden="true" />
              )}
              <span>{sandbox.result.passed ? "Passed" : "Needs fixes"}</span>
            </div>
          ) : (
            <p className="empty">Waiting for a sandbox run.</p>
          )}

          {sandbox.screenshots[0]?.data || sandbox.screenshots[0]?.url ? (
            <div className="screenshot-frame">
              <img
                src={sandbox.screenshots[0].data || sandbox.screenshots[0].url}
                alt="Latest sandbox screenshot"
              />
            </div>
          ) : null}

          {sandbox.result?.findings.length ? (
            <ul className="findings">
              {sandbox.result.findings.slice(0, 4).map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}

          {sandbox.result?.replayUrl ? (
            <a className="replay-link" href={sandbox.result.replayUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Replay
            </a>
          ) : null}

          {sandbox.healing.length ? (
            <ol className="healing-list">
              {sandbox.healing.slice(0, 3).map((step) => (
                <li key={step.id}>
                  <strong>Iteration {step.iteration}</strong>
                  <span>{step.fixSummary || "Applying fix"}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </section>}

      <section className={`panel-section mods-panel${modsExpanded ? " expanded" : ""}`} aria-label="Mods">
        <button
          type="button"
          className="mods-header"
          onClick={() => setModsExpanded((v) => !v)}
          aria-expanded={modsExpanded}
        >
          <Puzzle aria-hidden="true" />
          <span>Mods{mods.length > 0 ? ` (${mods.length})` : ""}</span>
          {mods.some((m) => m.last_verified && !m.last_verified.passed) && (
            <span className="mods-badge mods-badge--warn">needs fix</span>
          )}
          {mods.length > 0 && mods.every((m) => m.last_verified?.passed) && (
            <span className="mods-badge mods-badge--ok">all passing</span>
          )}
          <span className="mods-chevron">{modsExpanded ? "▲" : "▼"}</span>
          <button
            type="button"
            title="Refresh and re-apply mods"
            onClick={(e) => { e.stopPropagation(); void refreshAndApplyMods(projectId); }}
            className="icon-button mods-refresh"
          >
            <RefreshCcw aria-hidden="true" />
          </button>
        </button>
        {modsExpanded && (mods.length === 0 ? (
          <p className="empty">No mods yet. Ask Conjure to build one below.</p>
        ) : (
          <ul className="mod-list">
            {mods.map((mod) => {
              const verified = mod.last_verified;
              const verdict = verified?.passed
                ? "verified"
                : verified
                  ? "failed"
                  : "unverified";
              return (
                <li key={mod.id} className={`mod-item ${mod.status}`}>
                  <div className="mod-head">
                    <strong>{mod.name}</strong>
                    <span className={`mod-badge ${verdict}`}>{verdict}</span>
                  </div>
                  <p className="mod-prompt">{mod.prompt}</p>
                  {verified?.replay_url ? (
                    <a
                      className="replay-link"
                      href={verified.replay_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink aria-hidden="true" />
                      Sandbox replay
                    </a>
                  ) : null}
                  {editingMod?.id === mod.id ? (
                    <form className="mod-edit" onSubmit={submitModChange}>
                      <textarea
                        value={editingMod.prompt}
                        onChange={(event) =>
                          setEditingMod({ id: mod.id, prompt: event.target.value })
                        }
                        rows={2}
                      />
                      <div className="mod-edit-actions">
                        <button type="submit" className="mod-action">
                          Rebuild
                        </button>
                        <button
                          type="button"
                          className="mod-action ghost"
                          onClick={() => setEditingMod(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="mod-actions">
                      <button
                        type="button"
                        className="mod-action"
                        title="Change the prompt and rebuild this mod"
                        onClick={() => setEditingMod({ id: mod.id, prompt: mod.prompt })}
                      >
                        <Pencil aria-hidden="true" /> Change
                      </button>
                      <button
                        type="button"
                        className="mod-action danger"
                        title="Remove this mod"
                        onClick={() => void removeMod(mod)}
                      >
                        <Trash2 aria-hidden="true" /> Remove
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
      </section>

      {rules.length ? (
        <section className="rules-strip" aria-label="Memory rules">
          {rules.slice(0, 3).map((rule) => (
            <span key={rule}>{rule}</span>
          ))}
        </section>
      ) : null}

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask conjure to build a browser customization…"
          rows={3}
        />
        <div className="composer-actions">
          <button
            type="button"
            title="Hold Alt/Option to speak · double-tap to lock"
            className={`mic-button icon-button${voiceState !== "idle" ? " mic-active" : ""}${voiceState === "locked" ? " mic-locked" : ""}`}
            aria-label="Voice input"
            tabIndex={-1}
          >
            {voiceState === "transcribing" ? (
              <Loader2 aria-hidden="true" className="spin" />
            ) : voiceState === "speaking" ? (
              <Volume2 aria-hidden="true" />
            ) : (
              <Mic aria-hidden="true" />
            )}
          </button>
          <button type="submit" title="Send message" className="send-button" disabled={!input.trim()}>
            <Send aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  );
}

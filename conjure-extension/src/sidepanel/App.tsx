import * as Sentry from "@sentry/browser";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  MessageSquareText,
  Pencil,
  Puzzle,
  RefreshCcw,
  Send,
  Terminal,
  Trash2,
  XCircle
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type AgentProvider,
  type AgentPullRequest,
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

interface AgentRunState {
  active: boolean;
  provider?: AgentProvider;
  phrase: string;
  status?: string;
  statusDetail?: string;
  sessionUrl?: string;
  pullRequests: AgentPullRequest[];
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
  const [editingMod, setEditingMod] = useState<{ id: string; prompt: string } | null>(null);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [statusText, setStatusText] = useState("Ready");

  const socketRef = useRef<WebSocket | null>(null);
  const pendingOpenRef = useRef<Promise<WebSocket> | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);
  const projectIdRef = useRef(projectId);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

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
            addSystemMessage(`Applied ${applied} mod(s) and reloaded the current tab.`);
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

  const finalizeAssistant = useCallback((content?: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === currentAssistantIdRef.current
          ? { ...message, content: content || message.content, streaming: false }
          : message
      )
    );
    currentAssistantIdRef.current = null;
  }, []);

  const getCurrentTab = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE.GET_CURRENT_TAB
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
        const tabs = await getCurrentTab();
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
    [addSystemMessage, conversationId, getCurrentTab, openSocket]
  );

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
    await getCurrentTab();
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
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session }).catch(captureException);
  }, [projectId, conversationId, messages]);

  useEffect(() => {
    void getCurrentTab();
    chrome.runtime
      .sendMessage({ type: BACKGROUND_MESSAGE.RELOAD_CURRENT_TAB_ONCE })
      .catch(captureException);
  }, [getCurrentTab]);

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

      <section className="project-row" aria-label="Project">
        <label htmlFor="projectId">Project</label>
        <input
          id="projectId"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          disabled={connectionState === "connected"}
        />
        <button type="button" title="Refresh current tab" onClick={refreshTabs} className="icon-button">
          <RefreshCcw aria-hidden="true" />
        </button>
      </section>

      <section className="tabs-strip" aria-label="Current tab">
        {activeTabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-chip ${tab.active ? "active" : ""}`}
            title={tab.url}
            type="button"
          >
            <span>Current tab</span>
            <strong>{tab.title}</strong>
          </button>
        ))}
      </section>

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

      <section className="workbench agent-workbench" aria-label="Agent progress">
        <div className="panel-section agent-panel">
          <div className="section-title">
            <Terminal aria-hidden="true" />
            <h2>{providerLabel}</h2>
          </div>

          <div className={`status-line ${agentStatusClass}`}>
            {agentRun.active ? (
              <Loader2 aria-hidden="true" className="spin" />
            ) : agentStatusClass === "passed" ? (
              <CheckCircle2 aria-hidden="true" />
            ) : agentStatusClass === "failed" ? (
              <AlertTriangle aria-hidden="true" />
            ) : (
              <Circle aria-hidden="true" />
            )}
            <span>{agentRun.phrase}</span>
          </div>

          {agentRun.sessionUrl ? (
            <a className="replay-link" href={agentRun.sessionUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Agent session
            </a>
          ) : null}

          {pullRequestLinks.length ? (
            <ol className="agent-links">
              {pullRequestLinks.map((url, index) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Pull request {index + 1}
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
        </div>

        <div className="panel-section tools-panel">
          <div className="section-title">
            <Terminal aria-hidden="true" />
            <h2>Tools</h2>
          </div>
          {tools.length === 0 ? (
            <p className="empty">No tool calls yet.</p>
          ) : (
            <ol className="tool-list">
              {tools.slice(0, 5).map((tool) => (
                <li key={tool.id} className={tool.status}>
                  <span className="tool-icon">
                    {tool.status === "running" ? (
                      <Loader2 aria-hidden="true" className="spin" />
                    ) : (
                      <CheckCircle2 aria-hidden="true" />
                    )}
                  </span>
                  <span>
                    <strong>{tool.name}</strong>
                    {tool.args ? <code>{JSON.stringify(tool.args).slice(0, 120)}</code> : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel-section mods-panel" aria-label="Mods">
        <div className="section-title">
          <Puzzle aria-hidden="true" />
          <h2>Mods ({mods.length})</h2>
          <button
            type="button"
            title="Refresh and re-apply mods"
            onClick={() => void refreshAndApplyMods(projectId)}
            className="icon-button"
          >
            <RefreshCcw aria-hidden="true" />
          </button>
        </div>
        {mods.length === 0 ? (
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
                  {mod.websites?.length ? (
                    <div className="mod-websites" aria-label="Supported websites">
                      {mod.websites.map((website) => (
                        <span key={website}>{website}</span>
                      ))}
                    </div>
                  ) : null}
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
        )}
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
          placeholder="Ask conjure to build a browser customization..."
          rows={3}
        />
        <button type="submit" title="Send message" className="send-button" disabled={!input.trim()}>
          <Send aria-hidden="true" />
        </button>
      </form>
    </main>
  );
}

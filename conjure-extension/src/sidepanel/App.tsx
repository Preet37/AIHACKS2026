import * as Sentry from "@sentry/browser";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  EyeOff,
  ExternalLink,
  Loader2,
  MessageSquareText,
  MousePointer2,
  Pencil,
  Puzzle,
  RefreshCcw,
  Redo2,
  Save,
  Send,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Undo2,
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
  type RuntimeRequest,
  type RuntimeResult,
  type VisualEditOperation,
  type VisualEditSelection,
  type VisualEditSessionState,
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

interface VisualEditDraft {
  text: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  padding: string;
  margin: string;
  borderRadius: string;
  hidden: boolean;
  x: string;
  y: string;
  width: string;
  height: string;
}

const emptyVisualEditDraft: VisualEditDraft = {
  text: "",
  color: "#18201c",
  backgroundColor: "#ffffff",
  fontSize: "",
  padding: "",
  margin: "",
  borderRadius: "",
  hidden: false,
  x: "0",
  y: "0",
  width: "",
  height: ""
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

const replaceVisualOperation = (operations: VisualEditOperation[], operation: VisualEditOperation) => [
  ...operations.filter((candidate) => candidate.id !== operation.id),
  operation
];

const visualOperationId = (selection: VisualEditSelection, type: VisualEditOperation["type"]) =>
  `${type}:${selection.selector}`;

const parseCssNumber = (value: string | undefined) => {
  if (!value) return "";
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? String(Math.round(number)) : "";
};

const numericCssValue = (value: string) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? `${number}px` : "";
};

const finiteNumber = (value: string) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
};

const draftBoxValue = (value: number | undefined, fallback: string) =>
  typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : fallback;

const colorToHex = (value: string | undefined, fallback: string) => {
  if (!value) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return value.trim();
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return fallback;
  return [match[1], match[2], match[3]]
    .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0"))
    .join("")
    .replace(/^/, "#");
};

const visualDraftFromSelection = (selection: VisualEditSelection): VisualEditDraft => ({
  text: selection.text,
  color: colorToHex(selection.computedStyle.color, emptyVisualEditDraft.color),
  backgroundColor: colorToHex(
    selection.computedStyle.backgroundColor,
    emptyVisualEditDraft.backgroundColor
  ),
  fontSize: parseCssNumber(selection.computedStyle.fontSize),
  padding: parseCssNumber(selection.computedStyle.padding),
  margin: parseCssNumber(selection.computedStyle.margin),
  borderRadius: parseCssNumber(selection.computedStyle.borderRadius),
  hidden: selection.computedStyle.display === "none",
  x: "0",
  y: "0",
  width: String(Math.round(selection.rect.width)),
  height: String(Math.round(selection.rect.height))
});

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
  const [visualEditModId, setVisualEditModId] = useState("");
  const [visualEditSession, setVisualEditSession] = useState<VisualEditSessionState>({
    active: false,
    operations: [],
    undoDepth: 0,
    redoDepth: 0,
    staleOperationIds: []
  });
  const [visualEditDraft, setVisualEditDraft] = useState<VisualEditDraft>(emptyVisualEditDraft);
  const [visualEditPast, setVisualEditPast] = useState<VisualEditOperation[][]>([]);
  const [visualEditFuture, setVisualEditFuture] = useState<VisualEditOperation[][]>([]);
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
  const visualEditMod = useMemo(
    () => mods.find((mod) => mod.id === visualEditModId) || mods[0],
    [mods, visualEditModId]
  );
  const selectedVisualEdit = visualEditSession.selected;

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

  const sendVisualEditCommand = useCallback(async <T,>(message: RuntimeRequest): Promise<T> => {
    const response = await chrome.runtime.sendMessage(message);
    if (isRuntimeOk<T>(response)) return response.data;
    throw new Error(response?.error || "Visual edit command failed.");
  }, []);

  const previewVisualOperations = useCallback(
    async (operations: VisualEditOperation[]) => {
      if (!activeTab?.id) return;
      const staleOperationIds = new Set<string>();
      await sendVisualEditCommand({
        type: BACKGROUND_MESSAGE.DISCARD_VISUAL_EDITS,
        tabId: activeTab.id
      });
      for (const operation of operations) {
        const data = await sendVisualEditCommand<{ staleOperationIds?: string[] }>({
          type: BACKGROUND_MESSAGE.APPLY_VISUAL_EDIT,
          tabId: activeTab.id,
          operation
        });
        (data.staleOperationIds || []).forEach((id) => staleOperationIds.add(id));
      }
      setVisualEditSession((current) => ({
        ...current,
        staleOperationIds: Array.from(staleOperationIds)
      }));
    },
    [activeTab?.id, sendVisualEditCommand]
  );

  const startVisualEdit = useCallback(async () => {
    if (!activeTab?.id) {
      addSystemMessage("No active tab available for visual editing.");
      return;
    }
    if (!visualEditMod) {
      addSystemMessage("Create a mod before starting visual edit mode.");
      return;
    }

    const operations = [...(visualEditMod.visual_edits || [])];
    setStatusText("Starting visual edit");
    try {
      const data = await sendVisualEditCommand<{ staleOperationIds?: string[] }>({
        type: BACKGROUND_MESSAGE.START_VISUAL_EDIT,
        tabId: activeTab.id,
        modId: visualEditMod.id,
        visualEdits: operations
      });
      setVisualEditPast([]);
      setVisualEditFuture([]);
      setVisualEditSession({
        active: true,
        modId: visualEditMod.id,
        operations,
        undoDepth: 0,
        redoDepth: 0,
        staleOperationIds: data.staleOperationIds || []
      });
      setStatusText("Visual edit active");
    } catch (error) {
      setStatusText("Visual edit failed");
      addSystemMessage(error instanceof Error ? error.message : String(error));
    }
  }, [activeTab?.id, addSystemMessage, sendVisualEditCommand, visualEditMod]);

  const stopVisualEdit = useCallback(async () => {
    if (activeTab?.id) {
      try {
        await sendVisualEditCommand({
          type: BACKGROUND_MESSAGE.STOP_VISUAL_EDIT,
          tabId: activeTab.id
        });
      } catch (error) {
        captureException(error);
      }
    }
    setVisualEditSession((current) => ({ ...current, active: false, selected: undefined }));
    setStatusText("Visual edit stopped");
  }, [activeTab?.id, sendVisualEditCommand]);

  const toggleVisualEdit = useCallback(async () => {
    if (visualEditSession.active) {
      await stopVisualEdit();
      return;
    }
    await startVisualEdit();
  }, [startVisualEdit, stopVisualEdit, visualEditSession.active]);

  const pushVisualOperation = useCallback(
    async (operation: VisualEditOperation) => {
      if (!activeTab?.id || !visualEditSession.active) return;
      const currentOperations = visualEditSession.operations;
      const nextOperations = replaceVisualOperation(currentOperations, operation);
      const nextPast = [...visualEditPast, currentOperations].slice(-30);
      setVisualEditPast(nextPast);
      setVisualEditFuture([]);
      setVisualEditSession((current) => ({
        ...current,
        operations: nextOperations,
        undoDepth: nextPast.length,
        redoDepth: 0
      }));

      try {
        const data = await sendVisualEditCommand<{ staleOperationIds?: string[] }>({
          type: BACKGROUND_MESSAGE.APPLY_VISUAL_EDIT,
          tabId: activeTab.id,
          operation
        });
        setVisualEditSession((current) => ({
          ...current,
          staleOperationIds: data.staleOperationIds || []
        }));
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [
      activeTab?.id,
      addSystemMessage,
      sendVisualEditCommand,
      visualEditPast,
      visualEditSession.active,
      visualEditSession.operations
    ]
  );

  const updateVisualText = useCallback(
    (value: string) => {
      setVisualEditDraft((current) => ({ ...current, text: value }));
      if (!selectedVisualEdit?.editable) return;
      void pushVisualOperation({
        id: visualOperationId(selectedVisualEdit, "setText"),
        type: "setText",
        selector: selectedVisualEdit.selector,
        value,
        url: selectedVisualEdit.url
      });
    },
    [pushVisualOperation, selectedVisualEdit]
  );

  const updateVisualStyle = useCallback(
    (
      draftKey: keyof Pick<
        VisualEditDraft,
        "color" | "backgroundColor" | "fontSize" | "padding" | "margin" | "borderRadius"
      >,
      property: "color" | "backgroundColor" | "fontSize" | "padding" | "margin" | "borderRadius",
      value: string,
      cssValue = value
    ) => {
      setVisualEditDraft((current) => ({ ...current, [draftKey]: value }));
      if (!selectedVisualEdit?.editable) return;
      const operationId = visualOperationId(selectedVisualEdit, "setStyle");
      const existing = visualEditSession.operations.find(
        (operation): operation is Extract<VisualEditOperation, { type: "setStyle" }> =>
          operation.id === operationId && operation.type === "setStyle"
      );
      void pushVisualOperation({
        id: operationId,
        type: "setStyle",
        selector: selectedVisualEdit.selector,
        styles: {
          ...(existing?.styles || {}),
          [property]: cssValue
        },
        url: selectedVisualEdit.url
      });
    },
    [pushVisualOperation, selectedVisualEdit, visualEditSession.operations]
  );

  const updateVisualBox = useCallback(
    (
      draftKey: keyof Pick<VisualEditDraft, "x" | "y" | "width" | "height">,
      property: "x" | "y" | "width" | "height",
      value: string
    ) => {
      setVisualEditDraft((current) => ({ ...current, [draftKey]: value }));
      if (!selectedVisualEdit?.editable) return;
      const number = finiteNumber(value);
      if (number === undefined) return;
      const operationId = visualOperationId(selectedVisualEdit, "setBox");
      const existing = visualEditSession.operations.find(
        (operation): operation is Extract<VisualEditOperation, { type: "setBox" }> =>
          operation.id === operationId && operation.type === "setBox"
      );
      const nextBox: Extract<VisualEditOperation, { type: "setBox" }>["box"] = {
        ...(existing?.box || {}),
        [property]: number
      };
      if (property === "width" || property === "height") {
        nextBox.sizing = {
          ...(nextBox.sizing || {}),
          [property]: "fixed"
        };
      }
      void pushVisualOperation({
        id: operationId,
        type: "setBox",
        selector: selectedVisualEdit.selector,
        box: nextBox,
        url: selectedVisualEdit.url
      });
    },
    [pushVisualOperation, selectedVisualEdit, visualEditSession.operations]
  );

  const updateVisualHidden = useCallback(
    (hidden: boolean) => {
      setVisualEditDraft((current) => ({ ...current, hidden }));
      if (!selectedVisualEdit?.editable) return;
      void pushVisualOperation({
        id: visualOperationId(selectedVisualEdit, "hide"),
        type: "hide",
        selector: selectedVisualEdit.selector,
        hidden,
        url: selectedVisualEdit.url
      });
    },
    [pushVisualOperation, selectedVisualEdit]
  );

  const undoVisualEdit = useCallback(async () => {
    const previousOperations = visualEditPast[visualEditPast.length - 1];
    if (!previousOperations) return;
    const nextPast = visualEditPast.slice(0, -1);
    const nextFuture = [visualEditSession.operations, ...visualEditFuture].slice(0, 30);
    setVisualEditPast(nextPast);
    setVisualEditFuture(nextFuture);
    setVisualEditSession((current) => ({
      ...current,
      operations: previousOperations,
      undoDepth: nextPast.length,
      redoDepth: nextFuture.length
    }));
    await previewVisualOperations(previousOperations);
  }, [previewVisualOperations, visualEditFuture, visualEditPast, visualEditSession.operations]);

  const redoVisualEdit = useCallback(async () => {
    const nextOperations = visualEditFuture[0];
    if (!nextOperations) return;
    const nextPast = [...visualEditPast, visualEditSession.operations].slice(-30);
    const nextFuture = visualEditFuture.slice(1);
    setVisualEditPast(nextPast);
    setVisualEditFuture(nextFuture);
    setVisualEditSession((current) => ({
      ...current,
      operations: nextOperations,
      undoDepth: nextPast.length,
      redoDepth: nextFuture.length
    }));
    await previewVisualOperations(nextOperations);
  }, [previewVisualOperations, visualEditFuture, visualEditPast, visualEditSession.operations]);

  const discardVisualEdits = useCallback(async () => {
    if (activeTab?.id) {
      try {
        await sendVisualEditCommand({
          type: BACKGROUND_MESSAGE.DISCARD_VISUAL_EDITS,
          tabId: activeTab.id
        });
        await sendVisualEditCommand({
          type: BACKGROUND_MESSAGE.STOP_VISUAL_EDIT,
          tabId: activeTab.id
        });
      } catch (error) {
        captureException(error);
      }
    }
    setVisualEditPast([]);
    setVisualEditFuture([]);
    setVisualEditDraft(emptyVisualEditDraft);
    setVisualEditSession({
      active: false,
      modId: visualEditMod?.id,
      operations: [...(visualEditMod?.visual_edits || [])],
      undoDepth: 0,
      redoDepth: 0,
      staleOperationIds: []
    });
    setStatusText("Visual edits discarded");
  }, [activeTab?.id, sendVisualEditCommand, visualEditMod]);

  const saveVisualEdits = useCallback(async () => {
    if (!visualEditMod) return;
    const operations = visualEditSession.operations;
    setStatusText("Saving visual edits");
    try {
      if (activeTab?.id) {
        await sendVisualEditCommand({
          type: BACKGROUND_MESSAGE.COMMIT_VISUAL_EDITS,
          tabId: activeTab.id,
          operations
        });
      }
      const response = await fetch(createModUrl(projectIdRef.current, visualEditMod.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visual_edits: operations })
      });
      if (!response.ok) {
        throw new Error(`Backend returned ${response.status} saving visual edits.`);
      }
      const data = (await response.json()) as { mods?: ModRecord[]; bundles?: GeneratedBundle[] };
      setMods(data.mods || []);
      if (activeTab?.id) {
        try {
          await sendVisualEditCommand({
            type: BACKGROUND_MESSAGE.STOP_VISUAL_EDIT,
            tabId: activeTab.id
          });
        } catch (error) {
          captureException(error);
        }
      }
      await applyModBundles(data.bundles || []);
      setVisualEditPast([]);
      setVisualEditFuture([]);
      setVisualEditSession((current) => ({
        ...current,
        active: false,
        selected: undefined,
        operations,
        undoDepth: 0,
        redoDepth: 0
      }));
      setStatusText("Visual edits saved");
      addSystemMessage(`Saved ${operations.length} visual edit(s) on "${visualEditMod.name}".`);
    } catch (error) {
      setStatusText("Save failed");
      addSystemMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    activeTab?.id,
    addSystemMessage,
    applyModBundles,
    sendVisualEditCommand,
    visualEditMod,
    visualEditSession.operations
  ]);

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
    void getActiveTabs();
    chrome.runtime
      .sendMessage({ type: BACKGROUND_MESSAGE.RELOAD_ALL_TABS_ONCE })
      .catch(captureException);
  }, [getActiveTabs]);

  useEffect(() => {
    if (!mods.length) {
      setVisualEditModId("");
      return;
    }
    if (!visualEditModId || !mods.some((mod) => mod.id === visualEditModId)) {
      setVisualEditModId(mods[0].id);
    }
  }, [mods, visualEditModId]);

  useEffect(() => {
    const listener = (message: RuntimeRequest) => {
      if (message.type === CONTENT_MESSAGE.VISUAL_EDIT_SELECTION) {
        setVisualEditDraft(visualDraftFromSelection(message.payload));
        setVisualEditSession((current) => ({ ...current, selected: message.payload }));
        setStatusText(message.payload.editable ? "Element selected" : "Element not editable");
        return false;
      }

      if (message.type === CONTENT_MESSAGE.VISUAL_EDIT_PREVIEW) {
        const operation = message.payload.operation;
        if (operation) {
          setVisualEditSession((current) => ({
            ...current,
            operations: replaceVisualOperation(current.operations, operation),
            staleOperationIds: message.payload.staleOperationIds || []
          }));
          if (operation.type === "setBox") {
            setVisualEditDraft((current) => ({
              ...current,
              x: draftBoxValue(operation.box.x, current.x),
              y: draftBoxValue(operation.box.y, current.y),
              width: draftBoxValue(operation.box.width, current.width),
              height: draftBoxValue(operation.box.height, current.height)
            }));
          } else if (operation.type === "setText") {
            setVisualEditDraft((current) => ({
              ...current,
              text: operation.value
            }));
          } else if (operation.type === "setStyle" && operation.styles.fontSize) {
            setVisualEditDraft((current) => ({
              ...current,
              fontSize: parseCssNumber(operation.styles.fontSize)
            }));
          }
          return false;
        }
        setVisualEditSession((current) => ({
          ...current,
          staleOperationIds: message.payload.staleOperationIds || []
        }));
        if (message.payload.error) setStatusText("Preview failed");
        return false;
      }

      if (message.type === CONTENT_MESSAGE.VISUAL_EDIT_COMMIT) {
        setVisualEditSession((current) => ({
          ...current,
          staleOperationIds: message.payload.staleOperationIds || []
        }));
        return false;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

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
        <button type="button" title="Refresh active tabs" onClick={refreshTabs} className="icon-button">
          <RefreshCcw aria-hidden="true" />
        </button>
      </section>

      <section className="tabs-strip" aria-label="Open tabs">
        {activeTabs.slice(0, 6).map((tab) => (
          <button
            key={tab.id}
            className={`tab-chip ${tab.active ? "active" : ""}`}
            title={tab.url}
            type="button"
          >
            <span>{tab.active ? "Active" : "Tab"}</span>
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

      <section className="panel-section visual-editor-panel" aria-label="Visual editor">
        <div className="section-title">
          <SlidersHorizontal aria-hidden="true" />
          <h2>Visual edit</h2>
          <button
            type="button"
            title={visualEditSession.active ? "Stop visual edit" : "Start visual edit"}
            onClick={() => void toggleVisualEdit()}
            className={`icon-button ${visualEditSession.active ? "active" : ""}`}
            disabled={!activeTab || !visualEditMod}
          >
            <MousePointer2 aria-hidden="true" />
          </button>
        </div>

        <div className="visual-editor-toolbar">
          <select
            value={visualEditMod?.id || ""}
            onChange={(event) => setVisualEditModId(event.target.value)}
            disabled={visualEditSession.active || mods.length === 0}
          >
            {mods.length === 0 ? <option value="">No mods</option> : null}
            {mods.map((mod) => (
              <option key={mod.id} value={mod.id}>
                {mod.name}
              </option>
            ))}
          </select>
          <span className={`visual-edit-pill ${visualEditSession.active ? "active" : ""}`}>
            {visualEditSession.active ? "active" : "idle"}
          </span>
          <span className="visual-edit-pill">
            {visualEditSession.operations.length} edit{visualEditSession.operations.length === 1 ? "" : "s"}
          </span>
        </div>

        {visualEditSession.staleOperationIds.length > 0 ? (
          <div className="visual-stale">
            <AlertTriangle aria-hidden="true" />
            <span>{visualEditSession.staleOperationIds.length} stale edit(s)</span>
          </div>
        ) : null}

        {selectedVisualEdit ? (
          <div className="visual-selection">
            <div className="visual-selection-head">
              <strong>{selectedVisualEdit.tag}</strong>
              <span>{Math.round(selectedVisualEdit.rect.width)} x {Math.round(selectedVisualEdit.rect.height)}</span>
            </div>
            <code title={selectedVisualEdit.selector}>{selectedVisualEdit.selector}</code>
            {selectedVisualEdit.ownership.hints.length ? (
              <p>{selectedVisualEdit.ownership.hints.slice(0, 2).join(" · ")}</p>
            ) : selectedVisualEdit.ownership.modId || visualEditMod ? (
              <p>Editing {visualEditMod?.name || selectedVisualEdit.ownership.modId}</p>
            ) : (
              <p>No DOM ownership marker</p>
            )}
            {!selectedVisualEdit.editable ? (
              <div className="visual-stale">
                <AlertTriangle aria-hidden="true" />
                <span>{selectedVisualEdit.notEditableReason || "Element is not editable"}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="empty">{visualEditSession.active ? "No element selected." : "Visual edit is idle."}</p>
        )}

        {selectedVisualEdit ? (
          <div className="visual-controls">
            <label className="visual-field visual-field-full">
              <span>Text</span>
              <textarea
                value={visualEditDraft.text}
                onChange={(event) => updateVisualText(event.target.value)}
                rows={2}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field color-field">
              <span>Color</span>
              <input
                type="color"
                value={visualEditDraft.color}
                onChange={(event) => updateVisualStyle("color", "color", event.target.value)}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field color-field">
              <span>Background</span>
              <input
                type="color"
                value={visualEditDraft.backgroundColor}
                onChange={(event) =>
                  updateVisualStyle("backgroundColor", "backgroundColor", event.target.value)
                }
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Font</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.fontSize}
                onChange={(event) =>
                  updateVisualStyle(
                    "fontSize",
                    "fontSize",
                    event.target.value,
                    numericCssValue(event.target.value)
                  )
                }
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Padding</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.padding}
                onChange={(event) =>
                  updateVisualStyle(
                    "padding",
                    "padding",
                    event.target.value,
                    numericCssValue(event.target.value)
                  )
                }
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Margin</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.margin}
                onChange={(event) =>
                  updateVisualStyle(
                    "margin",
                    "margin",
                    event.target.value,
                    numericCssValue(event.target.value)
                  )
                }
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Radius</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.borderRadius}
                onChange={(event) =>
                  updateVisualStyle(
                    "borderRadius",
                    "borderRadius",
                    event.target.value,
                    numericCssValue(event.target.value)
                  )
                }
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>X</span>
              <input
                type="number"
                value={visualEditDraft.x}
                onChange={(event) => updateVisualBox("x", "x", event.target.value)}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Y</span>
              <input
                type="number"
                value={visualEditDraft.y}
                onChange={(event) => updateVisualBox("y", "y", event.target.value)}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Width</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.width}
                onChange={(event) => updateVisualBox("width", "width", event.target.value)}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-field">
              <span>Height</span>
              <input
                type="number"
                min="0"
                value={visualEditDraft.height}
                onChange={(event) => updateVisualBox("height", "height", event.target.value)}
                disabled={!selectedVisualEdit.editable}
              />
            </label>

            <label className="visual-toggle">
              <input
                type="checkbox"
                checked={visualEditDraft.hidden}
                onChange={(event) => updateVisualHidden(event.target.checked)}
                disabled={!selectedVisualEdit.editable}
              />
              <EyeOff aria-hidden="true" />
              <span>Hide</span>
            </label>
          </div>
        ) : null}

        <div className="visual-editor-actions">
          <button
            type="button"
            className="icon-button"
            title="Undo"
            onClick={() => void undoVisualEdit()}
            disabled={!visualEditSession.active || visualEditPast.length === 0}
          >
            <Undo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Redo"
            onClick={() => void redoVisualEdit()}
            disabled={!visualEditSession.active || visualEditFuture.length === 0}
          >
            <Redo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mod-action"
            onClick={() => void saveVisualEdits()}
            disabled={!visualEditSession.active || !visualEditMod}
          >
            <Save aria-hidden="true" /> Save
          </button>
          <button
            type="button"
            className="mod-action ghost"
            onClick={() => void discardVisualEdits()}
            disabled={!visualEditSession.active}
          >
            Discard
          </button>
        </div>
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

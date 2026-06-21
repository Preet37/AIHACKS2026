import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "../shared/config";
import {
  DEFAULT_FALLBACK_HOTKEY,
  FALLBACK_HOTKEY_STORAGE_KEY,
  eventMatchesHotkey,
  isEditableTarget,
  normalizeHotkey
} from "../shared/keybind";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  PAGE_HOOK_SOURCE,
  type ApplyVisualEditMessage,
  type CommitVisualEditsMessage,
  type ConsoleLevel,
  type DiscardVisualEditsMessage,
  type GeneratedModErrorMessage,
  type GetElementHtmlMessage,
  type GetPageContentMessage,
  type PageContentResult,
  type RuntimeRequest,
  type RuntimeResult,
  type StartVisualEditMessage,
  type StopVisualEditMessage,
  type VisualEditComputedStyle,
  type VisualEditOperation,
  type VisualEditPreviewMessage,
  type VisualEditRect,
  type VisualEditSelection,
  type VisualEditSelectionMessage
} from "../shared/messages";

declare global {
  interface Window {
    __CONJURE_CONTENT_HOOKED__?: boolean;
  }
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
    Sentry.setTag("conjure.surface", "content");
  } catch {
    // Sentry is optional and must never break host pages.
  }
};

let commandHost: HTMLDivElement | null = null;
let commandShadow: ShadowRoot | null = null;
let commandOpen = false;
let selectedSuggestion = 0;
let overlayFontsLoaded = false;
let fallbackHotkey = DEFAULT_FALLBACK_HOTKEY;

const overlayFontUrl = (path: string) => {
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return path;
  }
};

const commandStyles = () => `
  @font-face {
    font-family: "Silkscreen";
    src: url("${overlayFontUrl("fonts/Silkscreen-Regular.woff2")}") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "JetBrains Mono";
    src: url("${overlayFontUrl("fonts/JetBrainsMono-Regular.woff2")}") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "JetBrains Mono";
    src: url("${overlayFontUrl("fonts/JetBrainsMono-Medium.woff2")}") format("woff2");
    font-weight: 500;
    font-style: normal;
    font-display: swap;
  }
  :host {
    --cj-ground: #08080F;
    --cj-surface: #101026;
    --cj-surface-2: #16163A;
    --cj-overlay-loud: #222290;
    --cj-text: #F0F0F5;
    --cj-dim: #8A8AA4;
    --cj-faint: #54546E;
    --cj-accent: #6C6AF5;
    --cj-accent-bright: #ADABFF;
    --cj-accent-wash: rgba(108, 106, 245, 0.16);
    --cj-line: rgba(240, 240, 245, 0.14);
    --cj-line-strong: rgba(240, 240, 245, 0.28);
    --cj-fs-micro: 11px;
    --cj-fs-body: 13px;
    --cj-fs-label: 16px;
    --cj-dur-fast: 120ms;
    --cj-dur-med: 180ms;
    --cj-ease: cubic-bezier(0.2, 0, 0, 1);
    all: initial;
    color-scheme: dark;
    font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
  }
  * {
    box-sizing: border-box;
    border-radius: 0;
    font-family: inherit;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: color-mix(in srgb, var(--cj-overlay-loud) 32%, transparent);
    display: grid;
    align-items: start;
    justify-items: center;
    padding-top: max(72px, 12vh);
    animation: cj-overlay-in var(--cj-dur-med) var(--cj-ease);
  }
  .palette {
    width: min(620px, calc(100vw - 32px));
    border: 1px solid var(--cj-overlay-loud);
    background: var(--cj-surface);
    color: var(--cj-text);
    animation: cj-palette-in var(--cj-dur-med) var(--cj-ease);
  }
  form {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    padding: 0 16px;
    border-bottom: 1px solid var(--cj-line);
  }
  .marker,
  .cursor {
    color: var(--cj-accent-bright);
  }
  .cursor {
    animation: cj-cursor 1s steps(1) infinite;
  }
  input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--cj-text);
    font-size: var(--cj-fs-label);
    caret-color: var(--cj-accent);
  }
  input::placeholder {
    color: var(--cj-faint);
  }
  .chip {
    border: 1px solid var(--cj-line);
    padding: 1px 5px;
    color: var(--cj-dim);
    font-size: var(--cj-fs-micro);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  button {
    width: 100%;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    border: 0;
    border-bottom: 1px solid var(--cj-line);
    background: transparent;
    color: var(--cj-dim);
    font-size: var(--cj-fs-body);
    text-align: left;
    cursor: pointer;
  }
  li:last-child button {
    border-bottom: 0;
  }
  button[data-active="true"] {
    border-left: 1px solid var(--cj-accent);
    background: var(--cj-accent-wash);
    color: var(--cj-text);
    animation: cj-row-settle var(--cj-dur-fast) var(--cj-ease);
  }
  .block {
    width: 9px;
    height: 9px;
    border: 1px solid var(--cj-faint);
  }
  button[data-active="true"] .block {
    border-color: var(--cj-accent);
    background: var(--cj-accent);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint,
  footer {
    color: var(--cj-faint);
    font-size: var(--cj-fs-micro);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--cj-line);
  }
  kbd {
    border: 1px solid var(--cj-line);
    padding: 1px 5px;
    font: inherit;
    color: var(--cj-dim);
  }
  @keyframes cj-overlay-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes cj-palette-in {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes cj-cursor {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }
  @keyframes cj-row-settle {
    from { opacity: 0.72; transform: translateX(-1px); }
    to { opacity: 1; transform: translateX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .palette,
    button[data-active="true"] {
      animation: none;
    }
    .cursor {
      opacity: 1;
      animation: none;
    }
  }
`;

const loadOverlayFonts = () => {
  if (overlayFontsLoaded || typeof FontFace === "undefined" || !document.fonts) return;
  overlayFontsLoaded = true;
  const faces = [
    new FontFace("JetBrains Mono", `url("${overlayFontUrl("fonts/JetBrainsMono-Regular.woff2")}")`, {
      weight: "400"
    }),
    new FontFace("JetBrains Mono", `url("${overlayFontUrl("fonts/JetBrainsMono-Medium.woff2")}")`, {
      weight: "500"
    }),
    new FontFace("Silkscreen", `url("${overlayFontUrl("fonts/Silkscreen-Regular.woff2")}")`, {
      weight: "400"
    })
  ];

  for (const face of faces) {
    face
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => undefined);
  }
};

const commandSuggestions = [
  {
    id: "create",
    label: "create mod from this page",
    hint: "enter"
  },
  {
    id: "design",
    label: "open design workspace",
    hint: "design"
  },
  {
    id: "track",
    label: "open run trace",
    hint: "track"
  }
] as const;

const sendBackgroundMessage = async (message: RuntimeRequest) => {
  if (!isRuntimeAvailable()) return;
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Runtime may disappear during extension reload.
  }
};

const closeCommandBar = () => {
  commandOpen = false;
  commandHost?.remove();
  commandHost = null;
  commandShadow = null;
  selectedSuggestion = 0;
};

const commitSuggestion = (query: string) => {
  const selected = commandSuggestions[selectedSuggestion];
  if (selected.id === "design") {
    void sendBackgroundMessage({ type: BACKGROUND_MESSAGE.OPEN_DESIGN_TAB });
  } else if (selected.id === "track") {
    void sendBackgroundMessage({ type: BACKGROUND_MESSAGE.OPEN_TRACE_TAB });
  } else if (query.trim()) {
    void sendBackgroundMessage({ type: BACKGROUND_MESSAGE.OPEN_TRACE_TAB });
  }
  closeCommandBar();
};

const renderCommandBar = () => {
  if (!commandShadow) return;
  commandShadow.innerHTML = "";

  const style = document.createElement("style");
  style.textContent = commandStyles();

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Conjure command bar");

  const palette = document.createElement("section");
  palette.className = "palette";

  const form = document.createElement("form");
  const marker = document.createElement("span");
  marker.className = "marker";
  marker.textContent = "■";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "block youtube shorts";
  input.setAttribute("aria-label", "Command");
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = "▌";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = "⌘K";
  form.append(marker, input, cursor, chip);

  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Command suggestions");

  const renderRows = () => {
    list.innerHTML = "";
    commandSuggestions.forEach((suggestion, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "none");
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.active = String(index === selectedSuggestion);
      button.setAttribute("aria-selected", String(index === selectedSuggestion));

      const block = document.createElement("span");
      block.className = "block";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = suggestion.label;
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = suggestion.hint;

      button.append(block, label, hint);
      button.addEventListener("mouseenter", () => {
        selectedSuggestion = index;
        renderRows();
      });
      button.addEventListener("click", () => {
        selectedSuggestion = index;
        commitSuggestion(input.value);
      });
      item.append(button);
      list.append(item);
    });
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    commitSuggestion(input.value);
  });

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeCommandBar();
  });

  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandBar();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedSuggestion = (selectedSuggestion + 1) % commandSuggestions.length;
      renderRows();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedSuggestion = (selectedSuggestion - 1 + commandSuggestions.length) % commandSuggestions.length;
      renderRows();
    }
  });

  const footer = document.createElement("footer");
  footer.innerHTML = "<span><kbd>↑↓</kbd> navigate</span><span><kbd>esc</kbd> cancel</span>";

  renderRows();
  palette.append(form, list, footer);
  backdrop.append(palette);
  commandShadow.append(style, backdrop);
  input.focus();
};

const openCommandBar = () => {
  if (!document.documentElement) return;
  if (commandOpen) {
    closeCommandBar();
    return;
  }
  commandOpen = true;
  loadOverlayFonts();
  commandHost = document.createElement("div");
  commandHost.id = "conjure-command-bar-root";
  commandShadow = commandHost.attachShadow({ mode: "open" });
  document.documentElement.appendChild(commandHost);
  renderCommandBar();
};

const loadFallbackHotkey = () => {
  if (!isRuntimeAvailable() || !chrome.storage?.local) return;
  chrome.storage.local
    .get(FALLBACK_HOTKEY_STORAGE_KEY)
    .then((stored) => {
      const value = stored[FALLBACK_HOTKEY_STORAGE_KEY];
      fallbackHotkey = normalizeHotkey(typeof value === "string" ? value : DEFAULT_FALLBACK_HOTKEY);
    })
    .catch(() => undefined);
};

const installFallbackHotkey = () => {
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isRuntimeAvailable() || event.defaultPrevented || isEditableTarget(event.target)) return;
      if (!eventMatchesHotkey(event, fallbackHotkey)) return;
      event.preventDefault();
      openCommandBar();
    },
    true
  );

  if (isRuntimeAvailable() && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const next = changes[FALLBACK_HOTKEY_STORAGE_KEY]?.newValue;
      if (typeof next === "string") fallbackHotkey = normalizeHotkey(next);
    });
  }
};

// Wispr-Flow push-to-talk: relay plain Alt/Option key (held) from the focused
// web page to the side panel, which drives start/stop voice capture. Alt+K
// (command bar) still works because it carries the extra K key.
let voiceHotkeyDown = false;
const installVoiceHotkeyRelay = () => {
  const relay = (event: "keydown" | "keyup") =>
    void safeSendMessage({ type: CONTENT_MESSAGE.VOICE_HOTKEY, event });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Alt" || e.repeat || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isEditableTarget(e.target)) return;
    if (voiceHotkeyDown) return;
    voiceHotkeyDown = true;
    relay("keydown");
  });

  document.addEventListener("keyup", (e) => {
    if (e.key !== "Alt") return;
    if (!voiceHotkeyDown) return;
    voiceHotkeyDown = false;
    relay("keyup");
  });

  // Releasing focus (e.g. Alt+Tab) should not leave the mic stuck on.
  window.addEventListener("blur", () => {
    if (!voiceHotkeyDown) return;
    voiceHotkeyDown = false;
    relay("keyup");
  });
};

initSentry();

const captureException = (error: unknown) => {
  if (CONJURE_CONFIG.sentry.enabled) {
    Sentry.captureException(error);
  }
};

const isRuntimeAvailable = () => {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

const safeSendMessage = async (message: RuntimeRequest) => {
  if (!isRuntimeAvailable()) return;
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Extension reloads invalidate the content-script context. Treat that as a
    // lifecycle event, not an application error.
  }
};

const limitString = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return { value: value.slice(0, maxChars), truncated: true };
};

const serializeValue = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack || ""}`.trim();
  }

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const sendConsoleEvent = (
  level: ConsoleLevel,
  args: unknown[],
  source: "console" | "window" | "unhandledrejection"
) => {
  const serialized = args.map(serializeValue);
  const text = serialized.join(" ");

  void safeSendMessage({
      type: CONTENT_MESSAGE.CONSOLE_EVENT,
      payload: {
        level,
        text: text.slice(0, 12000),
        args: serialized.map((arg) => arg.slice(0, 4000)),
        url: location.href,
        timestamp: Date.now(),
        source
      }
    });
};

const installIsolatedWorldHooks = () => {
  if (window.__CONJURE_CONTENT_HOOKED__) return;
  window.__CONJURE_CONTENT_HOOKED__ = true;

  const levels: ConsoleLevel[] = ["debug", "info", "log", "warn", "error"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      sendConsoleEvent(level, args, "console");
      original(...args);
    };
  }

  window.addEventListener(
    "error",
    (event) => {
      sendConsoleEvent("error", [event.message, event.filename, event.lineno, event.error], "window");
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    (event) => {
      sendConsoleEvent("error", [event.reason], "unhandledrejection");
    },
    true
  );
};

const sanitizeElement = (element: Element): Element => {
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

  return clone;
};

const getPageContent = (message: GetPageContentMessage): RuntimeResult<PageContentResult> => {
  const maxChars = message.maxChars || CONJURE_CONFIG.pageContentMaxChars;
  const text = limitString(document.body?.innerText || document.documentElement.innerText || "", maxChars);
  const html = message.includeHtml
    ? limitString(document.documentElement.outerHTML || "", maxChars)
    : { value: "", truncated: false };

  return {
    ok: true,
    data: {
      requestId: message.requestId,
      contentType: "page",
      url: location.href,
      title: document.title,
      text: text.value,
      html: html.value,
      truncated: text.truncated || html.truncated
    }
  };
};

const getElementHtml = (message: GetElementHtmlMessage): RuntimeResult<PageContentResult> => {
  const element = document.querySelector(message.selector);
  if (!element) {
    return { ok: false, error: `No element matched selector: ${message.selector}` };
  }

  const maxChars = message.maxChars || CONJURE_CONFIG.pageContentMaxChars;
  const sanitized = sanitizeElement(element);
  const html = limitString(sanitized.outerHTML, maxChars);
  const text = limitString((element as HTMLElement).innerText || element.textContent || "", maxChars);

  return {
    ok: true,
    data: {
      requestId: message.requestId,
      contentType: "element",
      url: location.href,
      title: document.title,
      text: text.value,
      html: html.value,
      selector: message.selector,
      truncated: text.truncated || html.truncated
    }
  };
};

const VISUAL_EDIT_OVERLAY_ATTR = "data-conjure-visual-edit-overlay";
const CONJURE_OWNED_SELECTOR =
  '[data-conjure-owned="true"], [data-conjure-mod-id], [data-conjure-element-id]';
const VISUAL_EDIT_Z_INDEX = "2147483647";
const TEXT_SCALE_MIN = 0.25;
const TEXT_SCALE_MAX = 4;
const TEXT_FONT_MIN = 8;
const visualEditTextLimit = 2000;
const textResizeTags = new Set([
  "a",
  "b",
  "blockquote",
  "cite",
  "code",
  "dd",
  "dt",
  "em",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "label",
  "li",
  "p",
  "pre",
  "small",
  "span",
  "strong",
  "time"
]);
const textInputTypes = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url"
]);
const stableAttributePriority = [
  "data-conjure-id",
  "data-conjure-element-id",
  "data-conjure-key",
  "data-conjure-mod-id",
  "data-testid",
  "data-test-id",
  "data-qa",
  "data-cy",
  "data-component",
  "data-slot"
];
const stylePropertyNames: Array<keyof VisualEditComputedStyle> = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "padding",
  "margin",
  "borderRadius",
  "display",
  "position",
  "width",
  "height",
  "transform",
  "opacity"
];

interface ElementSnapshot {
  element: Element;
  selector: string;
  styleAttribute: string | null;
  textContent: string | null;
  inputValue?: string;
}

type VisualDragMode = "move" | "resize" | "text-resize";
type VisualResizeHandle =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
type VisualResizeSideHandle = Extract<VisualResizeHandle, "left" | "right" | "top" | "bottom">;
type VisualEditBox = Extract<VisualEditOperation, { type: "setBox" }>["box"];
type VisualHugInsets = Required<NonNullable<VisualEditBox["hug"]>>;

interface VisualHugContentBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface VisualResizeLayoutShift {
  leftPerWidth: number;
  rightPerWidth: number;
  topPerHeight: number;
  bottomPerHeight: number;
}

interface VisualBoxDragState {
  mode: Exclude<VisualDragMode, "text-resize">;
  handle: VisualResizeHandle;
  selector: string;
  operationId: string;
  startClientX: number;
  startClientY: number;
  startBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  startRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  baseBox: Partial<VisualEditBox>;
  resizeLayoutShift: VisualResizeLayoutShift;
  moveBounds?: {
    minDeltaX: number;
    maxDeltaX: number;
    minDeltaY: number;
    maxDeltaY: number;
  };
  moved: boolean;
}

interface VisualTextDragState {
  mode: "text-resize";
  handle: VisualResizeHandle;
  selector: string;
  operationId: string;
  startClientX: number;
  startClientY: number;
  startFontSize: number;
  baseStyles: Extract<VisualEditOperation, { type: "setStyle" }>["styles"];
  moved: boolean;
}

type VisualDragState = VisualBoxDragState | VisualTextDragState;

interface InlineTextEditState {
  element: HTMLElement;
  selector: string;
  contentEditableAttribute: string | null;
  spellcheckAttribute: string | null;
  dirAttribute: string | null;
  styleDirection: string;
  styleUnicodeBidi: string;
}

let visualEditActive = false;
let hoverOutline: HTMLDivElement | null = null;
let selectionOutline: HTMLDivElement | null = null;
let selectedElement: Element | null = null;
let previewOperations: VisualEditOperation[] = [];
let previewSnapshots = new Map<string, ElementSnapshot>();
let retryObserver: MutationObserver | null = null;
let retryTimer: number | undefined;
let dragState: VisualDragState | null = null;
let inlineTextEditState: InlineTextEditState | null = null;
let suppressNextVisualClick = false;
let previousVisualCursor = "";
let selectionOutlineFrame: number | undefined;

const cssEscape = (value: string) => {
  const css = (globalThis as unknown as { CSS?: { escape?: (raw: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
};

const toKebabCase = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const px = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `${value}px` : undefined;

const finiteOrFallback = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const parseCssPixel = (value: string | undefined, fallback = 0) => {
  const number = Number.parseFloat(value || "");
  return Number.isFinite(number) ? number : fallback;
};

const isOverlayElement = (element: Element | null) =>
  Boolean(element?.closest(`[${VISUAL_EDIT_OVERLAY_ATTR}]`));

const eventTargetElement = (target: EventTarget | null) => {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};

const isVisualEditHitCandidate = (element: Element | null) =>
  Boolean(
    element &&
      !isOverlayElement(element) &&
      element !== document.documentElement &&
      element !== document.body
  );

const isConjureOwnedElement = (element: Element | null) =>
  Boolean(isVisualEditHitCandidate(element) && element?.closest(CONJURE_OWNED_SELECTOR));

const consumeVisualEditEvent = (event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

const blockNonConjureVisualEditEvent = (event: MouseEvent) => {
  if (!visualEditActive) return false;
  if (isConjureOwnedElement(eventTargetElement(event.target))) return false;
  consumeVisualEditEvent(event);
  return true;
};

const isEditableElement = (element: Element) => {
  const tag = element.tagName.toLowerCase();
  if (["canvas", "iframe", "object", "embed", "video"].includes(tag)) {
    return { editable: false, reason: `${tag} editing is not supported in visual edit v1.` };
  }
  if (element.namespaceURI && element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    return { editable: false, reason: "SVG/WebGL content is not editable in visual edit v1." };
  }
  return { editable: true, reason: undefined };
};

const hasDirectText = (element: Element) =>
  Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
  );

const hasVisibleText = (element: HTMLElement) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return Boolean(element.value || element.placeholder);
  }
  return Boolean((element.innerText || element.textContent || "").trim());
};

const isTextResizeElement = (element: Element) => {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement) return textInputTypes.has(element.type);
  if (element instanceof HTMLTextAreaElement) return true;
  const tag = element.tagName.toLowerCase();
  if (["button", "select", "option"].includes(tag)) return false;
  return textResizeTags.has(tag) || (hasDirectText(element) && element.children.length === 0);
};

const isInlineTextEditElement = (element: Element | null): element is HTMLElement => {
  if (!(element instanceof HTMLElement) || isOverlayElement(element)) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && !textInputTypes.has(element.type)) return false;
    return !element.disabled && !element.readOnly;
  }
  if (["select", "option"].includes(element.tagName.toLowerCase())) return false;
  return hasDirectText(element) && hasVisibleText(element);
};

const isTextMoveElement = (element: Element | null): element is HTMLElement => {
  if (!(element instanceof HTMLElement) || isOverlayElement(element)) return false;
  return hasVisibleText(element) && (isTextResizeElement(element) || hasDirectText(element));
};

type VisualFontElement = HTMLElement & { __conjureVisualBaseFontSize?: number };

const textScaleTargets = (root: Element) => {
  if (!(root instanceof HTMLElement)) return [];
  return [root, ...Array.from(root.querySelectorAll("*"))].filter((element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || isOverlayElement(element) || !hasVisibleText(element)) return false;
    return (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      hasDirectText(element) ||
      textResizeTags.has(element.tagName.toLowerCase())
    );
  });
};

const baseFontSizeForElement = (element: HTMLElement) => {
  const fontElement = element as VisualFontElement;
  if (
    typeof fontElement.__conjureVisualBaseFontSize === "number" &&
    Number.isFinite(fontElement.__conjureVisualBaseFontSize)
  ) {
    return fontElement.__conjureVisualBaseFontSize;
  }
  const fontSize = parseCssPixel(getComputedStyle(element).fontSize, 16);
  fontElement.__conjureVisualBaseFontSize = fontSize;
  return fontSize;
};

const fitTextToParent = (element: HTMLElement, containerOverride?: HTMLElement) => {
  const parent = element.parentElement;
  const container = containerOverride || (parent && parent !== document.documentElement ? parent : element);
  const containerRect = container.getBoundingClientRect();
  const availableWidth = Math.max(1, container.clientWidth || containerRect.width);
  const availableHeight = Math.max(1, container.clientHeight || containerRect.height);
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight)) return;

  element.style.maxWidth = "100%";
  element.style.maxHeight = "100%";
  element.style.overflow = "hidden";
  element.style.overflowWrap = "anywhere";
  element.style.wordBreak = "break-word";
  element.style.boxSizing = "border-box";
  if (getComputedStyle(element).display === "inline") {
    element.style.display = "inline-block";
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const overflowWidth = element.scrollWidth > availableWidth + 1;
    const overflowHeight = element.scrollHeight > availableHeight + 1;
    if (!overflowWidth && !overflowHeight) return;
    const current = parseCssPixel(getComputedStyle(element).fontSize, 16);
    if (current <= TEXT_FONT_MIN) return;
    const widthRatio = overflowWidth ? availableWidth / Math.max(1, element.scrollWidth) : 1;
    const heightRatio = overflowHeight ? availableHeight / Math.max(1, element.scrollHeight) : 1;
    element.style.fontSize = `${Math.max(
      TEXT_FONT_MIN,
      Math.floor(current * Math.min(widthRatio, heightRatio) * 0.98)
    )}px`;
  }
};

const fitEditedTextElement = (element: HTMLElement) => {
  const tag = element.tagName.toLowerCase();
  fitTextToParent(element, ["button", "input", "textarea"].includes(tag) ? element : undefined);
};

const scaleTextForBox = (root: Element, scale: number | undefined) => {
  if (typeof scale !== "number" || !Number.isFinite(scale)) return;
  const boundedScale = clampNumber(scale, TEXT_SCALE_MIN, TEXT_SCALE_MAX);
  const rootElement = root instanceof HTMLElement ? root : undefined;
  for (const element of textScaleTargets(root)) {
    element.style.fontSize = `${Math.max(
      TEXT_FONT_MIN,
      Math.round(baseFontSizeForElement(element) * boundedScale)
    )}px`;
    fitTextToParent(element, element === rootElement ? rootElement : undefined);
  }
};

const includeHugBounds = (
  bounds: { left: number; right: number; top: number; bottom: number; hasContent: boolean },
  left: number,
  top: number,
  right: number,
  bottom: number
) => {
  if (![left, top, right, bottom].every(Number.isFinite)) return;
  if (right <= left || bottom <= top) return;
  bounds.left = Math.min(bounds.left, left);
  bounds.right = Math.max(bounds.right, right);
  bounds.top = Math.min(bounds.top, top);
  bounds.bottom = Math.max(bounds.bottom, bottom);
  bounds.hasContent = true;
};

const includeDirectTextBounds = (
  element: HTMLElement,
  rootRect: DOMRect,
  bounds: { left: number; right: number; top: number; bottom: number; hasContent: boolean }
) => {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      includeHugBounds(
        bounds,
        rect.left - rootRect.left,
        rect.top - rootRect.top,
        rect.right - rootRect.left,
        rect.bottom - rootRect.top
      );
    }
    range.detach();
  }
};

const isVisibleHugElement = (element: HTMLElement) => {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
};

const isHugContentElement = (element: HTMLElement) => {
  const tag = element.tagName.toLowerCase();
  return (
    element.children.length === 0 ||
    hasDirectText(element) ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    ["button", "canvas", "img", "picture", "svg", "video"].includes(tag)
  );
};

const measureHugContentBounds = (root: Element): VisualHugContentBounds | undefined => {
  if (!(root instanceof HTMLElement) || !isVisibleHugElement(root)) return undefined;
  const rootRect = root.getBoundingClientRect();
  const bounds = {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
    hasContent: false
  };

  includeDirectTextBounds(root, rootRect, bounds);

  for (const candidate of Array.from(root.querySelectorAll("*"))) {
    if (
      !(candidate instanceof HTMLElement) ||
      isOverlayElement(candidate) ||
      !isConjureOwnedElement(candidate) ||
      !isVisibleHugElement(candidate)
    ) {
      continue;
    }

    includeDirectTextBounds(candidate, rootRect, bounds);
    if (!isHugContentElement(candidate)) continue;

    const rect = candidate.getBoundingClientRect();
    includeHugBounds(
      bounds,
      rect.left - rootRect.left,
      rect.top - rootRect.top,
      rect.right - rootRect.left,
      rect.bottom - rootRect.top
    );

    if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
      includeHugBounds(
        bounds,
        rect.left - rootRect.left,
        rect.top - rootRect.top,
        rect.left - rootRect.left + Math.max(candidate.scrollWidth, rect.width),
        rect.top - rootRect.top + Math.max(candidate.scrollHeight, rect.height)
      );
    }
  }

  if (!bounds.hasContent) return undefined;
  return {
    left: bounds.left,
    right: bounds.right,
    top: bounds.top,
    bottom: bounds.bottom,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top
  };
};

const hugInsetsOrFallback = (
  box: VisualEditBox,
  bounds: VisualHugContentBounds,
  currentWidth: number,
  currentHeight: number
): VisualHugInsets => {
  const hug = box.hug || {};
  return {
    left: finiteOrFallback(hug.left, Math.max(0, bounds.left)),
    right: finiteOrFallback(hug.right, Math.max(0, currentWidth - bounds.right)),
    top: finiteOrFallback(hug.top, Math.max(0, bounds.top)),
    bottom: finiteOrFallback(hug.bottom, Math.max(0, currentHeight - bounds.bottom))
  };
};

const markBoxAxisAsFixed = (box: VisualEditBox, handle: VisualResizeHandle) => {
  box.sizing = {
    ...(box.sizing || {}),
    ...(handle.includes("left") || handle.includes("right") ? { width: "fixed" as const } : {}),
    ...(handle.includes("top") || handle.includes("bottom") ? { height: "fixed" as const } : {})
  };
};

const applyHugSizing = (element: HTMLElement, box: VisualEditBox) => {
  if (box.sizing?.width !== "hug" && box.sizing?.height !== "hug") return;
  const bounds = measureHugContentBounds(element);
  if (!bounds) return;
  const rect = element.getBoundingClientRect();
  const insets = hugInsetsOrFallback(box, bounds, finiteOrFallback(box.width, rect.width), finiteOrFallback(box.height, rect.height));

  if (box.sizing?.width === "hug") {
    const width = Math.max(
      8,
      Math.ceil(bounds.width + insets.left + insets.right),
      Math.ceil(bounds.right + insets.right)
    );
    element.style.width = `${width}px`;
  }

  if (box.sizing?.height === "hug") {
    const height = Math.max(
      8,
      Math.ceil(bounds.height + insets.top + insets.bottom),
      Math.ceil(bounds.bottom + insets.bottom)
    );
    element.style.height = `${height}px`;
  }

  for (const textElement of textScaleTargets(element)) {
    fitTextToParent(textElement, textElement === element ? element : undefined);
  }
};

const textMoveBoundsForElement = (element: Element) => {
  if (!isTextMoveElement(element)) return undefined;
  const parent = element.parentElement;
  if (!parent || parent === document.body || parent === document.documentElement || !isConjureOwnedElement(parent)) {
    return undefined;
  }
  const parentRect = parent.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const minDeltaX = Math.ceil(parentRect.left - rect.left);
  const maxDeltaX = Math.floor(parentRect.right - rect.right);
  const minDeltaY = Math.ceil(parentRect.top - rect.top);
  const maxDeltaY = Math.floor(parentRect.bottom - rect.bottom);
  return {
    minDeltaX: minDeltaX <= maxDeltaX ? minDeltaX : 0,
    maxDeltaX: minDeltaX <= maxDeltaX ? maxDeltaX : 0,
    minDeltaY: minDeltaY <= maxDeltaY ? minDeltaY : 0,
    maxDeltaY: minDeltaY <= maxDeltaY ? maxDeltaY : 0
  };
};

const elementMatchesSelector = (element: Element, selector: string) => {
  try {
    return document.querySelector(selector) === element;
  } catch {
    return false;
  }
};

const isUniqueSelector = (selector: string, element: Element) => {
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
};

const attributeSelector = (name: string, value: string) =>
  `[${cssEscape(name)}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

const stableSelectorCandidates = (element: Element) => {
  const candidates: string[] = [];
  for (const name of stableAttributePriority) {
    const value = element.getAttribute(name);
    if (value?.trim()) {
      candidates.push(attributeSelector(name, value.trim()));
    }
  }

  for (const attribute of Array.from(element.attributes)) {
    if (!attribute.name.startsWith("data-") || stableAttributePriority.includes(attribute.name)) {
      continue;
    }
    const value = attribute.value.trim();
    if (value) {
      candidates.push(attributeSelector(attribute.name, value));
    }
  }

  if (element.id.trim()) {
    candidates.push(`#${cssEscape(element.id.trim())}`);
  }

  const stableClasses = Array.from(element.classList)
    .filter((name) => name && !/^conjure-visual-edit/.test(name))
    .slice(0, 3);
  if (stableClasses.length > 0) {
    candidates.push(
      `${element.tagName.toLowerCase()}${stableClasses.map((name) => `.${cssEscape(name)}`).join("")}`
    );
  }

  return candidates;
};

const nthOfType = (element: Element) => {
  let index = 1;
  let previous = element.previousElementSibling;
  while (previous) {
    if (previous.tagName === element.tagName) index += 1;
    previous = previous.previousElementSibling;
  }
  return index;
};

const selectorSegment = (element: Element) => {
  const stable = stableSelectorCandidates(element)[0];
  if (stable) return stable;
  return `${element.tagName.toLowerCase()}:nth-of-type(${nthOfType(element)})`;
};

const selectorForElement = (element: Element) => {
  for (const candidate of stableSelectorCandidates(element)) {
    if (isUniqueSelector(candidate, element)) return candidate;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    parts.unshift(selectorSegment(current));
    const selector = parts.join(" > ");
    if (elementMatchesSelector(element, selector)) return selector;
    current = current.parentElement;
  }

  parts.unshift("html");
  return parts.join(" > ");
};

const readableAttributes = (element: Element) => {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    if (
      attribute.name === "id" ||
      attribute.name === "class" ||
      attribute.name === "role" ||
      attribute.name === "title" ||
      attribute.name === "type" ||
      attribute.name === "href" ||
      attribute.name === "src" ||
      attribute.name === "aria-label" ||
      attribute.name.startsWith("data-")
    ) {
      attributes[attribute.name] = attribute.value.slice(0, 500);
    }
  }
  return attributes;
};

const rectForElement = (element: Element): VisualEditRect => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
};

const parseTranslate = (element: Element) => {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };

  const matrix3d = transform.match(/^matrix3d\((.+)\)$/);
  if (matrix3d) {
    const values = matrix3d[1].split(",").map((value) => Number.parseFloat(value.trim()));
    return {
      x: Number.isFinite(values[12]) ? values[12] : 0,
      y: Number.isFinite(values[13]) ? values[13] : 0
    };
  }

  const matrix = transform.match(/^matrix\((.+)\)$/);
  if (matrix) {
    const values = matrix[1].split(",").map((value) => Number.parseFloat(value.trim()));
    return {
      x: Number.isFinite(values[4]) ? values[4] : 0,
      y: Number.isFinite(values[5]) ? values[5] : 0
    };
  }

  const translate = transform.match(/translate(?:3d)?\(([^,)]+),\s*([^,)]+)/);
  if (translate) {
    const x = Number.parseFloat(translate[1]);
    const y = Number.parseFloat(translate[2]);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0
    };
  }

  return { x: 0, y: 0 };
};

const setVisualCursor = (cursor: string) => {
  if (!document.body) return;
  if (!previousVisualCursor) {
    previousVisualCursor = document.body.style.cursor;
  }
  document.body.style.cursor = cursor;
};

const restoreVisualCursor = () => {
  if (!document.body) return;
  document.body.style.cursor = previousVisualCursor;
  previousVisualCursor = "";
};

const computedStyleForElement = (element: Element): VisualEditComputedStyle => {
  const style = getComputedStyle(element);
  return stylePropertyNames.reduce((accumulator, name) => {
    accumulator[name] = style[name];
    return accumulator;
  }, {} as VisualEditComputedStyle);
};

const ownershipForElement = (element: Element): VisualEditSelection["ownership"] => {
  const hints: string[] = [];
  let modId: string | undefined;
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    const owned = current.getAttribute("data-conjure-owned");
    const currentModId = current.getAttribute("data-conjure-mod-id");
    const elementId = current.getAttribute("data-conjure-element-id");
    if (owned === "true") {
      hints.push("data-conjure-owned=true");
    }
    if (currentModId?.trim()) {
      const value = currentModId.trim();
      hints.push(`data-conjure-mod-id=${value.slice(0, 80)}`);
      modId = modId || value;
    }
    if (elementId?.trim()) {
      hints.push(`data-conjure-element-id=${elementId.trim().slice(0, 80)}`);
    }
    current = current.parentElement;
  }

  return {
    conjureOwned: isConjureOwnedElement(element),
    modId,
    hints: Array.from(new Set(hints)).slice(0, 8)
  };
};

const selectionForElement = (element: Element): VisualEditSelection => {
  const editable = isEditableElement(element);
  return {
    selector: selectorForElement(element),
    text: ((element as HTMLElement).innerText || element.textContent || "").slice(0, visualEditTextLimit),
    tag: element.tagName.toLowerCase(),
    attributes: readableAttributes(element),
    computedStyle: computedStyleForElement(element),
    rect: rectForElement(element),
    url: location.href,
    editable: editable.editable,
    notEditableReason: editable.reason,
    ownership: ownershipForElement(element)
  };
};

const sendVisualEditSelection = (selection: VisualEditSelection) => {
  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.VISUAL_EDIT_SELECTION,
      payload: selection
    } satisfies VisualEditSelectionMessage)
    .catch(() => undefined);
};

const sendVisualEditPreview = (payload: VisualEditPreviewMessage["payload"]) => {
  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.VISUAL_EDIT_PREVIEW,
      payload
    } satisfies VisualEditPreviewMessage)
    .catch(() => undefined);
};

const outlineBaseStyle = (element: HTMLDivElement, color: string) => {
  element.setAttribute(VISUAL_EDIT_OVERLAY_ATTR, "true");
  element.style.position = "fixed";
  element.style.pointerEvents = "none";
  element.style.zIndex = VISUAL_EDIT_Z_INDEX;
  element.style.border = `2px solid ${color}`;
  element.style.borderRadius = "4px";
  element.style.boxSizing = "border-box";
  element.style.boxShadow = `0 0 0 1px rgba(255, 255, 255, 0.9), 0 0 0 4px ${color}22`;
  element.style.display = "none";
};

const addResizeHandle = (
  outline: HTMLDivElement,
  position: VisualResizeHandle,
  styles: Partial<CSSStyleDeclaration>
) => {
  const handle = document.createElement("div");
  handle.setAttribute(VISUAL_EDIT_OVERLAY_ATTR, "true");
  handle.style.position = "absolute";
  Object.assign(handle.style, styles);
  handle.style.border = "2px solid #fff";
  handle.style.borderRadius = "3px";
  handle.style.background = "#c05a18";
  handle.style.boxShadow = "0 1px 4px rgba(24, 32, 28, 0.25)";
  handle.style.pointerEvents = "none";
  handle.dataset.conjureResizeHandle = position;
  outline.appendChild(handle);
};

const ensureVisualEditOverlay = () => {
  if (!hoverOutline) {
    hoverOutline = document.createElement("div");
    outlineBaseStyle(hoverOutline, "#2c7c67");
    (document.documentElement || document.body).appendChild(hoverOutline);
  }
  if (!selectionOutline) {
    selectionOutline = document.createElement("div");
    outlineBaseStyle(selectionOutline, "#c05a18");
    addResizeHandle(selectionOutline, "top", {
      top: "-6px",
      left: "50%",
      width: "20px",
      height: "6px",
      transform: "translateX(-50%)"
    });
    addResizeHandle(selectionOutline, "right", {
      right: "-6px",
      top: "50%",
      width: "6px",
      height: "20px",
      transform: "translateY(-50%)"
    });
    addResizeHandle(selectionOutline, "bottom", {
      bottom: "-6px",
      left: "50%",
      width: "20px",
      height: "6px",
      transform: "translateX(-50%)"
    });
    addResizeHandle(selectionOutline, "left", {
      left: "-6px",
      top: "50%",
      width: "6px",
      height: "20px",
      transform: "translateY(-50%)"
    });
    addResizeHandle(selectionOutline, "top-left", {
      top: "-6px",
      left: "-6px",
      width: "10px",
      height: "10px"
    });
    addResizeHandle(selectionOutline, "top-right", {
      top: "-6px",
      right: "-6px",
      width: "10px",
      height: "10px"
    });
    addResizeHandle(selectionOutline, "bottom-right", {
      right: "-6px",
      bottom: "-6px",
      width: "10px",
      height: "10px"
    });
    addResizeHandle(selectionOutline, "bottom-left", {
      bottom: "-6px",
      left: "-6px",
      width: "10px",
      height: "10px"
    });
    (document.documentElement || document.body).appendChild(selectionOutline);
  }
};

const updateOutline = (outline: HTMLDivElement | null, element: Element | null) => {
  if (!outline) return;
  if (!element || !document.documentElement.contains(element) || !isConjureOwnedElement(element)) {
    outline.style.display = "none";
    return;
  }
  const rect = element.getBoundingClientRect();
  outline.style.display = "block";
  outline.style.left = `${rect.left}px`;
  outline.style.top = `${rect.top}px`;
  outline.style.width = `${rect.width}px`;
  outline.style.height = `${rect.height}px`;
};

const hideOutline = (outline: HTMLDivElement | null) => {
  if (outline) outline.style.display = "none";
};

const removeVisualEditOverlay = () => {
  hoverOutline?.remove();
  selectionOutline?.remove();
  hoverOutline = null;
  selectionOutline = null;
};

const syncSelectionOutline = () => {
  if (!visualEditActive) {
    selectionOutlineFrame = undefined;
    return;
  }
  updateOutline(selectionOutline, selectedElement);
  selectionOutlineFrame = window.requestAnimationFrame(syncSelectionOutline);
};

const startSelectionOutlineSync = () => {
  if (selectionOutlineFrame !== undefined) return;
  selectionOutlineFrame = window.requestAnimationFrame(syncSelectionOutline);
};

const stopSelectionOutlineSync = () => {
  if (selectionOutlineFrame === undefined) return;
  window.cancelAnimationFrame(selectionOutlineFrame);
  selectionOutlineFrame = undefined;
};

const targetFromPoint = (x: number, y: number) => {
  const target =
    document.elementsFromPoint(x, y).find((element) => isVisualEditHitCandidate(element)) || null;
  return isConjureOwnedElement(target) ? target : null;
};

const targetFromVisualEditEvent = (event: MouseEvent) => {
  const pointTarget = targetFromPoint(event.clientX, event.clientY);
  if (pointTarget) return pointTarget;
  const target = eventTargetElement(event.target);
  return isConjureOwnedElement(target) ? target : null;
};

const snapshotElement = (selector: string, element: Element) => {
  if (previewSnapshots.has(selector)) return;
  previewSnapshots.set(selector, {
    selector,
    element,
    styleAttribute: element.getAttribute("style"),
    textContent: element.textContent,
    inputValue:
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : undefined
  });
};

const restorePreviewSnapshots = () => {
  for (const snapshot of previewSnapshots.values()) {
    const element = document.querySelector(snapshot.selector) || snapshot.element;
    if (!element) continue;
    if (snapshot.styleAttribute === null) {
      element.removeAttribute("style");
    } else {
      element.setAttribute("style", snapshot.styleAttribute);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = snapshot.inputValue || "";
    } else {
      element.textContent = snapshot.textContent || "";
    }
  }
  previewSnapshots.clear();
};

const inlineTextValue = (element: HTMLElement) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent || "";
};

const previewInlineTextOperation = (element: HTMLElement, selector: string) => {
  const operation: Extract<VisualEditOperation, { type: "setText" }> = {
    id: `setText:${selector}`,
    type: "setText",
    selector,
    value: inlineTextValue(element),
    url: location.href
  };
  previewOperations = [
    ...previewOperations.filter((candidate) => candidate.id !== operation.id),
    operation
  ];
  refreshHugBoxesForElement(element);
  fitEditedTextElement(element);
  placeCaretAtEnd(element);
  updateOutline(selectionOutline, selectedElement);
  sendVisualEditSelection(selectionForElement(element));
  sendVisualEditPreview({ ok: true, operation, staleOperationIds: [] });
};

const handleInlineTextInput = (event: Event) => {
  const state = inlineTextEditState;
  if (!state || event.target !== state.element) return;
  event.stopPropagation();
  previewInlineTextOperation(state.element, state.selector);
};

const handleInlineTextKeyEvent = (event: KeyboardEvent) => {
  if (!inlineTextEditState || event.target !== inlineTextEditState.element) return;
  event.stopPropagation();
};

const keepTextInputCaretAtEnd = (element: HTMLInputElement | HTMLTextAreaElement) => {
  const position = element.value.length;
  try {
    element.setSelectionRange(position, position);
  } catch {
    // Some input types expose value but do not support text selection.
  }
  window.requestAnimationFrame(() => {
    element.scrollLeft = element.scrollWidth;
    if (element instanceof HTMLTextAreaElement) {
      element.scrollTop = element.scrollHeight;
    }
  });
};

const placeCaretAtEnd = (element: HTMLElement) => {
  element.focus({ preventScroll: true });
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    keepTextInputCaretAtEnd(element);
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
};

const disableInlineTextEdit = () => {
  const state = inlineTextEditState;
  if (!state) return;
  state.element.removeEventListener("input", handleInlineTextInput);
  state.element.removeEventListener("keydown", handleInlineTextKeyEvent);
  state.element.removeEventListener("keyup", handleInlineTextKeyEvent);
  if (state.dirAttribute === null) {
    state.element.removeAttribute("dir");
  } else {
    state.element.setAttribute("dir", state.dirAttribute);
  }
  state.element.style.direction = state.styleDirection;
  state.element.style.unicodeBidi = state.styleUnicodeBidi;
  if (!(state.element instanceof HTMLInputElement || state.element instanceof HTMLTextAreaElement)) {
    if (state.contentEditableAttribute === null) {
      state.element.removeAttribute("contenteditable");
    } else {
      state.element.setAttribute("contenteditable", state.contentEditableAttribute);
    }
    if (state.spellcheckAttribute === null) {
      state.element.removeAttribute("spellcheck");
    } else {
      state.element.setAttribute("spellcheck", state.spellcheckAttribute);
    }
  }
  inlineTextEditState = null;
};

const enableInlineTextEdit = (element: Element) => {
  if (!isInlineTextEditElement(element)) {
    disableInlineTextEdit();
    return;
  }
  const selector = selectorForElement(element);
  if (inlineTextEditState?.element === element) {
    placeCaretAtEnd(element);
    return;
  }

  disableInlineTextEdit();
  snapshotElement(selector, element);
  inlineTextEditState = {
    element,
    selector,
    contentEditableAttribute: element.getAttribute("contenteditable"),
    spellcheckAttribute: element.getAttribute("spellcheck"),
    dirAttribute: element.getAttribute("dir"),
    styleDirection: element.style.direction,
    styleUnicodeBidi: element.style.unicodeBidi
  };

  element.setAttribute("dir", "ltr");
  element.style.direction = "ltr";
  element.style.unicodeBidi = "plaintext";
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    element.setAttribute("contenteditable", "true");
    element.setAttribute("spellcheck", "false");
  }
  element.addEventListener("input", handleInlineTextInput);
  element.addEventListener("keydown", handleInlineTextKeyEvent);
  element.addEventListener("keyup", handleInlineTextKeyEvent);
  placeCaretAtEnd(element);
};

const findOperationElement = (operation: VisualEditOperation) => {
  try {
    return document.querySelector(operation.selector);
  } catch {
    return null;
  }
};

const applySetBoxToElement = (element: HTMLElement, box: VisualEditBox) => {
  const currentTranslate = parseTranslate(element);
  const x = finiteOrFallback(box.x, currentTranslate.x);
  const y = finiteOrFallback(box.y, currentTranslate.y);
  element.style.transform = `translate(${x}px, ${y}px)`;
  const width = px(box.width);
  const height = px(box.height);
  if (width) element.style.width = width;
  if (height) element.style.height = height;
  element.style.boxSizing = "border-box";
  element.style.overflow = "hidden";
  scaleTextForBox(element, box.fontScale);
  applyHugSizing(element, box);
};

const refreshHugBoxesForElement = (element: Element) => {
  for (const operation of previewOperations) {
    if (operation.type !== "setBox") continue;
    if (operation.box.sizing?.width !== "hug" && operation.box.sizing?.height !== "hug") continue;
    const boxElement = findOperationElement(operation);
    if (!(boxElement instanceof HTMLElement) || !boxElement.contains(element)) continue;
    applySetBoxToElement(boxElement, operation.box);
  }
};

const applyVisualEditOperation = (operation: VisualEditOperation, rememberSnapshot: boolean) => {
  const element = findOperationElement(operation);
  if (!element) return false;
  if (rememberSnapshot) {
    snapshotElement(operation.selector, element);
    if (
      operation.type === "setBox" &&
      (typeof operation.box.fontScale === "number" ||
        operation.box.sizing?.width === "hug" ||
        operation.box.sizing?.height === "hug")
    ) {
      for (const textElement of textScaleTargets(element)) {
        snapshotElement(selectorForElement(textElement), textElement);
      }
    }
  }

  const htmlElement = element as HTMLElement;
  if (operation.type === "setText") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = operation.value;
    } else {
      htmlElement.textContent = operation.value;
    }
    if (element instanceof HTMLElement) {
      refreshHugBoxesForElement(element);
      fitEditedTextElement(element);
    }
    return true;
  }

  if (operation.type === "setStyle") {
    for (const [property, value] of Object.entries(operation.styles)) {
      if (typeof value === "string") {
        htmlElement.style.setProperty(toKebabCase(property), value);
      }
    }
    if (typeof operation.styles.fontSize === "string" && element instanceof HTMLElement) {
      refreshHugBoxesForElement(element);
      fitEditedTextElement(element);
    }
    return true;
  }

  if (operation.type === "hide") {
    htmlElement.style.display = operation.hidden ? "none" : "";
    return true;
  }

  applySetBoxToElement(htmlElement, operation.box);
  return true;
};

const previewVisualEditOperation = (operation: VisualEditOperation) => {
  previewOperations = [
    ...previewOperations.filter((candidate) => candidate.id !== operation.id),
    operation
  ];
  const staleOperationIds = applyVisualEditOperations([operation], true);
  updateOutline(selectionOutline, selectedElement);
  sendVisualEditPreview({ ok: true, operation, staleOperationIds });
};

const applyVisualEditOperations = (operations: VisualEditOperation[], rememberSnapshots: boolean) => {
  const staleOperationIds: string[] = [];
  for (const operation of operations) {
    if (!applyVisualEditOperation(operation, rememberSnapshots)) {
      staleOperationIds.push(operation.id);
    }
  }
  return staleOperationIds;
};

const scheduleVisualEditRetry = () => {
  if (!visualEditActive || previewOperations.length === 0) return;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    const staleOperationIds = applyVisualEditOperations(previewOperations, true);
    if (staleOperationIds.length > 0) {
      sendVisualEditPreview({ ok: true, staleOperationIds });
    }
    updateOutline(selectionOutline, selectedElement);
  }, 80);
};

const installVisualEditRetryObserver = () => {
  retryObserver?.disconnect();
  retryObserver = new MutationObserver(scheduleVisualEditRetry);
  retryObserver.observe(document.documentElement, { childList: true, subtree: true });
};

const removeVisualEditRetryObserver = () => {
  retryObserver?.disconnect();
  retryObserver = null;
  window.clearTimeout(retryTimer);
};

const rectSnapshot = (rect: DOMRect) => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height
});

const defaultResizeLayoutShift: VisualResizeLayoutShift = {
  leftPerWidth: 0,
  rightPerWidth: 1,
  topPerHeight: 0,
  bottomPerHeight: 1
};

const restoreStyleAttribute = (element: HTMLElement, styleAttribute: string | null) => {
  if (styleAttribute === null) {
    element.removeAttribute("style");
  } else {
    element.setAttribute("style", styleAttribute);
  }
};

const measureResizeLayoutShift = (element: HTMLElement, startRect: VisualBoxDragState["startRect"]) => {
  const styleAttribute = element.getAttribute("style");
  const probe = 16;
  const shifts = { ...defaultResizeLayoutShift };

  try {
    element.style.transition = "none";
    element.style.boxSizing = "border-box";
    element.style.overflow = "hidden";
    element.style.width = `${Math.max(8, startRect.width + probe)}px`;
    const widthRect = element.getBoundingClientRect();
    const widthDelta = widthRect.width - startRect.width;
    if (Math.abs(widthDelta) > 0.5) {
      shifts.leftPerWidth = (widthRect.left - startRect.left) / widthDelta;
      shifts.rightPerWidth = (widthRect.right - startRect.right) / widthDelta;
    }
  } finally {
    restoreStyleAttribute(element, styleAttribute);
  }

  try {
    element.style.transition = "none";
    element.style.boxSizing = "border-box";
    element.style.overflow = "hidden";
    element.style.height = `${Math.max(8, startRect.height + probe)}px`;
    const heightRect = element.getBoundingClientRect();
    const heightDelta = heightRect.height - startRect.height;
    if (Math.abs(heightDelta) > 0.5) {
      shifts.topPerHeight = (heightRect.top - startRect.top) / heightDelta;
      shifts.bottomPerHeight = (heightRect.bottom - startRect.bottom) / heightDelta;
    }
  } finally {
    restoreStyleAttribute(element, styleAttribute);
  }

  return shifts;
};

const resizeRectForDrag = (
  drag: VisualBoxDragState,
  deltaX: number,
  deltaY: number
): VisualBoxDragState["startRect"] => {
  const minSize = 8;
  const rect = { ...drag.startRect };
  const aspectRatio = drag.startRect.width > 0 && drag.startRect.height > 0
    ? drag.startRect.width / drag.startRect.height
    : 1;
  if (drag.handle === "top-left" || drag.handle === "top-right" || drag.handle === "bottom-left" || drag.handle === "bottom-right") {
    const horizontalSign = drag.handle.includes("right") ? 1 : -1;
    const verticalSign = drag.handle.includes("bottom") ? 1 : -1;
    const widthFromPointer = drag.startRect.width + horizontalSign * deltaX;
    const heightFromPointer = drag.startRect.height + verticalSign * deltaY;
    const pointerScale = Math.max(widthFromPointer / drag.startRect.width, heightFromPointer / drag.startRect.height);
    const nextWidth = Math.max(minSize, Math.round(drag.startRect.width * pointerScale));
    const nextHeight = Math.max(minSize, Math.round(nextWidth / aspectRatio));
    if (drag.handle.includes("right")) {
      rect.right = drag.startRect.left + nextWidth;
    } else {
      rect.left = drag.startRect.right - nextWidth;
    }
    if (drag.handle.includes("bottom")) {
      rect.bottom = drag.startRect.top + nextHeight;
    } else {
      rect.top = drag.startRect.bottom - nextHeight;
    }
  } else if (drag.handle === "right") {
    rect.right = Math.max(drag.startRect.left + minSize, drag.startRect.right + deltaX);
  } else if (drag.handle === "left") {
    rect.left = Math.min(drag.startRect.right - minSize, drag.startRect.left + deltaX);
  } else if (drag.handle === "bottom") {
    rect.bottom = Math.max(drag.startRect.top + minSize, drag.startRect.bottom + deltaY);
  } else {
    rect.top = Math.min(drag.startRect.bottom - minSize, drag.startRect.top + deltaY);
  }
  rect.width = rect.right - rect.left;
  rect.height = rect.bottom - rect.top;
  return rect;
};

const resizeStickyPreCorrection = (drag: VisualBoxDragState, rect: VisualBoxDragState["startRect"]) => {
  const widthDelta = rect.width - drag.startRect.width;
  const heightDelta = rect.height - drag.startRect.height;
  const x = drag.handle.includes("right")
    ? -drag.resizeLayoutShift.leftPerWidth * widthDelta
    : drag.handle.includes("left")
      ? (1 - drag.resizeLayoutShift.rightPerWidth) * widthDelta
      : 0;
  const y = drag.handle.includes("bottom")
    ? -drag.resizeLayoutShift.topPerHeight * heightDelta
    : drag.handle.includes("top")
      ? (1 - drag.resizeLayoutShift.bottomPerHeight) * heightDelta
      : 0;
  return { x, y };
};

const boxForResizeRect = (drag: VisualBoxDragState, rect: VisualBoxDragState["startRect"]): VisualEditBox => {
  const correction = resizeStickyPreCorrection(drag, rect);
  return {
    ...drag.baseBox,
    x: Math.round(drag.startBox.x + rect.left - drag.startRect.left + correction.x),
    y: Math.round(drag.startBox.y + rect.top - drag.startRect.top + correction.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
};

const handleVisualEditMove = (event: MouseEvent) => {
  if (!visualEditActive) return;
  if (dragState) {
    consumeVisualEditEvent(event);
    const deltaX = event.clientX - dragState.startClientX;
    const deltaY = event.clientY - dragState.startClientY;
    dragState.moved = dragState.moved || Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2;

    if (dragState.mode === "text-resize") {
      const fontDelta =
        dragState.handle === "left"
          ? -deltaX
          : dragState.handle === "right"
            ? deltaX
            : dragState.handle === "top"
              ? -deltaY
              : deltaY;
      const fontSize = clampNumber(
        Math.round(dragState.startFontSize + fontDelta * 0.35),
        TEXT_FONT_MIN,
        256
      );
      previewVisualEditOperation({
        id: dragState.operationId,
        type: "setStyle",
        selector: dragState.selector,
        styles: {
          ...dragState.baseStyles,
          fontSize: `${fontSize}px`
        },
        url: location.href
      });
      return;
    }

    if (dragState.mode === "move") {
      const box: VisualEditBox = {
        ...dragState.baseBox
      };
      const moveDeltaX = dragState.moveBounds
        ? clampNumber(deltaX, dragState.moveBounds.minDeltaX, dragState.moveBounds.maxDeltaX)
        : deltaX;
      const moveDeltaY = dragState.moveBounds
        ? clampNumber(deltaY, dragState.moveBounds.minDeltaY, dragState.moveBounds.maxDeltaY)
        : deltaY;
      box.x = Math.round(dragState.startBox.x + moveDeltaX);
      box.y = Math.round(dragState.startBox.y + moveDeltaY);
      previewVisualEditOperation({
        id: dragState.operationId,
        type: "setBox",
        selector: dragState.selector,
        box,
        url: location.href
      });
    } else {
      const desiredRect = resizeRectForDrag(dragState, deltaX, deltaY);
      const box = boxForResizeRect(dragState, desiredRect);
      box.fontScale = fontScaleForResize(
        dragState.handle,
        dragState.startBox,
        box,
        dragState.baseBox.fontScale
      );
      markBoxAxisAsFixed(box, dragState.handle);

      previewVisualEditOperation({
        id: dragState.operationId,
        type: "setBox",
        selector: dragState.selector,
        box,
        url: location.href
      });
    }
    return;
  }

  const target = targetFromPoint(event.clientX, event.clientY);
  if (selectedElement && target && (target === selectedElement || selectedElement.contains(target))) {
    hideOutline(hoverOutline);
  } else {
    updateOutline(hoverOutline, target);
  }
  setVisualCursor(cursorForVisualPoint(event.clientX, event.clientY, target));
};

const handleVisualEditScroll = () => {
  updateOutline(selectionOutline, selectedElement);
};

const handleVisualEditClick = (event: MouseEvent) => {
  if (!visualEditActive) return;
  if (blockNonConjureVisualEditEvent(event)) return;
  if (suppressNextVisualClick) {
    consumeVisualEditEvent(event);
    suppressNextVisualClick = false;
    return;
  }
  const target = targetFromVisualEditEvent(event);
  if (!target) {
    consumeVisualEditEvent(event);
    return;
  }

  consumeVisualEditEvent(event);
  if (selectedElement && selectedElement !== target) {
    disableInlineTextEdit();
  }
  selectedElement = target;
  hideOutline(hoverOutline);
  updateOutline(selectionOutline, selectedElement);
  sendVisualEditSelection(selectionForElement(target));
  enableInlineTextEdit(target);
};

const currentSetBoxOperation = (selector: string) =>
  previewOperations.find(
    (operation): operation is Extract<VisualEditOperation, { type: "setBox" }> =>
      operation.type === "setBox" && operation.selector === selector
  );

const currentSetStyleOperation = (selector: string) =>
  previewOperations.find(
    (operation): operation is Extract<VisualEditOperation, { type: "setStyle" }> =>
      operation.type === "setStyle" && operation.selector === selector
  );

const fontScaleForResize = (
  handle: VisualResizeHandle,
  startBox: VisualBoxDragState["startBox"],
  box: Extract<VisualEditOperation, { type: "setBox" }>["box"],
  baseScale: number | undefined
) => {
  const ratios: number[] = [];
  if (
    (handle.includes("left") || handle.includes("right")) &&
    typeof box.width === "number" &&
    startBox.width > 0
  ) {
    ratios.push(box.width / startBox.width);
  }
  if (
    (handle.includes("top") || handle.includes("bottom")) &&
    typeof box.height === "number" &&
    startBox.height > 0
  ) {
    ratios.push(box.height / startBox.height);
  }
  if (ratios.length === 0) return baseScale;
  const resizeRatio = Math.min(...ratios.filter((ratio) => Number.isFinite(ratio)));
  if (!Number.isFinite(resizeRatio)) return baseScale;
  return clampNumber(finiteOrFallback(baseScale, 1) * resizeRatio, TEXT_SCALE_MIN, TEXT_SCALE_MAX);
};

const resizeHandleForPoint = (x: number, y: number, element: Element): VisualResizeHandle | null => {
  const rect = element.getBoundingClientRect();
  const edgeSize = Math.max(8, Math.min(16, Math.min(rect.width, rect.height) / 4));
  const cornerSize = Math.max(10, edgeSize);
  const onLeft = x >= rect.left - edgeSize && x <= rect.left + edgeSize;
  const onRight = x >= rect.right - edgeSize && x <= rect.right + edgeSize;
  const onTop = y >= rect.top - edgeSize && y <= rect.top + edgeSize;
  const onBottom = y >= rect.bottom - edgeSize && y <= rect.bottom + edgeSize;
  const nearLeftCorner = x >= rect.left - cornerSize && x <= rect.left + cornerSize;
  const nearRightCorner = x >= rect.right - cornerSize && x <= rect.right + cornerSize;
  const nearTopCorner = y >= rect.top - cornerSize && y <= rect.top + cornerSize;
  const nearBottomCorner = y >= rect.bottom - cornerSize && y <= rect.bottom + cornerSize;

  if (nearLeftCorner && nearTopCorner) return "top-left";
  if (nearRightCorner && nearTopCorner) return "top-right";
  if (nearRightCorner && nearBottomCorner) return "bottom-right";
  if (nearLeftCorner && nearBottomCorner) return "bottom-left";

  const handles: Array<{ handle: VisualResizeHandle; distance: number }> = [];
  if (onLeft) handles.push({ handle: "left", distance: Math.abs(x - rect.left) });
  if (onRight) handles.push({ handle: "right", distance: Math.abs(x - rect.right) });
  if (onTop) handles.push({ handle: "top", distance: Math.abs(y - rect.top) });
  if (onBottom) handles.push({ handle: "bottom", distance: Math.abs(y - rect.bottom) });
  handles.sort((a, b) => a.distance - b.distance);
  return handles[0]?.handle || null;
};

const cursorForResizeHandle = (handle: VisualResizeHandle | null) => {
  if (handle === "top-left" || handle === "bottom-right") return "nwse-resize";
  if (handle === "top-right" || handle === "bottom-left") return "nesw-resize";
  if (handle === "left" || handle === "right") return "ew-resize";
  if (handle === "top" || handle === "bottom") return "ns-resize";
  return null;
};

const cursorForVisualPoint = (x: number, y: number, target: Element | null) => {
  if (!selectedElement || !isConjureOwnedElement(selectedElement)) {
    return "";
  }
  const resizeCursor = cursorForResizeHandle(resizeHandleForPoint(x, y, selectedElement));
  if (resizeCursor) return resizeCursor;
  if (!target || !(target === selectedElement || selectedElement.contains(target))) {
    return "";
  }
  return "move";
};

const handleVisualEditMouseDown = (event: MouseEvent) => {
  if (!visualEditActive) return;
  const selectedResizeHandle =
    selectedElement && isConjureOwnedElement(selectedElement)
      ? resizeHandleForPoint(event.clientX, event.clientY, selectedElement)
      : null;
  if (!selectedResizeHandle && blockNonConjureVisualEditEvent(event)) return;
  const target = selectedResizeHandle ? selectedElement : targetFromVisualEditEvent(event);
  if (
    !target ||
    !selectedElement ||
    !isConjureOwnedElement(selectedElement) ||
    !(target === selectedElement || selectedElement.contains(target))
  ) {
    consumeVisualEditEvent(event);
    return;
  }

  const editable = isEditableElement(selectedElement);
  if (!editable.editable) {
    consumeVisualEditEvent(event);
    return;
  }

  const selector = selectorForElement(selectedElement);
  const rect = selectedElement.getBoundingClientRect();
  const startRect = rectSnapshot(rect);
  const handle = selectedResizeHandle || resizeHandleForPoint(event.clientX, event.clientY, selectedElement);
  const mode: Exclude<VisualDragMode, "text-resize"> = handle ? "resize" : "move";

  if (handle && isTextResizeElement(selectedElement)) {
    const existingStyle = currentSetStyleOperation(selector)?.styles || {};
    const computedFontSize = parseCssPixel(getComputedStyle(selectedElement).fontSize, 16);
    dragState = {
      mode: "text-resize",
      handle,
      selector,
      operationId: `setStyle:${selector}`,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startFontSize: parseCssPixel(existingStyle.fontSize, computedFontSize),
      baseStyles: { ...existingStyle },
      moved: false
    };

    setVisualCursor(cursorForVisualPoint(event.clientX, event.clientY, target));
    consumeVisualEditEvent(event);
    return;
  }

  const existingBox = currentSetBoxOperation(selector)?.box || {};
  const translate = parseTranslate(selectedElement);
  dragState = {
    mode,
    handle: handle || "bottom",
    selector,
    operationId: `setBox:${selector}`,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startBox: {
      x: finiteOrFallback(existingBox.x, Math.round(translate.x)),
      y: finiteOrFallback(existingBox.y, Math.round(translate.y)),
      width: finiteOrFallback(existingBox.width, Math.round(rect.width)),
      height: finiteOrFallback(existingBox.height, Math.round(rect.height))
    },
    startRect,
    baseBox: { ...existingBox },
    resizeLayoutShift:
      mode === "resize" && selectedElement instanceof HTMLElement
        ? measureResizeLayoutShift(selectedElement, startRect)
        : defaultResizeLayoutShift,
    moveBounds: mode === "move" ? textMoveBoundsForElement(selectedElement) : undefined,
    moved: false
  };

  setVisualCursor(mode === "move" ? "move" : cursorForVisualPoint(event.clientX, event.clientY, target));
  consumeVisualEditEvent(event);
};

const handleVisualEditMouseUp = (event: MouseEvent) => {
  if (!visualEditActive) return;
  if (dragState) {
    suppressNextVisualClick = dragState.moved;
    dragState = null;
    restoreVisualCursor();
    updateOutline(selectionOutline, selectedElement);
    consumeVisualEditEvent(event);
    return;
  }
  if (blockNonConjureVisualEditEvent(event)) return;
  consumeVisualEditEvent(event);
};

const handleVisualEditBlockedEvent = (event: MouseEvent) => {
  if (!visualEditActive) return;
  consumeVisualEditEvent(event);
};

const installVisualEditListeners = () => {
  window.addEventListener("mousedown", handleVisualEditMouseDown, true);
  window.addEventListener("mousemove", handleVisualEditMove, true);
  window.addEventListener("mouseup", handleVisualEditMouseUp, true);
  window.addEventListener("click", handleVisualEditClick, true);
  window.addEventListener("dblclick", handleVisualEditBlockedEvent, true);
  window.addEventListener("contextmenu", handleVisualEditBlockedEvent, true);
  window.addEventListener("scroll", handleVisualEditScroll, true);
  window.addEventListener("resize", handleVisualEditScroll, true);
};

const removeVisualEditListeners = () => {
  window.removeEventListener("mousedown", handleVisualEditMouseDown, true);
  window.removeEventListener("mousemove", handleVisualEditMove, true);
  window.removeEventListener("mouseup", handleVisualEditMouseUp, true);
  window.removeEventListener("click", handleVisualEditClick, true);
  window.removeEventListener("dblclick", handleVisualEditBlockedEvent, true);
  window.removeEventListener("contextmenu", handleVisualEditBlockedEvent, true);
  window.removeEventListener("scroll", handleVisualEditScroll, true);
  window.removeEventListener("resize", handleVisualEditScroll, true);
  restoreVisualCursor();
};

const startVisualEdit = (message: StartVisualEditMessage): RuntimeResult<{ active: boolean; staleOperationIds: string[] }> => {
  visualEditActive = true;
  disableInlineTextEdit();
  previewOperations = [...(message.visualEdits || [])];
  previewSnapshots = new Map();
  ensureVisualEditOverlay();
  removeVisualEditListeners();
  installVisualEditListeners();
  installVisualEditRetryObserver();
  startSelectionOutlineSync();

  const staleOperationIds = applyVisualEditOperations(message.visualEdits || [], false);
  if (staleOperationIds.length > 0) {
    sendVisualEditPreview({ ok: true, staleOperationIds });
  }
  return { ok: true, data: { active: true, staleOperationIds } };
};

const stopVisualEdit = (_message: StopVisualEditMessage): RuntimeResult<{ active: boolean }> => {
  visualEditActive = false;
  disableInlineTextEdit();
  selectedElement = null;
  dragState = null;
  suppressNextVisualClick = false;
  removeVisualEditListeners();
  removeVisualEditOverlay();
  removeVisualEditRetryObserver();
  stopSelectionOutlineSync();
  return { ok: true, data: { active: false } };
};

const previewVisualEdit = (
  message: ApplyVisualEditMessage
): RuntimeResult<{ operation: VisualEditOperation; staleOperationIds: string[] }> => {
  previewOperations = [
    ...previewOperations.filter((operation) => operation.id !== message.operation.id),
    message.operation
  ];
  const staleOperationIds = applyVisualEditOperations([message.operation], true);
  updateOutline(selectionOutline, selectedElement);
  sendVisualEditPreview({ ok: true, operation: message.operation, staleOperationIds });
  return { ok: true, data: { operation: message.operation, staleOperationIds } };
};

const commitVisualEdits = (
  message: CommitVisualEditsMessage
): RuntimeResult<{ operations: VisualEditOperation[]; staleOperationIds: string[] }> => {
  const staleOperationIds = applyVisualEditOperations(message.operations, false);
  previewOperations = [];
  previewSnapshots.clear();
  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.VISUAL_EDIT_COMMIT,
      payload: { ok: true, operations: message.operations, staleOperationIds }
    })
    .catch(() => undefined);
  return { ok: true, data: { operations: message.operations, staleOperationIds } };
};

const discardVisualEdits = (_message: DiscardVisualEditsMessage): RuntimeResult<{ discarded: boolean }> => {
  disableInlineTextEdit();
  restorePreviewSnapshots();
  previewOperations = [];
  updateOutline(selectionOutline, selectedElement);
  sendVisualEditPreview({ ok: true, staleOperationIds: [] });
  return { ok: true, data: { discarded: true } };
};

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== PAGE_HOOK_SOURCE) return;
  if (event.data?.type === CONTENT_MESSAGE.GENERATED_MOD_ERROR) {
    chrome.runtime
      .sendMessage({
        type: CONTENT_MESSAGE.GENERATED_MOD_ERROR,
        payload: event.data.payload
      } satisfies GeneratedModErrorMessage)
      .catch(() => undefined);
    return;
  }

  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.CONSOLE_EVENT,
      payload: event.data.payload
    })
    .catch(() => undefined);
});

installIsolatedWorldHooks();
loadFallbackHotkey();
installFallbackHotkey();
installVoiceHotkeyRelay();

if (isRuntimeAvailable()) {
  chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
    try {
      if (message.type === CONTENT_MESSAGE.GET_PAGE_CONTENT) {
        sendResponse(getPageContent(message));
        return true;
      }

      if (message.type === CONTENT_MESSAGE.GET_ELEMENT_HTML) {
        sendResponse(getElementHtml(message));
        return true;
      }

      if (message.type === CONTENT_MESSAGE.TOGGLE_COMMAND_BAR) {
        openCommandBar();
        sendResponse({ ok: true, data: { open: commandOpen } });
        return true;
      }

      if (message.type === BACKGROUND_MESSAGE.START_VISUAL_EDIT) {
        sendResponse(startVisualEdit(message));
        return true;
      }

      if (message.type === BACKGROUND_MESSAGE.STOP_VISUAL_EDIT) {
        sendResponse(stopVisualEdit(message));
        return true;
      }

      if (message.type === BACKGROUND_MESSAGE.APPLY_VISUAL_EDIT) {
        sendResponse(previewVisualEdit(message));
        return true;
      }

      if (message.type === BACKGROUND_MESSAGE.COMMIT_VISUAL_EDITS) {
        sendResponse(commitVisualEdits(message));
        return true;
      }

      if (message.type === BACKGROUND_MESSAGE.DISCARD_VISUAL_EDITS) {
        sendResponse(discardVisualEdits(message));
        return true;
      }

      sendResponse({ ok: false, error: "Unsupported content message." });
    } catch (error) {
      captureException(error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }

    return true;
  });
}

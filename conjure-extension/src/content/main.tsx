import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "../shared/config";
import {
  BACKGROUND_MESSAGE,
  CONTENT_MESSAGE,
  type ConsoleLevel,
  type GetElementHtmlMessage,
  type GetPageContentMessage,
  type PageContentResult,
  type RuntimeRequest,
  type RuntimeResult
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
  }
  .palette {
    width: min(620px, calc(100vw - 32px));
    border: 1px solid var(--cj-overlay-loud);
    background: var(--cj-surface);
    color: var(--cj-text);
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
  input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--cj-text);
    font-size: 16px;
    caret-color: var(--cj-accent);
  }
  input::placeholder {
    color: var(--cj-faint);
  }
  .chip {
    border: 1px solid var(--cj-line);
    padding: 1px 5px;
    color: var(--cj-dim);
    font-size: 11px;
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
    font-size: 13px;
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
    font-size: 11px;
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
  @media (prefers-reduced-motion: reduce) {
    .cursor {
      opacity: 1;
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

installIsolatedWorldHooks();

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

      sendResponse({ ok: false, error: "Unsupported content message." });
    } catch (error) {
      captureException(error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }

    return true;
  });
}

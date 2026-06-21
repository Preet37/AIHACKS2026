import * as Sentry from "@sentry/browser";
import { CONJURE_CONFIG } from "../shared/config";
import {
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
    __CONJURE_PAGE_HOOKED__?: boolean;
  }
}

const PAGE_HOOK_SOURCE = "conjure-page-hook";
const AGENT_ACTION_ATTRIBUTE = "data-conjure-agent-action";
type AgentFeedbackState = "running" | "success" | "error";

interface AgentFeedback {
  host: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
}

const agentFeedbackByHost = new WeakMap<HTMLElement, AgentFeedback>();

const getAgentFeedback = (): AgentFeedback => {
  let host = document.querySelector<HTMLElement>("[data-conjure-runtime-agent-feedback]");
  const existing = host ? agentFeedbackByHost.get(host) : undefined;
  if (existing) return existing;

  host = document.createElement("conjure-agent-feedback");
  host.dataset.conjureRuntimeAgentFeedback = "true";
  const importantStyles: Record<string, string> = {
    position: "fixed",
    right: "16px",
    bottom: "76px",
    zIndex: "2147483647",
    width: "min(380px, calc(100vw - 32px))",
    maxWidth: "calc(100vw - 32px)",
    display: "block",
    pointerEvents: "none"
  };
  Object.entries(importantStyles).forEach(([property, value]) => {
    host!.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value, "important");
  });

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        box-sizing: border-box;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 12px;
        width: 100%;
        max-height: 52vh;
        overflow: auto;
        padding: 14px;
        border: 1px solid #d8e2dc;
        border-radius: 14px;
        color: #18201c;
        background: #fff;
        box-shadow: 0 14px 40px rgba(20,43,35,.22);
        font: 13px/1.5 system-ui, -apple-system, sans-serif;
        animation: feedback-in .18s ease-out both;
      }
      .icon {
        box-sizing: border-box;
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        font: 700 18px/1 system-ui, sans-serif;
      }
      .card[data-state="running"] .icon {
        border: 3px solid #d7e3ff;
        border-right-color: #2563eb;
        animation: spin .8s linear infinite;
      }
      .card[data-state="success"] { border-color: #9bd7ae; animation: feedback-done .36s ease-out both; }
      .card[data-state="success"] .icon { color: #fff; background: #168a45; }
      .card[data-state="error"] { border-color: #efaaa6; animation: feedback-error .28s ease-out both; }
      .card[data-state="error"] .icon { color: #fff; background: #c9362b; }
      .glyph { display: none; }
      .card[data-state="success"] .glyph,
      .card[data-state="error"] .glyph { display: block; }
      .title { margin: 0 0 3px; color: #111814; font-weight: 750; font-size: 14px; }
      .body { margin: 0; color: #435149; white-space: pre-wrap; overflow-wrap: anywhere; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes feedback-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
      @keyframes feedback-done { 0% { transform: scale(.98); } 55% { transform: scale(1.025); } 100% { transform: scale(1); } }
      @keyframes feedback-error { 0%,100% { transform: translateX(0); } 35% { transform: translateX(-4px); } 70% { transform: translateX(4px); } }
      @media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; } }
    </style>
    <section class="card" data-state="running" role="status" aria-live="polite" aria-atomic="true">
      <div class="icon" aria-hidden="true"><span class="glyph"></span></div>
      <div><p class="title"></p><p class="body"></p></div>
    </section>
  `;
  const card = shadow.querySelector<HTMLElement>(".card")!;
  const title = shadow.querySelector<HTMLElement>(".title")!;
  const body = shadow.querySelector<HTMLElement>(".body")!;
  (document.body || document.documentElement).append(host);
  const feedback = { host, card, title, body };
  agentFeedbackByHost.set(host, feedback);
  return feedback;
};

const showAgentFeedback = (state: AgentFeedbackState, message: string): void => {
  const feedback = getAgentFeedback();
  feedback.host.style.setProperty("display", "block", "important");
  feedback.card.dataset.state = state;
  feedback.title.textContent = state === "running" ? "Working…" : state === "success" ? "Done" : "Couldn’t finish";
  feedback.body.textContent = message;
  const glyph = feedback.card.querySelector<HTMLElement>(".glyph");
  if (glyph) glyph.textContent = state === "success" ? "✓" : state === "error" ? "!" : "";
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
    Sentry.setTag("conjure.surface", "content");
  } catch {
    // Sentry is optional and must never break host pages.
  }
};

initSentry();

const captureException = (error: unknown) => {
  if (CONJURE_CONFIG.sentry.enabled) {
    Sentry.captureException(error);
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

  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.CONSOLE_EVENT,
      payload: {
        level,
        text: text.slice(0, 12000),
        args: serialized.map((arg) => arg.slice(0, 4000)),
        url: location.href,
        timestamp: Date.now(),
        source
      }
    })
    .catch(() => undefined);
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

const installPageWorldHooks = () => {
  const script = document.createElement("script");
  script.textContent = `(() => {
    if (window.__CONJURE_PAGE_HOOKED__) return;
    window.__CONJURE_PAGE_HOOKED__ = true;
    const source = "${PAGE_HOOK_SOURCE}";
    const serialize = (value) => {
      if (value instanceof Error) return [value.name + ": " + value.message, value.stack || ""].filter(Boolean).join("\\n");
      if (typeof value === "string") return value;
      if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return String(value);
      try {
        const seen = new WeakSet();
        return JSON.stringify(value, (_key, nested) => {
          if (nested && typeof nested === "object") {
            if (seen.has(nested)) return "[Circular]";
            seen.add(nested);
          }
          return nested;
        });
      } catch {
        return Object.prototype.toString.call(value);
      }
    };
    const emit = (level, args, hookSource) => {
      window.postMessage({
        source,
        payload: {
          level,
          args: Array.from(args).map(serialize).map((item) => String(item).slice(0, 4000)),
          text: Array.from(args).map(serialize).join(" ").slice(0, 12000),
          url: location.href,
          timestamp: Date.now(),
          source: hookSource
        }
      }, "*");
    };
    for (const level of ["debug", "info", "log", "warn", "error"]) {
      const original = console[level];
      console[level] = function(...args) {
        emit(level, args, "console");
        return original.apply(this, args);
      };
    }
    window.addEventListener("error", (event) => {
      emit("error", [event.message, event.filename, event.lineno, event.error], "window");
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      emit("error", [event.reason], "unhandledrejection");
    }, true);
  })();`;

  try {
    (document.documentElement || document.head || document.body)?.appendChild(script);
    script.remove();
  } catch (error) {
    captureException(error);
  }
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

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== PAGE_HOOK_SOURCE) return;
  chrome.runtime
    .sendMessage({
      type: CONTENT_MESSAGE.CONSOLE_EVENT,
      payload: event.data.payload
    })
    .catch(() => undefined);
});

// The content bridge exists on every web page, so use it to make mod syncing
// independent of whether the user ever opens the Conjure side panel.
chrome.runtime.sendMessage({ type: CONTENT_MESSAGE.SYNC_MODS }).catch(() => undefined);

document.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(`[${AGENT_ACTION_ATTRIBUTE}]`);
    if (
      !control ||
      !["explain-page", "send-hello-email"].includes(control.dataset.conjureAgentAction || "")
    ) return;

    // Own this trusted click so generated code cannot substitute a canned answer.
    event.preventDefault();
    event.stopImmediatePropagation();
    control.setAttribute("aria-busy", "true");
    if (control instanceof HTMLButtonElement) control.disabled = true;

    const action = control.dataset.conjureAgentAction as "explain-page" | "send-hello-email";
    showAgentFeedback("running", action === "send-hello-email" ? "Sending email…" : "Running agent…");

    chrome.runtime
      .sendMessage({
        type: CONTENT_MESSAGE.AGENT_ACTION,
        action,
        url: location.href
      })
      .then((response: RuntimeResult<{ result: string }>) => {
        if (response?.ok) {
          showAgentFeedback("success", response.data.result);
        } else {
          showAgentFeedback("error", response?.error || "Agent request failed.");
        }
      })
      .catch((error) => {
        showAgentFeedback("error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        control.removeAttribute("aria-busy");
        if (control instanceof HTMLButtonElement) control.disabled = false;
      });
  },
  true
);

installIsolatedWorldHooks();

if (document.documentElement) {
  installPageWorldHooks();
} else {
  document.addEventListener("DOMContentLoaded", installPageWorldHooks, { once: true });
}

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

    sendResponse({ ok: false, error: "Unsupported content message." });
  } catch (error) {
    captureException(error);
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }

  return true;
});

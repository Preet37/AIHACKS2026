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

// Relay Alt/Option key events from the active page to the side panel so the
// voice hotkey works even when the page (not the side panel) has focus.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Alt" || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
  chrome.runtime
    .sendMessage({ type: CONTENT_MESSAGE.VOICE_HOTKEY, event: "keydown" })
    .catch(() => undefined);
});

window.addEventListener("keyup", (e) => {
  if (e.key !== "Alt") return;
  chrome.runtime
    .sendMessage({ type: CONTENT_MESSAGE.VOICE_HOTKEY, event: "keyup" })
    .catch(() => undefined);
});

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

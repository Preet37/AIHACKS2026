// Pure formatting/derivation helpers shared across surfaces. Extracted from
// App.tsx so each surface component can import without duplication.
import type { TraceStatus } from "../surfaceContext";

export const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);

export const formatTraceTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);

export const hostLabel = (url?: string) => {
  if (!url) return "global";
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "global";
  } catch {
    return "global";
  }
};

// Map a trace status to the StatusBlock state used by the ■/□ primitive.
export const traceStatusState = (status: TraceStatus): "active" | "done" | "pending" =>
  status === "running" ? "active" : status === "pending" ? "pending" : "done";

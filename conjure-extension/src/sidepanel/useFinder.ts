// Finder controller (the off-device "Find on this page" feature).
//
// SRP: this hook owns ONLY the finder's state machine and the network/cookie
// handoff to the backend's POST /projects/{id}/agent-task endpoint. It knows
// nothing about how results are rendered (that is FindingsPanel) nor about the
// rest of the side-panel surface state — App.tsx wires it into the command
// flow and exposes the resulting slice via surfaceContext.
import { useCallback, useState } from "react";
import { createAgentTaskUrl } from "../shared/config";
import type { AgentFinding, AgentTaskResponse } from "../shared/messages";

export type FinderStatus = "idle" | "running" | "done" | "error";

/** Which prompts route to the cloud browser agent instead of the chat/build flow. */
export const isFindRequest = (prompt: string) =>
  /^(find|search|look for|shop for)\b/i.test(prompt.trim());

export interface FinderRunOptions {
  /** The current tab URL the cloud browser should start from. */
  url?: string;
  /** Backend project id the task is scoped to. */
  projectId: string;
}

export interface FinderSlice {
  status: FinderStatus;
  findings: AgentFinding[];
  error: string | null;
  /** Browserbase replay link, when the run returned one. */
  replayUrl?: string;
  run: (task: string, options: FinderRunOptions) => Promise<void>;
  clear: () => void;
}

export function useFinder(onError?: (error: unknown) => void): FinderSlice {
  const [status, setStatus] = useState<FinderStatus>("idle");
  const [findings, setFindings] = useState<AgentFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [replayUrl, setReplayUrl] = useState<string | undefined>();

  const clear = useCallback(() => {
    setStatus("idle");
    setFindings([]);
    setError(null);
    setReplayUrl(undefined);
  }, []);

  // Hand the current URL and its cookies to the off-device browser agent.
  const run = useCallback(
    async (taskInput: string, options: FinderRunOptions) => {
      const task = taskInput.trim();
      if (!task) return;
      setStatus("running");
      setError(null);
      setFindings([]);
      setReplayUrl(undefined);
      try {
        const url = options.url;
        if (!url) {
          throw new Error("No active tab URL to search.");
        }
        let cookies: chrome.cookies.Cookie[] = [];
        try {
          cookies = await chrome.cookies.getAll({ url });
        } catch {
          // The remote agent can still search public content while logged out.
          cookies = [];
        }
        const response = await fetch(createAgentTaskUrl(options.projectId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task, url, cookies })
        });
        if (!response.ok) {
          let detail = `Backend returned ${response.status}.`;
          try {
            const body = (await response.json()) as { detail?: string };
            if (body?.detail) detail = body.detail;
          } catch {
            // Non-JSON error body; keep the status-based message.
          }
          throw new Error(detail);
        }
        const data = (await response.json()) as AgentTaskResponse;
        setFindings(data.findings || []);
        setReplayUrl(data.replay_url);
        setStatus("done");
      } catch (err) {
        onError?.(err);
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onError]
  );

  return { status, findings, error, replayUrl, run, clear };
}

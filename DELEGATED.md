# DELEGATED.md — Chrome extension track (off-device "Find on this page")

You are a second agent working in parallel with the primary agent. Read this top to
bottom; assume **no prior context**. Background on the whole project is in `CLAUDE.md`
(skim its "Goal" + "Decision log"). You own **only the Chrome extension**.

## Division of labor (do not cross these lines)
- **You touch ONLY `conjure-extension/`** (the MV3 side-panel extension).
- **Do NOT touch**: `backend/`, `CLAUDE.md`, `DELEGATED.md`, `.env`, `.env.example`,
  `README.md`, `HOW_TO_RUN.md`, `docker-compose.yml`. The primary agent owns those.
- Work on `main`/the current branch in place. No commits unless told.

## What the feature is
A side-panel **"Find on this page"** box already exists. Today it scrapes the user's tab
and POSTs the HTML. We've pivoted: the **backend now spins up an off-device cloud browser**
that does the browsing. So the extension's job shrinks to: send the **task + current tab URL
+ the user's cookies** (so the cloud browser is logged-in as them), then render the result
cards **plus a "watch the agent" replay link**. No more page scraping for this feature.

## THE API CONTRACT (fixed — build exactly to this)
`POST {backendUrl}/projects/{projectId}/agent-task`  (URL helper already exists:
`createAgentTaskUrl(projectId)` in `src/shared/config.ts` — do not change it.)

Request body (JSON):
```jsonc
{
  "task": "warm jackets under $70",
  "url":  "https://www.amazon.com/s?k=jackets",   // the current tab's URL
  "cookies": [ /* raw chrome.cookies.Cookie objects for that URL */ ]
}
```
Response body (JSON):
```jsonc
{
  "project_id": "local-demo",
  "task": "warm jackets under $70",
  "url": "https://www.amazon.com/s?k=jackets",
  "findings": [
    { "title": "...", "url": "https://...", "image": "https://...", "price": "$39.90", "note": "..." }
  ],
  "session_id": "bb_abc123",
  "replay_url": "https://www.browserbase.com/sessions/bb_abc123"
}
```
Errors come back as `{ "detail": "..." }` with HTTP 400/502/503 (already handled by the
existing error path — keep it).

## Your tasks

### 1. Add the `cookies` permission — `conjure-extension/manifest.config.ts`
Current line: `permissions: ["sidePanel", "storage", "tabs", "scripting", "userScripts"],`
Add `"cookies"`:
```ts
permissions: ["sidePanel", "storage", "tabs", "scripting", "cookies", "userScripts"],
```
`host_permissions` is already `["<all_urls>"]`, so `chrome.cookies.getAll` will work on any
site. (`@types/chrome` is installed, so `chrome.cookies` is typed.)

### 2. Extend the response type — `conjure-extension/src/shared/messages.ts`
Find `export interface AgentTaskResponse` and add two optional fields:
```ts
export interface AgentTaskResponse {
  project_id: string;
  task: string;
  url: string;
  findings: AgentFinding[];
  session_id?: string;
  replay_url?: string;
}
```
Leave `AgentFinding` as-is.

### 3. Rework the send — `conjure-extension/src/sidepanel/App.tsx`
**3a.** Add one state var next to the other finder state (search for `findingStatus`):
```ts
const [replayUrl, setReplayUrl] = useState<string | null>(null);
```
**3b.** Replace the whole `runAgentTask` callback (search for `const runAgentTask =`) with
this. Key changes: read cookies instead of scraping HTML; send `{task,url,cookies}`; capture
`replay_url`. (Drop the `getPageContentFromTab` call — but DO NOT delete that function; it's
still used elsewhere for the agent tab-content bridge.)
```ts
  const runAgentTask = useCallback(
    async (taskInput: string) => {
      const task = taskInput.trim();
      if (!task) return;
      setFindingStatus("running");
      setFindingError(null);
      setFindings([]);
      setReplayUrl(null);
      setStatusText("Spinning up a cloud browser to search...");
      try {
        const tabs = await getActiveTabs();
        const tab = tabs.find((candidate) => candidate.active) || tabs[0];
        if (!tab?.url) {
          throw new Error("No active tab URL to search.");
        }
        // Hand off the user's cookies so the cloud browser is logged-in as them.
        let cookies: chrome.cookies.Cookie[] = [];
        try {
          cookies = await chrome.cookies.getAll({ url: tab.url });
        } catch {
          cookies = []; // proceed logged-out if cookie read is unavailable
        }
        const response = await fetch(createAgentTaskUrl(projectIdRef.current), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task, url: tab.url, cookies })
        });
        if (!response.ok) {
          let detail = `Backend returned ${response.status}.`;
          try {
            const body = (await response.json()) as { detail?: string };
            if (body?.detail) detail = body.detail;
          } catch {
            // non-JSON error body; keep status-based message
          }
          throw new Error(detail);
        }
        const data = (await response.json()) as AgentTaskResponse;
        const results = data.findings || [];
        setFindings(results);
        setReplayUrl(data.replay_url || null);
        setFindingStatus("done");
        setStatusText(
          results.length ? `Found ${results.length} item(s)` : "No matching items found"
        );
      } catch (error) {
        captureException(error);
        setFindingStatus("error");
        setFindingError(error instanceof Error ? error.message : String(error));
        setStatusText("Agent task failed");
      }
    },
    [getActiveTabs]
  );
```
**3c.** Render the replay link in the finder panel. In the JSX, find the finder section
(search for `finder-panel`). Right **after** the `<form className="finder-form">…</form>`
and before the error/results blocks, add:
```tsx
        {replayUrl ? (
          <a className="replay-link" href={replayUrl} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            Watch the agent browse
          </a>
        ) : null}
```
`ExternalLink` and the `replay-link` CSS class already exist (used by the mods panel) — no
new icon import or stylesheet change needed.

### 4. Typecheck
```powershell
npm --prefix conjure-extension run typecheck
```
Must be clean (no output = pass). If `chrome.cookies` is flagged as unknown, confirm task 1
added `"cookies"` and that `@types/chrome` is installed (it is).

Optional sanity build: `npm --prefix conjure-extension run build`.

## Notes / gotchas
- `ActiveTabSnapshot` already has a `url: string` field (see `messages.ts`) — use `tab.url`.
- Don't remove the old `text`/`html` scrape helpers; just stop sending them from `runAgentTask`.
- You can't fully E2E test without the backend running (primary agent owns it). Typecheck +
  build is your bar. The contract above is the integration point — match it exactly.
- If anything in the contract seems off, leave a note at the bottom of this file under a
  `## NOTES BACK TO PRIMARY` heading rather than changing backend files.

# Using Conjure (everyday flow)

`HOW_TO_RUN.md` covers first-time setup. This file covers what happens once
it's running: where generated code goes, how it gets applied, and why your
session no longer resets.

## TL;DR

1. Type a request in the Conjure side panel (e.g. "remove YouTube Shorts").
2. The backend generates a small MV3 extension under `demo_code/<project>/`.
3. **Conjure applies it for you** — it injects the generated script + CSS into
   matching tabs and reloads them. You never open `chrome://extensions` to load
   or reload anything.
4. Your conversation is saved, so closing/reopening the panel (or restarting the
   backend) keeps your history.

## One-time setup (required once after this update)

Two things changed that need a one-time action:

1. **Reload the Conjure extension** so Chrome picks up the new build and the new
   `userScripts` permission:
   - `chrome://extensions` → find **Conjure** → click the circular **reload**
     icon. (Or remove it and `Load unpacked` →
     `conjure-extension/dist` again.)

2. **Allow user scripts** for Conjure. The auto-apply feature uses Chrome's
   `chrome.userScripts` API, which Chrome gates behind a toggle:
   - Chrome 138+: `chrome://extensions` → Conjure → **Details** → turn on
     **"Allow user scripts"**.
   - Chrome 120–137: just enable **Developer mode** (top-right of
     `chrome://extensions`).

   If this is off, Conjure will tell you in the panel instead of silently
   failing: *"turn on 'Allow user scripts' (or enable Developer mode), then send
   your request again."*

## Mods: list, change, remove

Every customization Conjure builds is a **mod** — a self-contained content-script
bundle in its own folder under `demo_code/<project>/mods/<mod_id>/`, tracked in
`demo_code/<project>/mods/registry.json`. The side panel shows a **Mods** list:

- **Change** — edit a mod's starter prompt and rebuild it. A prompt change
  *always* regenerates the mod (no "is it already there?" check).
- **Remove** — deletes the mod's files and unregisters its user script from the
  browser (its `chrome.userScripts` entry `conjure-mod-<id>` is removed).
- Each mod shows a verification badge: `verified` / `failed` / `unverified`, with
  a link to the Browserbase **sandbox replay** when available.

### Build vs. reuse (test-before-remake)

When you ask for something new, Conjure first checks the existing mods:

- If a mod already implements your request, it runs that mod through the
  **Browserbase sandbox** to confirm it still works. If it passes, Conjure does
  **not** rebuild it — it tells you it already exists and is verified.
- If no mod matches, or the sandbox check fails, Conjure builds (or rebuilds) it.
- Editing a mod's prompt skips this check and rebuilds immediately.

Verification runs the mod's extension in a real Browserbase browser session
(`verify_mod` → `sandbox.py`), so it needs `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID` in `.env`. Progress streams into the **Sandbox** panel.

### Mod API (backend)

```
GET    /projects/<project>/mods           # list mods
GET    /projects/<project>/mods/bundle     # active mods' bundles (what gets applied)
DELETE /projects/<project>/mods/<mod_id>   # remove a mod
```

## How auto-apply works

- When a turn finishes and the generated project has a `manifest.json` with a
  `content_scripts` entry, the backend sends an `extension_ready` event carrying
  every active mod's bundle (its `matches`, JS, and CSS).
- The Conjure service worker registers each mod with
  `chrome.userScripts.register(...)` under a stable id (`conjure-mod-<mod_id>`),
  re-registering (not duplicating) on every new version and unregistering any mod
  that was removed.
- It then reloads any open tabs that match, so the change is visible immediately.
- Registered user scripts **persist across browser restarts**, so each
  customization keeps applying to future page loads automatically.

### Re-applying manually

The **Mods** panel header has a **refresh** button that re-fetches the mod list
and re-applies every active mod (handy after opening new tabs). The side panel
also re-applies all active mods automatically each time it opens.

## Where the generated code lives

```
demo_code/<project-id>/        # default project-id is "local-demo"
  manifest.json                # matches + which files are content scripts
  content.js                   # generated logic
  shorts.css                   # generated styles (name varies per request)
```

This is the source of truth for what Conjure injects. The agent can now
**overwrite** these files (via the `write_file` tool) to iterate on a previous
result, instead of failing when a file already exists.

## Persistence (why the session no longer resets)

- **Side panel:** the conversation id, messages, and project id are saved to
  `chrome.storage.local` and restored when the panel reopens. Accidentally
  closing Conjure no longer wipes the chat.
- **Backend:** conversations, messages, and agent memory persist in Redis. Make
  sure Redis is running:

  ```powershell
  docker compose up -d
  docker exec conjure-redis redis-cli ping   # -> PONG
  ```

  > Note: on Windows the async Redis client cannot use `localhost` (it resolves
  > to IPv6 `::1` and times out). `.env` therefore uses
  > `redis://127.0.0.1:6379/0`. Keep it as `127.0.0.1`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Conjure can't auto-apply yet…" | Turn on **Allow user scripts** / Developer mode, reload Conjure, resend. |
| Nothing changes on the page | Make sure the backend is running (`/health`) and the tab URL matches the generated `matches`. Click the panel's re-apply button. |
| Change reverts after navigation | The user script should persist; if it doesn't, the extension may have been reloaded without the user-scripts toggle on. |
| Backend uses in-memory store | Redis isn't reachable. `docker compose ps` should show `conjure-redis` healthy; `.env` must point at `127.0.0.1`. |
| Agent stops with "max tool-iteration limit" | Raised to 25 (configurable via `CONJURE_MAX_AGENT_ITERATIONS`). Re-send; the agent now uses `write_file` to edit existing files. |

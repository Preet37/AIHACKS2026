# Conjure — Codex Build Brief

> The Stitch/Codex scaffold renders but is broken: CSP errors, no fonts, wrong
> routing, and screens that don't match the design. This brief fixes the extension
> as an MV3 Chrome extension and conforms it to `CONJURE-DESIGN.md`.
>
> **Source of truth for visuals:** `CONJURE-DESIGN.md` (tokens, primitives, layout
> law, ■/□ semantics). This brief overrides it in exactly one place: **the royal-
> indigo idle splash is removed** (see §4). Everything else in the design doc stands.

**Work in phases. Report a plan before mass edits.** First detect the stack
(framework, bundler, where the manifest + surfaces live) and confirm it's Vite +
CRXJS, then propose the file changes for each phase below and wait for approval.
Fix P0 (the extension is erroring) before any visual work.

---

## P0 — Stop the errors (do this first)

### 0.1 Inline-script CSP violations
MV3 extension pages enforce `script-src 'self'`. Inline scripts and inline event
handlers are blocked.
- Remove every inline `<script>…</script>`, every `on*=` attribute (`onclick`,
  `onload`, …), every `javascript:` URL, and any `eval` / `new Function` /
  `setTimeout("string")`.
- All JS lives in external files loaded with `<script type="module" src="…">`.
- All event handlers are attached in JS via `addEventListener`.
- This applies to the side panel HTML and every extension page (design, run,
  settings).

### 0.2 Vite/CRXJS dev tooling leaking into the loaded extension
The `__LIVE_RELOAD__ is not defined`, `ws://localhost:5173 … 400`, and many of the
inline-script violations come from the CRXJS dev/HMR client being present in the
loaded extension.
- The artifact loaded into Chrome for testing must be a **production build**
  (`vite build`, load the `dist/` folder) — not the dev server.
- Ensure no HMR / live-reload / dev-only code ships in production. Gate any such
  code behind `import.meta.env.DEV` and confirm it's tree-shaken out of `dist/`.
- If keeping CRXJS HMR for local dev, that's fine, but **all acceptance testing and
  the CSP checks below run against the production `dist/`.**

### 0.3 Fonts don't load
Almost certainly remote `@import` / `<link>` to Google Fonts (blocked by CSP and
offline) or unbundled `@font-face` paths.
- Self-host the faces. Bundle woff2 files for **JetBrains Mono** (400, 500) and the
  **pixel display face** (`Departure Mono` if licensed; else the chosen pixel face)
  under `public/fonts/`.
- Declare them with local `@font-face`:
  ```css
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('/fonts/JetBrainsMono-Regular.woff2') format('woff2');
    font-weight: 400; font-display: swap;
  }
  ```
- For the **content-script overlay** (§3, runs in a shadow root on arbitrary
  pages), the font URL must be resolved at runtime and the files must be web-
  accessible:
  - `manifest.web_accessible_resources: [{ "resources": ["fonts/*"], "matches": ["<all_urls>"] }]`
  - Inject the `@font-face` into the shadow `<style>` using
    `chrome.runtime.getURL('fonts/JetBrainsMono-Regular.woff2')`.
- No Google Fonts CDN anywhere.

### 0.4 Disconnected ports / bfcache / context invalidation
`Attempting to use a disconnected port object`, the bfcache port message, and
`Extension context invalidated` are all lifecycle fragility.
- Prefer one-off `chrome.runtime.sendMessage` over long-lived `chrome.runtime.connect`
  ports unless you genuinely need streaming (e.g. run-trace logs).
- Where a port is required: listen for `port.onDisconnect`, null the reference,
  reconnect on `pageshow` / visibility change, and wrap every `postMessage` in
  try/catch.
- Guard every `chrome.*` call against invalidation: `if (!chrome.runtime?.id) return;`
  and tear listeners down gracefully when it's gone (common in dev on reload).

**P0 acceptance:** load `dist/` unpacked → zero CSP errors, zero `__LIVE_RELOAD__`
/ websocket errors, fonts render, no uncaught port/context errors when navigating
and toggling surfaces.

---

## P1 — Architecture & routing (the behavior bugs)

Conjure is four surfaces delivered four different ways. Wire them exactly:

### Surfaces
- **Side panel = manage** (`chrome.sidePanel`, `side_panel.default_path`). The
  persistent manager: status bar, `MODS` pane, `RUNS` pane, command input. Buttons
  here open the other surfaces; they do **not** render inside the panel.
- **Command bar = invoke, OVER THE PAGE (bug f).** A content-script overlay on the
  active tab, summoned by `⌘K`, available anywhere even with the side panel closed.
  **Never** renders in the side panel.
- **Design = manipulate, NEW TAB (bug d).** Opens a full extension page.
- **Run trace ("track") = monitor, NEW TAB (bug d).** Opens a full extension page.
- **Settings = NEW TAB (bug e).** Options page opened in a tab.

### Command bar overlay (bug f) — the important one
- Manifest `commands`:
  ```json
  "commands": {
    "toggle-command-bar": {
      "suggested_key": { "default": "Ctrl+K", "mac": "Command+K" },
      "description": "Open the Conjure command bar"
    }
  }
  ```
- Service worker listens `chrome.commands.onCommand`; on `toggle-command-bar` it
  messages the active tab's content script (`chrome.tabs.sendMessage`).
- A content script registered on `<all_urls>` mounts the palette into a **Shadow
  DOM** root (so host-page CSS can't bleed in and our styles stay isolated). Build
  the UI with DOM APIs + a `<style>` in the shadow root — **never inject a `<script>`
  into the page** (that runs in the page world under the page's CSP and will be
  blocked, which is the second cluster of your CSP errors).
- All overlay logic runs in the content script's isolated world; it talks to the
  background/side panel via `chrome.runtime.sendMessage`.
- Restricted pages (`chrome://*`, the Web Store, other extensions) can't host
  content scripts — detect failure and fall back to opening the side panel or a
  dedicated `command.html` tab.

### Design / Run / Settings as tabs (bugs d, e)
- Open with `chrome.tabs.create({ url: chrome.runtime.getURL('design.html') })`
  (and `run.html`). Pass context (target tab id, run id, selected element) via URL
  params or `chrome.storage.session`.
- Settings: `options_ui: { "page": "settings.html", "open_in_tab": true }` and open
  via `chrome.runtime.openOptionsPage()`.
- Note the nuance for design mode: editing the *user's real page* still happens via
  the content-script `SelectionOverlay` on that page; the new `design.html` tab is
  the workspace/inspector/layer-tree host. If the intended behavior is different,
  flag it in the plan.

### Manifest keys to ensure (MV3)
- `manifest_version: 3`, `background.service_worker`.
- `permissions`: `sidePanel`, `tabs`, `scripting`, `storage`, `commands`.
- `host_permissions`: `<all_urls>` (required for the overlay — justify in the plan).
- `web_accessible_resources` for `fonts/*` and any overlay assets, matched to
  `<all_urls>`.
- `content_scripts` (or `chrome.scripting.registerContentScripts`) on `<all_urls>`
  for the overlay mount.
- Optional explicit `content_security_policy.extension_pages: "script-src 'self';
  object-src 'self'"`.

**P1 acceptance:** `⌘K` opens the overlay on a normal webpage with the side panel
closed; clicking Design / Track / Settings each opens the correct new tab; the side
panel only ever shows the manager.

---

## P2 — Visual conformance to the design doc

Apply `CONJURE-DESIGN.md` everywhere: the token block (§2), primitives (§6), the
layout law (§5), and `■`/`□` status semantics (§4). Then per surface:

- **Side panel (manage):** status bar (`■ conjure  [1][2][3] … ⌘K`) → `MODS` pane
  (rows + square Toggles) → `RUNS` pane (run row + mini `■`/`□` step log) → command
  input pinned bottom. Empty state = a quiet near-black pane with a one-line hint to
  press `⌘K`. **No blue splash.**
- **Command bar (overlay):** large CommandInput with accent `■` + block cursor `▌`,
  three routed suggestion rows (first highlighted with `--cj-accent-wash` + 1px
  accent left edge), nav/esc footer. Dimmed page behind.
- **Design (tab):** two-pane — canvas with `SelectionOverlay` (accent square handles
  + floating move/text/color/delete toolbar) | inspector Window
  (`■ ✕` title bar, `LABEL` / `FILL` grayscale+one-indigo swatches / `PADDING`
  slider / `ONCLICK ▸ run agent: linkedin`).
- **Run trace (tab):** two-pane — numbered step log (`01…04`, `■` dim done /
  `■` accent current / `□` pending; numbered markers are valid here, it's a real
  sequence) | metadata pane (`RUN/AGENT/ELAPSED/STEP/SCOPE`) → hairline ProgressBar.
  Top bar `■ running` + `[ stop ]`.
- **Planning (panel or tab):** `GOAL ▸ …` bar → clarifying question → full-width
  OptionCards (first selected, accent border + `■`) → write-your-own input →
  `[ build ↗ ]`.
- **Settings (tab):** stacked panes — `CONNECTORS` (status `■`/`□` + Toggle),
  `PERMISSIONS` (Toggles), `MODE` (square segmented planning/coding).

### Loud-ground decision (because the splash is gone)
Removing the splash leaves royal indigo `#222290` unused. Default: drop it from
working chrome (stays near-black + indigo accent). **Recommended:** repurpose
`#222290` as the `⌘K` overlay scrim/border so the loud-indigo identity survives
without a hero screen. Implement the recommended option unless told otherwise; keep
it as a single token so it's trivial to remove.

**P2 acceptance:** every screen passes the `CONJURE-DESIGN.md` §10 audit checklist;
no rounded corners; one indigo accent on state only; mono everywhere with the pixel
face only on the wordmark; tiled layouts, no centered cards on empty ground, no
single-column-log screens.

---

## Execution order & reporting

1. Detect stack; confirm Vite + CRXJS; report surface/file map and the plan.
2. P0 fixes → verify the acceptance bullet on a production `dist/` load.
3. P1 routing → verify acceptance.
4. P2 visual conformance → run the design-doc audit checklist, report results and
   any judgment calls.
Keep commits scoped (one phase / one surface each) so diffs stay reviewable.

---

## Kickoff prompt (paste into Codex)

```
Read CONJURE-BUILD.md and CONJURE-DESIGN.md at the repo root. The extension renders
but is broken: CSP errors, no fonts, wrong routing, and screens that don't match the
design. Fix it as an MV3 Chrome extension and conform the UI to the design doc.

Don't mass-edit yet. First: detect the stack (confirm Vite + CRXJS, find the
manifest and where each surface lives) and report a file-level plan for each phase.
Wait for my approval, then execute P0 → P1 → P2 in order, one scoped commit at a
time, fixing the errors before any visual work.

P0 (stop the errors): remove all inline scripts and inline event handlers (MV3
script-src 'self'); ensure the loaded artifact is a production `vite build` with no
HMR/live-reload/dev code shipped (the __LIVE_RELOAD__ / ws://localhost:5173 errors);
self-host JetBrains Mono + the pixel face as bundled woff2 (no Google Fonts CDN),
web-accessible for the content-script overlay; make all chrome.* ports/calls
lifecycle-safe (onDisconnect, reconnect, `if(!chrome.runtime?.id)return`). Acceptance:
load dist/ unpacked with zero CSP/websocket/port/context errors and working fonts.

P1 (routing): side panel = manager only; ⌘K opens the command bar as a content-
script Shadow-DOM overlay OVER the active page, available even when the side panel
is closed (never in the panel); Design and Track each open a new extension tab;
Settings opens the options page in a new tab. Never inject a <script> into the host
page. Remove the royal-indigo idle splash entirely.

P2 (visual): apply CONJURE-DESIGN.md tokens/primitives/layout-law/■-semantics to
every surface; the empty state is a quiet near-black panel, not a blue splash;
repurpose #222290 as the ⌘K overlay scrim/border (keep it one token so it's easy to
drop). Finish with the design-doc §10 audit checklist per screen and report results
plus any judgment calls.
```

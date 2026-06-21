# Conjure — Design System & Implementation Brief

> Single source of truth for Conjure's look. The Stitch/Codex scaffold got screens
> on the page; this document is how they become *one* system. Every color, size,
> and component below is a contract. If something in the codebase doesn't derive
> from these tokens or match these primitives, it's a bug to fix, not a variation
> to keep.

---

## 0. The one-paragraph philosophy

Conjure is a small operating system layered over the browser — a tool that rewrites
your browser from natural-language intent. So it should look like a **riced Arch
Linux tiling window manager**, not a chat app: dense, square, monospaced, tiled
edge-to-edge, with a persistent status bar and key/value readouts everywhere. The
aesthetic is **terminal brutalism with exactly one loud moment** (the idle splash).
It is restrained on purpose: a single indigo accent that only ever marks *state*,
two grounds, two type weights, zero rounded corners. Readability is the boss —
every texture stays quiet enough that you never consciously notice it. It is **not**
nostalgia cosplay and **not** a generic dark dashboard.

**The five rules that make it cohere**
1. **One accent, load-bearing.** Indigo `#6C6AF5` appears only for active / running
   / selected / primary. Never decoration. No second hue, anywhere.
2. **Two grounds.** Working chrome on near-black-indigo `#08080F`. The idle splash
   and empty states — and *only* those — on royal indigo `#222290`.
3. **Tiled, never floating.** Edge-to-edge bordered panes under a persistent top
   status bar. Never a single centered card on an empty background. Never a
   single-column chat/log.
4. **Square + hairline + ■.** Zero `border-radius`. 1px borders at low-opacity
   white. Status is filled `■` / hollow `□` blocks, never round dots.
5. **Mono everywhere, one pixel face once.** JetBrains Mono for all UI; the pixel
   display face only on the `CONJURE` wordmark and splash headings.

---

## 1. The signature (don't let a refactor sand this off)

This palette and shape language sit very close to two well-known generic looks
("near-black + one bright accent", "hairline broadsheet, zero radius"). What makes
Conjure *Conjure* and not a default dark dashboard is four subject-specific moves.
Keep them sharp:

- **Tiling-WM chrome** — top status bar with workspace blocks, panes that touch
  edges, no gutters of empty black.
- **The neofetch splash** — the idle state is an ASCII mark + a key/value system
  readout. This is the loud moment; it carries the identity.
- **The pixel display face doing real work** — wordmark and splash headings, not a
  decorative afterthought.
- **`■` as real status semantics** — the block glyph encodes state (see §4), it is
  not a bullet.

If a screen loses all four, it has reverted to the default. That's the failure mode
to audit against.

---

## 2. Tokens (the contract)

Define these once as CSS custom properties (or map into the Tailwind theme). Nothing
in the codebase should hardcode a hex, a radius, or a font stack.

```css
:root {
  /* grounds */
  --cj-ground:        #08080F; /* working surface — all dense chrome */
  --cj-surface:       #101026; /* raised panes, inputs, windows */
  --cj-surface-2:     #16163A; /* hover / nested surface */
  --cj-loud:          #222290; /* royal indigo — splash & empty states ONLY */

  /* text */
  --cj-text:          #F0F0F5;
  --cj-dim:           #8A8AA4;
  --cj-faint:         #54546E;
  --cj-on-loud:       #FFFFFF; /* text on --cj-loud */
  --cj-on-loud-dim:   #B9B9E6;

  /* accent — load-bearing, STATE ONLY */
  --cj-accent:        #6C6AF5;
  --cj-accent-bright: #ADABFF; /* accent shown on --cj-loud */
  --cj-accent-wash:   rgba(108,106,245,0.16); /* active toggle / highlighted row */

  /* lines */
  --cj-line:          rgba(240,240,245,0.14);
  --cj-line-strong:   rgba(240,240,245,0.28);
  --cj-line-loud:     rgba(255,255,255,0.22); /* hairlines on --cj-loud */

  /* shape */
  --cj-radius: 0; /* always. there are no rounded corners in Conjure. */

  /* type */
  --cj-font-mono:  'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
  --cj-font-pixel: 'Departure Mono', 'Silkscreen', monospace; /* wordmark + splash only */

  /* type scale */
  --cj-fs-micro: 11px; /* metadata keys, hints, footer */
  --cj-fs-body:  13px; /* default UI text, rows, logs */
  --cj-fs-label: 16px; /* pane / section emphasis */
  --cj-fs-title: 22px; /* window + screen titles */
  --cj-fs-hero:  44px; /* CONJURE wordmark (pixel) */

  /* weights — only two */
  --cj-w-regular: 400;
  --cj-w-medium:  500;

  /* spacing */
  --cj-pane-pad: 12px;
  --cj-row-gap:  6px;
  --cj-bar-h:    34px; /* status bar + command bar height */
}
```

Rules that ride on the tokens:
- **Sentence case** for prose and labels; `UPPERCASE` only for metadata keys and
  short section tags (`MODS`, `SCOPE`), with `letter-spacing: 0.12em`.
- **Two weights only** (400 / 500). No 600/700 — heavy mono reads clumsy.
- **No gradients, drop shadows, blur, or glow.** Flat fills only. The one allowed
  "shadow" is a focus ring: `0 0 0 1px var(--cj-accent)`.

---

## 3. Color usage

- `--cj-ground` is the canvas for every screen except the splash.
- `--cj-surface` raises panes, inputs, windows, and the command palette off the
  ground by one step. `--cj-surface-2` is hover/nested only.
- `--cj-loud` is **exclusively** the idle splash and full-screen empty states. If
  royal indigo appears behind dense working chrome, that's a bug.
- `--cj-accent` marks state and nothing else. A row that is merely present is
  `--cj-text`/`--cj-dim`; a row that is *active/selected/running* gets accent. If
  you can't name the state the accent is reporting, remove it.
- **Forbidden:** any hue that isn't the indigo family. The old coral/orange is gone.
  No red error states, no green success — express status through `■`/`□` + text, or
  a brighter/dimmer indigo, not a new color. (One pragmatic exception: a genuine
  destructive confirm may tint text, but prefer wording + the accent.)

---

## 4. Status blocks (the `■` semantics)

The block glyph is a typed status indicator. Use it consistently everywhere:

| Glyph | Color | Meaning |
|-------|-------|---------|
| `■` | `--cj-accent` | active · running · current step · selected · connected |
| `■` | `--cj-dim` | completed · present-but-inactive |
| `□` | `--cj-faint` | pending · off · not connected |

Never substitute a round dot, spinner, or colored pill for these. A "running"
animation, if any, is the accent `■` pulsing opacity — nothing else.

---

## 5. Layout law

Every screen obeys this skeleton:

```
┌───────────────────────────────────────────────┐
│ status bar  ■ conjure  [1][2][3]      scope ⌘K │  <- persistent, --cj-bar-h
├──────────────┬────────────────────────────────┤
│ pane         │ pane                            │
│ (header +    │ (header + dense key/value body) │  <- tiled, edge-to-edge,
│  dense rows) │                                 │     divided by 1px --cj-line
├──────────────┴────────────────────────────────┤
│ command bar  ▶ ask or speak to conjure…    ⌘K  │  <- where applicable
└───────────────────────────────────────────────┘
```

- **Panes touch edges and each other**, separated by 1px `--cj-line`. No drop
  shadows, no rounded cards floating in margin.
- **No empty regions.** Fill panes with key/value metadata. If a pane is sparse,
  it's the wrong layout — merge or add a readout.
- **No single-column chat/log as a whole screen.** A log is a *pane* beside a
  metadata pane, never the entire view.
- The side panel (~380px) is the same law rotated vertical: status bar → stacked
  panes → command bar, each filling the panel width.

---

## 6. Component primitives

Build these once, compose every screen from them. Each is square, hairline,
mono, token-driven.

**StatusBar** — height `--cj-bar-h`, `border-bottom: 1px var(--cj-line)`. Left:
`■` (accent) + `conjure` + workspace blocks `[1][2][3]` (active block = 1px accent
border). Right: context (`scope`, `⌘K`, idle `■`). `--cj-fs-micro`.

**Pane** — `border: 1px var(--cj-line)`, `background: --cj-ground` or `--cj-surface`,
`padding: --cj-pane-pad`. Header is a `// name` tag in `--cj-faint`, `--cj-fs-micro`,
uppercase-optional. Body is rows or a metadata block.

**MetadataBlock** (the signature molecule) — a `grid-template-columns: auto 1fr`,
`gap: --cj-row-gap 18px`. Keys `--cj-dim` `--cj-fs-micro`; values `--cj-text`. The
`STATE` row's value leads with a status `■`. Used for mods, runs, inspector,
splash, settings — the same molecule everywhere.

**Toggle** — a `26×13px` square, `1px --cj-line`. Off: faint knob left. On:
`border: 1px --cj-accent`, `background: --cj-accent-wash`, accent knob right. No
rounding, no slide animation beyond knob position.

**Button** — square, `border: 1px --cj-line` (or `--cj-accent` for primary),
transparent fill, `--cj-text`. Hover: `background: --cj-surface-2`. Active scale
`0.98`. Action buttons that kick off work read `[ run ↗ ]` / `[ build ↗ ]`.

**Window** (design-mode panels) — a Pane with a title bar: `border-bottom: 1px
--cj-line`, title text + `■ ✕` controls flush right. The WM idiom — title bars are
hairline + mono, never beveled or gradient.

**CommandInput** — full-width bar, `border-top: 1px --cj-line`, `--cj-bar-h`. `▶`
marker, mic icon, placeholder in `--cj-faint`, `⌘K` chip right. The block cursor in
the palette is an accent `▌`.

**OptionCard** (planning) — full-width Pane row, one-line title (`--cj-fs-body`,
weight 500) + two-line description (`--cj-dim`). Selected: `1px --cj-accent` border
+ leading accent `■`.

**SelectionOverlay** (design mode) — four small filled-square accent handles at an
element's corners + a floating mono toolbar (move / text / color / delete icons)
above it. Snap guides are 1px accent lines.

**ProgressBar** — 2px track `--cj-line`, fill `--cj-accent`. Paired with an `n/total`
readout in `--cj-fs-micro`.

**NeofetchSplash** (loud) — full `--cj-loud` ground. Left: pixel/ASCII block mark in
`--cj-on-loud`. Right: pixel `conjure` wordmark + MetadataBlock (white values,
`--cj-on-loud-dim` keys) + a row of the five palette swatches. The one place the
pixel face and the loud ground appear.

---

## 7. Surface → primitive map

The product has four altitudes; each composes from §6.

- **Invoke — Command bar** (`⌘K` overlay over a dimmed page): CommandInput (large)
  + a list of routed suggestion rows, first row highlighted (`--cj-accent-wash` +
  1px accent left edge) + a nav/esc footer.
- **Manage — Home side panel**: StatusBar → Pane `MODS` (rows + Toggle) → Pane
  `RUNS` (run row + mini step log using `■`/`□`) → CommandInput. Idle state swaps the
  body for NeofetchSplash.
- **Manipulate — Design mode**: StatusBar → two-pane (canvas with SelectionOverlay |
  inspector Window with MetadataBlock + swatches + slider). Optional authoring view:
  three-pane (components palette | canvas mid-drag | layer tree).
- **Monitor — Run trace**: StatusBar (`■ running` + `[ stop ]`) → two-pane (numbered
  step log | metadata pane `RUN/AGENT/ELAPSED/STEP/SCOPE`) → ProgressBar. Numbered
  steps (`01/02/03`) are correct *here* because it's a true sequence — don't use
  numbered markers decoratively on other screens.
- **Splash / settings**: NeofetchSplash (loud); Settings is stacked Panes
  (`CONNECTORS` / `PERMISSIONS` / `MODE`) of Toggle + status rows + a square
  segmented control.

---

## 8. Motion & accessibility (the quality floor)

- **Compositor-only motion.** Animate `transform`/`opacity` only. The running `■`
  pulse, the block-cursor blink (`steps(1)`), knob position. Nothing else moves.
- **Gate everything behind `prefers-reduced-motion`** — cursor goes solid, pulse
  stops, the splash is static. The static aesthetic must be fully readable.
- **Visible keyboard focus** on every interactive element: `0 0 0 1px --cj-accent`.
- **Keyboard model**: `⌘K` opens the command bar, `esc` cancels, `↑/↓` navigate
  suggestions, `enter` commits.
- **Contrast**: `--cj-text` on `--cj-ground` and white on `--cj-loud` both clear
  AA; `--cj-dim` is for secondary text only, never primary content.
- **Copy** (interface voice): name things by what the user controls ("hide Shorts",
  not "inject CSS rule"). Empty states invite an action. Errors state what happened
  and the fix, in the interface's voice, no apology. Active voice, sentence case.

---

## 9. Anti-patterns to audit out

- A card centered on empty `--cj-ground` → tile it into panes.
- A whole screen that is one scrolling column → make the log a pane beside metadata.
- Any `border-radius > 0` → set to `--cj-radius`.
- Any second hue (leftover coral/orange, stray blue/red swatches, green "success")
  → reduce to indigo + `■`/`□` + text.
- Round status dots, spinners, or pills → `■`/`□`.
- Royal indigo behind dense chrome → that ground is splash-only.
- Sans-serif creeping in, or the pixel face used for body text → mono for UI, pixel
  for wordmark/splash only.
- Soft shadows / gradients / glows → flat fills.
- Decorative `01/02/03` markers outside a real sequence → remove.

---

## 10. Implementation plan for the refactor

Do this in phases; show a plan/diff before mass edits.

1. **Detect the stack** (React/Tailwind? vanilla? CSS modules?) and report it.
2. **Create one tokens source** (§2) — a `tokens.css` `:root` block and/or a
   Tailwind theme extension — and wire it globally. Nothing else hardcodes values.
3. **Build the primitives** (§6) as shared components/classes. One implementation
   each; delete per-screen duplicates.
4. **Refactor each surface** (§7) to compose primitives. One screen per commit so
   diffs stay reviewable.
5. **Sweep for anti-patterns** (§9). Grep for `border-radius`, stray hex colors,
   round-dot/spinner components, and any non-indigo hue; fix to tokens.
6. **QA pass** against the checklist below; report what changed and any judgment
   calls.

### Audit checklist (every screen must pass)

- [ ] Status bar present; panes tiled edge-to-edge; no centered card on empty ground
- [ ] No screen is a single scrolling column
- [ ] All colors/radii/fonts come from tokens — zero hardcoded values
- [ ] `border-radius` is 0 everywhere
- [ ] Exactly one accent (indigo); no other hue anywhere
- [ ] Accent appears only on real state; `■`/`□` semantics per §4
- [ ] Royal indigo only on splash/empty
- [ ] JetBrains Mono for UI; pixel face only on wordmark/splash
- [ ] Two weights only (400/500); sentence case; uppercase only for keys/tags
- [ ] Keyboard focus visible; `⌘K`/`esc`/`↑↓` wired; reduced-motion respected
- [ ] The four signature moves (§1) are intact on the screens that should have them

---

## Kickoff prompt (paste into Claude Code)

```
Read CONJURE-DESIGN.md at the repo root — it's the single source of truth for the
UI. The current screens were scaffolded by Stitch + Codex and are visually
inconsistent. Your job is to make the whole frontend match the document and feel
like one system.

Work in phases and DON'T mass-edit yet:
1. Detect and report the stack (framework, styling approach, where screens live).
2. Propose a tokens source from §2 (CSS :root and/or Tailwind theme) and the list
   of shared primitives you'll build from §6. Show me this plan first.
3. After I approve, implement tokens globally, build each primitive once, then
   refactor each surface (§7) one commit at a time to compose those primitives.
4. Run the §9 anti-pattern sweep (grep for border-radius, stray hex, round
   dots/spinners, any non-indigo hue) and fix to tokens.
5. Finish with the §10 audit checklist per screen and report results + any
   judgment calls.

Hard rules from the doc: one indigo accent used only for state; two grounds
(#08080F working, #222290 splash-only); zero border-radius; square ■/□ status
blocks, never round dots; JetBrains Mono everywhere with the pixel face only on the
wordmark and splash; tile every screen edge-to-edge under a status bar — never a
centered card on empty background, never a single-column log. Preserve the four
signature moves in §1; if a change would flatten Conjure toward a generic dark
dashboard, stop and flag it.
```

---
name: Siren Studio
description: A local Mermaid editor where the graph is shared design intent — instrument-calm, dark-first, built from ink.
colors:
  void-ink: "#0b0e14"
  panel-ink: "#0e1219"
  raised-ink: "#11151d"
  well-ink: "#080a0f"
  hover-ink: "#1a212c"
  active-ink: "#222b3a"
  rule-line: "#202836"
  hairline-rule: "#1a212c"
  graphite-ink: "#e6edf3"
  dim-annotation: "#8b98ab"
  faint-annotation: "#74808f"
  faint-annotation-light: "#636c7a"
  cobalt-signal: "#7c9cff"
  cobalt-signal-deep: "#4668d8"
  cobalt-signal-deep-hover: "#3f61cc"
  cobalt-signal-light: "#3366d9"
  signal-green: "#3fb950"
  signal-amber: "#d29922"
  signal-red: "#f85149"
  code-well: "#0a0d13"
  paper-mist: "#eef1f5"
  paper-white: "#ffffff"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.6px"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  nano:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.5px"
rounded:
  xxs: "3px"
  xs: "4px"
  compact: "5px"
  small: "6px"
  sm: "7px"
  base: "8px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt-signal-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "6px 16px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-signal-deep-hover}"
  button-primary-disabled:
    backgroundColor: "{colors.cobalt-signal-deep}"
    textColor: "#ffffff"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.dim-annotation}"
    rounded: "{rounded.sm}"
    size: "30px"
  icon-button-hover:
    backgroundColor: "{colors.hover-ink}"
    textColor: "{colors.graphite-ink}"
  icon-button-active:
    backgroundColor: "{colors.active-ink}"
    textColor: "{colors.cobalt-signal}"
  ghost-button:
    backgroundColor: "transparent"
    textColor: "{colors.dim-annotation}"
    rounded: "{rounded.sm}"
    padding: "7px"
  status-pill:
    backgroundColor: "{colors.well-ink}"
    textColor: "{colors.dim-annotation}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  side-tab:
    backgroundColor: "transparent"
    textColor: "{colors.faint-annotation}"
    rounded: "{rounded.sm}"
    padding: "6px 4px"
  side-tab-active:
    backgroundColor: "{colors.active-ink}"
    textColor: "{colors.graphite-ink}"
  text-field:
    backgroundColor: "{colors.well-ink}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
---

# Design System: Siren Studio

## Overview

**Creative North Star: "The Lab Notebook"**

Siren Studio is a notebook an engineer keeps open next to the thing they are
building. The diagram is the page; the surrounding chrome is the desk. Surfaces
are built from a ladder of near-black inks, rules are hairline, and type is
small and exact, because the notebook's job is to let a person read a system
without ceremony and then point at what is wrong. Nothing is decorated. The
only saturated color is a cobalt signal that says *something here is live*.

The mood is **calm precision**. Density is high and deliberate — four regions
(files, editor, graph, agent) coexist in one viewport at 13.5px — but weight is
carried by spacing and the ink ramp rather than by borders, fills, or badges.
Motion is limited to the two transitions the work actually needs: the panel
grid easing when a region opens or closes, and the splitter tracking the
pointer with easing explicitly disabled so the drag never lags. The interface
is dark-first, and its light theme is a true peer — the same structure drawn on
paper, not an inversion.

The world is explicitly *not* a dashboard and *not* a chat app. There are no
cards floating on gradients, no glass, no oversized display type, no accent
washes behind content. The graph is the only thing allowed to be visually
complex; everything around it is a ruled margin.

**Key Characteristics:**
- Four-step near-black ink ladder for depth; shadows only for true floats.
- A single restrained accent (Cobalt Signal) reserved for state, never decoration.
- Two typographic registers: system sans for the interface, mono for anything literal.
- Dense, flat, hairline-ruled regions under a fixed 3-row app grid.
- Dark-first with a fully realized light peer theme.

## Colors

The palette is almost entirely a neutral ink ramp; one cobalt signal and three
semantic lamps carry every meaningful color in the product.

### Primary
- **Cobalt Signal** (`#7c9cff`): The one accent, used for text and thin strokes
  — the active tab, the focused field border, the current selection,
  link-styled graph nodes, the connection lamp, and the caret. It is never a
  filled surface behind text.
- **Cobalt Signal Deep** (`#4668d8`), deepening to `#3f61cc` on hover: The
  filled primary button — the single place white text sits on the accent. It is
  deliberately deeper than Cobalt Signal so the label clears AA (4.96:1;
  5.54:1 on hover); the bright accent would put it at 2.6:1.
- **Cobalt Signal (Light)** (`#3366d9`): The light theme's accent for both text
  and the primary fill, because the periwinkle does not hold contrast on paper.

### Semantic Signals
- **Signal Green** (`#3fb950`): Connection online, validation passed, a wired
  agent-awareness file. Used as a lamp or a text color, never a surface.
- **Signal Amber** (`#d29922`): Warnings and the agent-notice strip (an amber
  wash at ~12% behind a ~45% amber border). The "empty reply" state.
- **Signal Red** (`#f85149`): Errors, the destructive close affordance, failed
  lint, the offline lamp. Same low-alpha-wash rule as amber.

### Neutral
- **Graphite Ink** (`#e6edf3`): Primary text on dark — near-white, never pure
  white, so the ladder below it stays legible.
- **Dim Annotation** (`#8b98ab`): Secondary text, inactive icons, control labels.
- **Faint Annotation** (`#74808f` dark / `#636c7a` light): Tertiary text, panel
  headings, placeholders, gutter line numbers, status bar — kept at ≥4.5:1 on
  every surface in both themes.
- **Void Ink** (`#0b0e14`): The app background, beneath everything.
- **Well Ink** (`#080a0f`) and **Code Well** (`#0a0d13`): Recessed surfaces —
  inputs, the palette list, inline code, the editor gutter and canvas.
- **Panel Ink** (`#0e1219`): The sidebar and the agent panel, one step up from void.
- **Raised Ink** (`#11151d`): Top bar, pane heads, menus, modals, toasts —
  the layer that reads as "above the page".
- **Hover Ink** (`#1a212c`) and **Active Ink** (`#222b3a`): The interaction
  steps. Hover is the first response; active (selected tab, active tree row) is
  the committed state.
- **Rule Line** (`#202836`) and **Hairline Rule** (`#1a212c`): 1px structural
  borders and the softer internal dividers respectively.
- **Paper Mist** (`#eef1f5`) and **Paper White** (`#ffffff`): The light theme's
  equivalent recessed and raised surfaces; Paper White also backs the light code area.

### Named Rules
**The One Signal Rule.** Cobalt Signal marks one current thing per region —
the focused field, the open tab, the selected node. It is never a background
wash, never a gradient, and never used to decorate a static element.

**The Deep-Fill Rule.** The only filled surface that carries white text is
Cobalt Signal Deep. It never lightens toward the bright accent on interaction,
because that would drop the label to 2.6:1; hover deepens it instead (5.54:1).

**The Ink Ladder Rule.** Depth is expressed by stepping the surface ramp
(Code/Well → Void → Panel → Raised), one step per layer, and never by stacking
two borders or two shadows. If a surface needs to feel higher, step the ramp;
do not reach for the shadow token.

## Typography

**UI Font:** the system stack — `-apple-system, BlinkMacSystemFont, "Segoe UI",
Roboto, "Helvetica Neue", Arial, sans-serif`
**Mono Font:** `ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo,
Consolas, monospace`

**Character:** A native-OS interface voice (fast, familiar, invisible) paired
with a monospace that does the substantive reading. The sans never appears above
18px; the mono never appears below 11px. The pairing is deliberately
low-contrast in personality — neither voice performs.

### Hierarchy
- **Display** (600, 18px, 1.3): The empty-state heading only ("Start a diagram").
  This is the single largest text in the product.
- **Title** (600, 13px, 1.3): Brand name, agent name, modal headings. The
  semantic heading size; there is no larger tier because this is an Operate surface.
- **Body** (400, 13.5px, 1.55): Chat messages, ledger entries, dialog copy,
  descriptions. Kept at 13.5px to preserve density.
- **Label** (500, 11px, 0.6px tracking, uppercase): Panel headings, chat roles,
  field labels ("Model"), file-attachment names. Always uppercase, always tracked.
- **Mono** (400, 13px, 1.55): The editor body (CodeMirror), file paths, the
  workspace root, status-bar readouts, model costs, inline code.
- **Small** (400, 12px, 1.5): Dense controls that sit below body text — tabs,
  side tabs, quick prompts, chip labels.
- **Nano** (500, 10px, 0.5px tracking, uppercase): The smallest tier — outline
  kind badges and compact role labels.

### Named Rules
**The Two-Register Rule.** Sans carries the interface; mono carries anything
literal — a path, a filename, a node id, a version, a source line. If a value
could be pasted into a terminal unchanged, it is set in mono. This is why the
status bar, the pane title, and the file root are mono by default.

**The No-Display-Type Rule.** Type never exceeds 18px and never uses a
display or editorial face. Size is not how this interface creates hierarchy;
position, the ink ramp, and uppercase labels are.

## Layout

A fixed three-row app grid fills the viewport exactly (100vh, `overflow:
hidden`): a **50px top bar**, a **1fr body**, and a **26px status bar**. The
body is itself a four-column grid — **250px sidebar · flexible workbench ·
5px splitter · 370px agent panel** — and the workbench splits again into a
**50% editor pane** and the viewer. Both the sidebar and agent columns collapse
to `0` and their contents fade out and disable pointer events, rather than being
removed from the DOM; the grid transitions its columns over 0.18s so opening a
region reads as a drawer, not a jump.

Spacing is a tight, hand-set rhythm rather than a formal scale: 4/6/8px gaps
inside controls and lists, 10/12px padding at panel and composer edges, 16px in
modals and empty states. Rows are compact by design — tree items and chat
messages run 4–5px of vertical padding and 12.5px type so that a dense graph,
its outline, and a running conversation all stay visible at once. Splitter hits
are 5px wide but carry a 2px-inset highlight that only appears on hover or drag.

The only breakpoint is `max-width: 1100px`, which narrows the agent panel to
320px and the sidebar to 210px while keeping all four regions present.

## Elevation & Depth

This is a **tonal** system, not a shadowed one. Depth is drawn with the ink
ladder described in Colors; the single shadow token exists solely for elements
that genuinely float above the page — dropdown menus, modals, and toasts. Panels
do not cast shadows onto each other; they are separated by 1px rules and a step
in surface lightness.

### Shadow Vocabulary
- **Floating surface** (`box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45)` dark /
  `0 14px 40px rgba(30, 40, 60, 0.16)` light): The one shadow. Applied to menus,
  the modal, and toasts. Its purpose is to detach a floating layer from the page,
  not to imply a physical light source.

### Named Rules
**The Tonal-First Rule.** Depth is the ink ladder first. Surfaces at rest are
flat; a shadow is reserved for a layer the user can dismiss (menu, modal, toast).

**The No-Stack Rule.** Never combine a shadow with a heavy border, and never
place two floating shadows in the same stack. One float, one shadow, one hairline.

## Shapes

The form language is the rounded workbench rectangle, on a documented scale of
**3 / 4 / 5 / 6 / 7 / 8 / 10px** plus a full **999px** pill. The master radius
is **10px** for dialogs and large containers; **7px** is the working radius for
buttons, inputs, and message bubbles; **8px** covers tabs and icon buttons;
**6px** small rows and menu items; and 3–5px are reserved for tight decorative
insets (the splitter highlight, outline-kind badges). Pills (status, quick
prompts, lint badge) use 999px. Radii stay under 11px so the interface reads as
precise rather than friendly.

Borders are always 1px and always the Rule Line or Hairline Rule token; the
only dashed border in the system is the outline of an unwired ghost button
("Make agents aware" before setup), which becomes solid green once wired.
Selection and focus are expressed as a **border-color shift to Cobalt Signal**,
never as an outer glow or ring. The one glow in the system is reserved for the
graph: a selected node casts a cobalt `drop-shadow`, and the agent orb carries a
soft cobalt halo to signal activity.

The brand mark is three filled-free circles joined by edges — a miniature graph
that states the product before any label does.

## Components

Character line for the whole set: **instrument-like and restrained** — quiet
until touched, and then only the border or the ink changes.

### Buttons
- **Shape:** 7px radius (`{rounded.sm}`); primary and modal confirms use 7px, canvas icon buttons use 8px.
- **Primary:** Cobalt Signal Deep background (`{colors.cobalt-signal-deep}`) with white text, `6px 16px` padding, 500 weight. The only filled button in the product, and it appears once per surface (Send, Confirm).
- **Hover / Focus:** Primary lifts to Cobalt Signal (`{colors.cobalt-signal}`). Ghost and icon buttons gain a Hover Ink background and Graphite Ink text; focus is a border-color shift to the accent with the native outline removed. No transform, no scale.
- **Disabled:** Primary drops to 50% opacity; icon buttons to 50% opacity with hover suppressed.
- **Danger:** An icon button in Signal Red that gains a red wash (`rgba(248,81,73,0.14)`) on hover, never a red fill.

### Chips
- **Style:** Pills (`{components.status-pill}`) — Well Ink background, Rule Line border, Dim Annotation text, 999px radius. The OpenCode connection pill adds a 7px dot: green with a soft green halo when online, red when offline.
- **State:** Quick-prompt chips and the lint badge share the same shell; hover shifts the border and text to Cobalt Signal. The lint badge turns green on pass and takes a red-tinted border on failure.

### Cards / Containers
- **Corner Style:** 7px for bubbles and template tiles, 10px for modals.
- **Background:** Panels are Panel Ink; raised chrome is Raised Ink; the empty-state card sits on Void Ink with no fill of its own.
- **Shadow Strategy:** None at rest — see Elevation & Depth. Only modals and toasts float.
- **Border:** 1px Rule Line on raised elements; 1px Hairline Rule for internal dividers (menu rows, message separators).
- **Internal Padding:** 10–12px in panels and chat bubbles, 18px in modals.

### Inputs / Fields
- **Style:** Well Ink background, 1px Rule Line border, 7px radius, 12.5–13px type. Textareas and the composer use the sans face; the workspace directory input and modal path fields use mono because they hold paths.
- **Focus:** Border shifts to Cobalt Signal; the browser outline is suppressed. No ring, no glow, no background change.
- **Error / Disabled:** Errors surface as text or as an amber/red notice strip rather than as a field border, because most failures here are connection-level, not field-level.

### Navigation
Three navigation registers, all quiet: **top-bar tabs** for open diagrams
(8px radius, Hover Ink on hover, Active Ink plus a Rule Line border and a cobalt
dirty-dot when current); **sidebar tabs** (Files / Outline / Gaps) as an
equal-width segmented row where only the active tab gains an Active Ink fill;
and the **file tree**, where rows are transparent until hover and the active row
takes an Active Ink fill while graph files show a cobalt file icon. Navigation
never underlines or bolds on hover — it only changes ink and fill.

### Signature Components
- **Graph stage:** A dot-grid canvas (`radial-gradient` at 22px) on Void Ink.
  Pan/zoom drive the SVG `viewBox`, so magnification stays vector-crisp. Selected
  nodes get a cobalt stroke and drop-shadow; nodes whose `click` links to another
  diagram are painted like hyperlinks — cobalt fill, underlined — because the
  graph itself must look navigable.
- **Agent orb:** A 22px circle with a radial cobalt→violet gradient and a soft
  cobalt halo. It pulses (halo widens) while the agent is busy, and is the panel's
  single piece of ambient motion.
- **Gap ledger:** The `*.gaps.md` view rendered as a narrow reading column of
  uppercase section headings over dim body text and inline mono code — the
  notebook margin where unresolved questions live.
- **Chat message:** Role label in uppercase Label type above a bubble. User
  turns take Active Ink with a Rule Line border; assistant turns take Raised Ink
  with a Hairline Rule; tool calls are a dashed, mono, transparent strip; errors
  take a red wash. Attached files fold under a mono `▸` disclosure.

## Do's and Don'ts

### Do:
- **Do** express depth with the ink ladder (Code/Well → Void → Panel → Raised)
  before reaching for the shadow token.
- **Do** reserve Cobalt Signal for exactly one current thing per region —
  focus, selection, active tab, live connection.
- **Do** set anything literal (paths, filenames, node ids, source, status
  readouts) in the mono face, and interface chrome in sans.
- **Do** use the documented radius scale (3/4/5/6/7/8/10px, pills 999px) —
  master 10px, controls 7px.
- **Do** use 1px Rule Line / Hairline Rule borders and change only border-color
  on focus, never a glow or outer ring.
- **Do** keep text at or below 18px and carry hierarchy with position, uppercase
  11px labels, and ink weight.
- **Do** keep both themes fully realized; the light theme remaps surfaces to
  Paper Mist / Paper White and swaps the accent to `#3366d9` for contrast.

### Don't:
- **Don't** use Cobalt Signal as a background wash, gradient, or decoration —
  it is a state color, not a brand fill.
- **Don't** add shadows to panels or cards at rest; only menus, modals, and
  toasts may float.
- **Don't** stack two borders or a border plus a heavy shadow on one edge.
- **Don't** pure-white the primary text on dark; Graphite Ink (`#e6edf3`) keeps
  the ink ladder readable.
- **Don't** introduce display/editorial typefaces or sizes above 18px; this is
  an Operate surface, not a marketing page.
- **Don't** add glass, gradients, glassmorphism, or an accent glow outside the
  graph stage and agent orb.
- **Don't** animate panels on hover or add transitions to splitter drags — the
  splitter must track the pointer with easing off.

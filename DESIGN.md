> September 5, 0.5 update: the canvas is removed; one TUI fills the workspace with the rich prompt docked below it in normal flow (model/effort panel floats above, never covering the screen). The sidebar groups recent sessions under each repository with a per-repo new-chat button. Keep functional copy ("New terminal", "No sessions in this repository").
>
> September 5, 0.4 update: canvas nodes host real Muse TUIs only; the separate chat view was removed. Keep functional copy ("New terminal", "No sessions in this repository"). Each terminal has a rich prompt (multiline, images, model/effort) that sends via bracketed paste. See PRODUCT.md and docs/REGRESSIONS.md.

---
name: Agent Hub
description: Persistent conversations in a compact repository workspace.
colors:
  dark-canvas: "#17191c"
  dark-sidebar: "#1b1d21"
  dark-surface: "#22252a"
  dark-node-chrome: "#26292e"
  dark-composer-focus: "#292d32"
  dark-text: "#e9ecef"
  dark-secondary: "#c0c5cd"
  dark-muted: "#9ba3ae"
  dark-border: "#363a41"
  dark-button: "#2b2f35"
  dark-hover: "#353a42"
  dark-selected: "#2d3438"
  dark-accent: "#a3cbb1"
  dark-accent-hover: "#b7dcc4"
  dark-accent-ink: "#16271c"
  dark-accent-soft: "#293a31"
  dark-selection: "#415c4b"
  dark-user-message: "#2b2f35"
  dark-code: "#191c20"
  dark-warning: "#e6c391"
  dark-warning-bg: "#393329"
  dark-error: "#f1b2ad"
  dark-error-bg: "#422d2e"
  light-canvas: "#f1f2ef"
  light-sidebar: "#f8f9f6"
  light-surface: "#fff"
  light-node-chrome: "#fafbf8"
  light-composer-focus: "#f3f6f1"
  light-text: "#252d29"
  light-secondary: "#46524a"
  light-muted: "#647168"
  light-border: "#d8dfd6"
  light-button: "#e9eee6"
  light-hover: "#dce5d8"
  light-selected: "#e2ebdd"
  light-accent: "#386748"
  light-accent-hover: "#2b583b"
  light-accent-ink: "#fff"
  light-accent-soft: "#e4eee0"
  light-selection: "#bdd5b5"
  light-user-message: "#edf2e9"
  light-code: "#eef2eb"
  light-warning: "#73511e"
  light-warning-bg: "#f6eddb"
  light-error: "#942e28"
  light-error-bg: "#fbe9e7"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.7
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 550
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11px"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
rounded:
  control: "6px"
  row: "7px"
  action: "8px"
  popup: "9px"
  panel: "12px"
spacing:
  compact: "6px"
  small: "8px"
  medium: "12px"
  large: "16px"
  spacious: "20px"
components:
  button-primary:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-ink}"
    rounded: "{rounded.row}"
    padding: "11px 16px"
  button-primary-light:
    backgroundColor: "{colors.light-accent}"
    textColor: "{colors.light-accent-ink}"
    rounded: "{rounded.row}"
    padding: "11px 16px"
  button-secondary:
    backgroundColor: "{colors.dark-button}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  conversation:
    backgroundColor: "{colors.dark-surface}"
    rounded: "{rounded.panel}"
  field:
    backgroundColor: "{colors.dark-surface}"
    rounded: "{rounded.control}"
    padding: "7px 9px"
---
# Design System: Agent Hub

## Overview

**Creative North Star: "Graphite workspace"**

Agent Hub uses graphite surfaces, muted sage emphasis, solid conversation chrome, system typography, and precise spacing. Its familiar desktop navigation supports long reading and multiple concurrent conversations. Light mode preserves the same hierarchy through warm pale surfaces and darker green emphasis.

The implemented direction comes from the user-approved Codex-style desktop layout in `PRODUCT.md` and the direction contract in `index.html`. It takes precedence over concept seed `e765f0a4`; no approved visual comp was supplied. This document records the finished code rather than proposing another visual world.

**Key Characteristics:**

- Compact repository and recent-session navigation.
- Resizable conversation panels with a quieter overview at low zoom.
- Shared composer and conversation styling across canvas and focus views.

## Colors

### Primary

Muted sage identifies primary actions, active icons, links, focus, and resize handles in dark mode. Forest green carries the same roles in light mode. Use the matching accent-ink token for text on accent fills.

### Neutral

Canvas, sidebar, conversation surface, and node chrome establish depth through closely related tones. Text, secondary, and muted form a three-level hierarchy. Borders separate structural regions; selected and hover fills identify interaction state. Code and user-message surfaces distinguish transcript content without adding competing accents.

Warning and error pairs communicate attention and failure locally. Their text and background tokens travel together. CSS variables in `src/tokens.css` remain the implementation source; frontmatter records each theme explicitly, while snippets bind the live semantic variables.

**The Semantic Theme Rule.** Apply the same semantic role in both themes; never substitute a literal dark surface in a component.

## Typography

System sans-serif keeps the interface familiar on macOS, with Segoe UI and sans-serif fallbacks. The body token records transcript typography; controls have tighter inherited metrics. Monospace is confined to code and preformatted output.

The hierarchy is compact: conversation titles sit close to body size, navigation labels are smaller, and repository headings provide a modest step up (16px, weight 600). Focus-view messages enlarge to 14px with a 75ch maximum line length. Auxiliary metadata is subordinate to titles and messages. The small boot and empty-state headings are incidental states, not a reusable display type system.

## Layout

The shell has a title bar (53px), left navigation rail (248px), and a flexible workspace. Native desktop title chrome reserves space for macOS window controls. The workspace toolbar is 64px high; transcripts scroll within their own panels while composers remain anchored below them.

Conversation nodes resize between 420–1800px wide and 400–1800px high in canvas coordinates. The canvas supports 5–200% zoom, a 24px dot grid, fit/reset controls, and an optional minimap that starts hidden. Below 50% zoom, readable overview nodes replace full transcript rendering. Focus view centers the shared conversation component with a maximum width of 920px.

Source breakpoints at 1100px and 760px narrow the rail to 220px and 185px, reduce padding, and hide secondary context. The sidebar can also be manually hidden. These are implemented rules, not evidence of verified layouts at those exact sizes. The retained dark canvas and light focus screenshots were captured at a 1272×1093 viewport; the `focus-light-900.png` filename is historical. Exact smaller post-fix capture was blocked by the CUA scale issue.

## Elevation & Depth

Tonal layering supplies most separation. Conversations use a soft node shadow; settings, skill suggestions, and toast surfaces use stronger popup shadows. Theme-dependent shadow colors keep light mode restrained. Thin borders and solid headers maintain panel boundaries during canvas movement.

**The Solid Chrome Rule.** Headers and composer surfaces stay opaque so overlapping conversations retain a readable silhouette.

## Shapes

Controls use small rounded corners, navigation rows slightly softer corners, and conversation or settings panels the largest recurring radius. Attachment previews are clipped inside their own small corners. Borders remain thin; selected nodes and keyboard focus use accent outlines. Status indicators are small circles, paired with textual state where shown.

## Components

### Buttons

Primary actions use accent fill and accent ink, with the paired accent-hover state. Secondary actions use button surfaces; icon actions start transparent and gain a hover fill. All buttons expose a visible keyboard focus ring. Disabled controls lose emphasis. Send becomes a neutral stop control during a running response.

### Inputs and composer

Ordinary fields use a bordered surface and compact padding. The rich composer has a solid chrome background that shifts to composer-focus when any child receives focus. Its editable area grows within a bounded scroll region. Attachment, model, and send controls occupy one lower row. Enter submits; Shift+Enter inserts a line break. Slash suggestions open above the composer, support arrow keys and selection, and consume Escape so dismissing suggestions does not also close focus view.

### Navigation

Repository and recent-session rows use icon, title, and subordinate context. Active rows gain the selected surface and stronger text; repository icons also take the accent. Long titles truncate. New session remains at the top of the rail. Theme choices expose selected state through outline, fill, and `aria-pressed`.

### Conversation panels

A solid header carries status, editable title, repository, and actions. Transcript content remains independently scrollable, with indented user surfaces and plain agent content. Tool activity collapses into compact disclosure rows. Errors and requests for input remain local to the affected conversation.

### Attachment chips and popups

Attachment chips combine a thumbnail or file icon with a truncating filename and remove control. Skill suggestions use surface fill, popup elevation, and a selected row. Settings use the same surface and panel corners. The minimap can be toggled from canvas controls without covering content by default.

## Do's and Don'ts

### Do:

- Do use semantic CSS variables so every surface follows Dark, Light, or System appearance.
- Do preserve solid conversation headers and clear selected-node outlines.
- Do reserve readable transcript space and keep composer controls grouped beneath the input.
- Do keep keyboard focus visible and respect reduced-motion preferences.

### Don't:

- Don’t hardcode dark colors into new components.
- Don’t replace the compact operating layout with marketing typography or decorative imagery.
- Don’t reduce a full transcript indefinitely with canvas zoom; use the existing overview representation below 50%.
- Don’t describe source breakpoints as visually verified at exact window sizes without a rendered check.

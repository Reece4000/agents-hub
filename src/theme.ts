// Shared theming: two custom colours (background + accent) theme Agent Hub
// chrome and the hosted Muse TUI together. Pure functions only, so the
// Electron main process, the renderer, and node tests share this module.

export type ThemeMode = 'dark' | 'light'

export const DEFAULT_CANVAS: Record<ThemeMode, string> = { dark: '#17191c', light: '#f1f2ef' }
export const DEFAULT_TERMINAL_BG = '#1c1e22'
export const DEFAULT_TERMINAL_FG = '#dedfe3'
export const DEFAULT_ACCENT: Record<ThemeMode, string> = { dark: '#a3cbb1', light: '#386748' }

/** CSS variables a custom background/accent may override. Anything absent
 *  here falls back to the per-mode values in tokens.css. A custom background
 *  re-themes the whole app surface ramp, not just the terminal grounds. */
export const MANAGED_THEME_KEYS = [
  '--canvas',
  '--chrome',
  '--sidebar',
  '--surface',
  '--node-chrome',
  '--composer-focus',
  '--code',
  '--button',
  '--user-message',
  '--selected',
  '--hover',
  '--border',
  '--grid',
  '--scrollbar',
  '--text',
  '--secondary',
  '--muted',
  '--warning',
  '--warning-bg',
  '--error',
  '--error-bg',
  '--terminal-bg',
  '--terminal-fg',
  '--terminal-muted',
  '--terminal-footer',
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--accent-ink',
  '--selection',
] as const

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Accept `#rgb`/`#rrggbb` (any case, surrounding whitespace ok) and return
 *  lowercase `#rrggbb`. Anything else — including empty, null and garbage —
 *  returns undefined, which callers treat as "unset". */
export function normalizeThemeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().toLowerCase()
  if (!HEX_RE.test(raw)) return undefined
  if (raw.length === 4) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
  return raw
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeThemeColor(hex) ?? '#000000'
  return [parseInt(normalized.slice(1, 3), 16), parseInt(normalized.slice(3, 5), 16), parseInt(normalized.slice(5, 7), 16)]
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

export function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map(component => clampByte(component).toString(16).padStart(2, '0')).join('')}`
}

/** Mix two colours. `weightA` (0..1) is how much of `a` to keep. */
export function mixHex(a: string, b: string, weightA: number): string {
  const weight = Math.max(0, Math.min(1, weightA))
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return rgbToHex(ar * weight + br * (1 - weight), ag * weight + bg * (1 - weight), ab * weight + bb * (1 - weight))
}

const linearize = (channel: number) => {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminanceHex(hex: string): number {
  const [red, green, blue] = hexToRgb(hex)
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
}

/** Readable text on a coloured fill: near-black on light fills, white on dark ones. */
export function inkForAccent(accent: string): string {
  return luminanceHex(accent) > 0.45 ? '#1a1d1c' : '#ffffff'
}

/** Readable terminal text on a background: dark ink on light grounds, pale on dark. */
export function terminalForegroundFor(background: string): string {
  return luminanceHex(background) > 0.45 ? '#252d29' : DEFAULT_TERMINAL_FG
}

export interface CustomTheme {
  background?: string
  accent?: string
  mode: ThemeMode
}

/** CSS variable overrides for the custom colours. Empty object means "no
 *  custom theme": the caller must remove the managed keys so tokens.css
 *  defaults apply again. */
export function customThemeVars({ background, accent, mode }: CustomTheme): Record<string, string> {
  const vars: Record<string, string> = {}
  const customBackground = normalizeThemeColor(background)
  const customAccent = normalizeThemeColor(accent)
  const canvas = customBackground ?? DEFAULT_CANVAS[mode]
  if (customBackground) {
    const lightGround = luminanceHex(customBackground) > 0.45
    // Text and semantics follow the grounds, not the mode toggle, so any
    // pick stays readable: pale grounds get the light-theme ramp, dark
    // grounds the dark-theme ramp.
    const ink = lightGround ? '#252d29' : '#e9ecef'
    // weight is how far the surface lifts off the background toward ink.
    const surface = (weight: number) => mixHex(ink, customBackground, weight)
    vars['--canvas'] = customBackground
    vars['--chrome'] = customBackground
    vars['--sidebar'] = surface(0.02)
    vars['--surface'] = surface(0.05)
    vars['--node-chrome'] = surface(0.07)
    vars['--composer-focus'] = surface(0.08)
    vars['--code'] = surface(0.01)
    vars['--button'] = surface(0.09)
    vars['--user-message'] = surface(0.09)
    vars['--hover'] = surface(0.13)
    vars['--border'] = surface(0.14)
    vars['--grid'] = surface(0.18)
    vars['--scrollbar'] = surface(0.30)
    vars['--text'] = ink
    vars['--secondary'] = lightGround ? '#46524a' : '#c0c5cd'
    vars['--muted'] = lightGround ? '#647168' : '#9ba3ae'
    vars['--warning'] = lightGround ? '#73511e' : '#e6c391'
    vars['--warning-bg'] = lightGround ? '#f6eddb' : '#393329'
    vars['--error'] = lightGround ? '#942e28' : '#f1b2ad'
    vars['--error-bg'] = lightGround ? '#fbe9e7' : '#422d2e'
    // Without a custom accent, selection follows the grounds instead of the
    // stock green. The accent block below overrides both when one is set.
    vars['--selected'] = customAccent ? mixHex(customAccent, customBackground, 0.38) : surface(0.10)
    vars['--selection'] = customAccent ? mixHex(customAccent, customBackground, 0.38) : mixHex(ink, customBackground, 0.22)
    const foreground = terminalForegroundFor(customBackground)
    vars['--terminal-bg'] = customBackground
    vars['--terminal-fg'] = foreground
    vars['--terminal-muted'] = mixHex(foreground, customBackground, 0.65)
    vars['--terminal-footer'] = lightGround ? mixHex(customBackground, '#000000', 0.94) : mixHex(customBackground, '#ffffff', 0.96)
  }
  if (customAccent) {
    vars['--accent'] = customAccent
    vars['--accent-hover'] = mode === 'dark' ? mixHex(customAccent, '#ffffff', 0.88) : mixHex(customAccent, '#000000', 0.88)
    vars['--accent-soft'] = mixHex(customAccent, canvas, 0.16)
    vars['--accent-ink'] = inkForAccent(customAccent)
    vars['--selection'] = mixHex(customAccent, canvas, 0.38)
  }
  return vars
}

export interface ThemeVarTarget {
  setProperty(key: string, value: string): void
  removeProperty(key: string): void
}

/** Apply overrides onto an element style (the renderer passes
 *  `document.documentElement.style`). Keys without an override are removed
 *  so the stylesheet defaults return. */
export function applyThemeVars(style: ThemeVarTarget, vars: Record<string, string>): void {
  for (const key of MANAGED_THEME_KEYS) {
    const value = vars[key]
    if (value) style.setProperty(key, value)
    else style.removeProperty(key)
  }
}

export interface TuiTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
}

/** xterm.js theme for the hosted TUI. The Muse TUI draws its own syntax
 *  colours over these grounds, so the theme sets background, readable
 *  foreground, and accent-driven cursor/selection — never the ANSI palette. */
export function buildXtermTheme({ background, accent }: CustomTheme): TuiTheme {
  const resolvedBackground = normalizeThemeColor(background) ?? DEFAULT_TERMINAL_BG
  // The TUI grounds stay dark in both UI modes by default, so the fallback
  // accent follows the terminal background (readable cursor/selection), not
  // the UI mode. An explicit custom accent is always honoured as picked.
  const fallbackAccent = terminalForegroundFor(resolvedBackground) === '#252d29' ? DEFAULT_ACCENT.light : DEFAULT_ACCENT.dark
  const resolvedAccent = normalizeThemeColor(accent) ?? fallbackAccent
  const foreground = terminalForegroundFor(resolvedBackground)
  return {
    background: resolvedBackground,
    foreground,
    cursor: resolvedAccent,
    cursorAccent: resolvedBackground,
    selectionBackground: mixHex(resolvedAccent, resolvedBackground, 0.38),
    selectionForeground: foreground,
  }
}

/** Custom colours forwarded into every spawned PTY environment, so the TUI
 *  process itself (and any future Muse theme support) sees the same theme. */
export function themeEnvironment(background?: string, accent?: string): Record<string, string> {
  const env: Record<string, string> = {}
  const customBackground = normalizeThemeColor(background)
  const customAccent = normalizeThemeColor(accent)
  if (customBackground) env.AGENT_HUB_THEME_BACKGROUND = customBackground
  if (customAccent) env.AGENT_HUB_THEME_ACCENT = customAccent
  return env
}

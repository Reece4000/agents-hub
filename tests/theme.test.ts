import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeThemeColor, mixHex, luminanceHex, customThemeVars, applyThemeVars,
  buildXtermTheme, themeEnvironment, MANAGED_THEME_KEYS,
} from '../src/theme'
import { MuseService } from '../server/service'
import type { MspClient } from '../server/msp'

test('theme colours normalize to lowercase six-digit hex', () => {
  assert.equal(normalizeThemeColor('#ABC'), '#aabbcc')
  assert.equal(normalizeThemeColor('#AABBCC'), '#aabbcc')
  assert.equal(normalizeThemeColor('  #123456  '), '#123456')
  for (const invalid of ['red', '#12', '#12345', '#gggggg', '', '  ', null, undefined, 123, true]) {
    assert.equal(normalizeThemeColor(invalid), undefined, `${String(invalid)} must be rejected`)
  }
})

test('colour mixing and luminance behave', () => {
  assert.equal(mixHex('#ffffff', '#000000', 0.5), '#808080')
  assert.equal(mixHex('#ff0000', '#000000', 1), '#ff0000')
  assert.equal(mixHex('#ff0000', '#000000', 0), '#000000')
  assert.equal(luminanceHex('#ffffff'), 1)
  assert.equal(luminanceHex('#000000'), 0)
  assert.ok(luminanceHex('#f5f5f0') > 0.45, 'pale grounds read as light')
  assert.ok(luminanceHex('#1c1e22') < 0.45, 'terminal grounds read as dark')
})

test('custom theme vars stay empty without custom colours', () => {
  assert.deepEqual(customThemeVars({ mode: 'dark' }), {})
  assert.deepEqual(customThemeVars({ mode: 'light' }), {})
})

test('a custom background re-themes the whole app surface ramp', () => {
  const dark = customThemeVars({ background: '#20242a', mode: 'dark' })
  assert.equal(dark['--canvas'], '#20242a')
  assert.equal(dark['--terminal-bg'], '#20242a')
  assert.equal(dark['--terminal-fg'], '#dedfe3')
  assert.ok(dark['--terminal-muted'] && dark['--terminal-footer'], 'derived terminal tones exist')
  for (const key of ['--chrome', '--sidebar', '--surface', '--node-chrome', '--button', '--hover', '--border', '--text', '--secondary', '--muted']) {
    assert.match(dark[key] ?? '', /^#[0-9a-f]{6}$/, `${key} must follow the background`)
  }
  assert.equal(dark['--text'], '#e9ecef', 'dark grounds keep pale text')
  for (const key of ['--sidebar', '--surface', '--button', '--border']) {
    const gap = Math.abs(luminanceHex(dark[key] ?? '#000000') - luminanceHex('#20242a'))
    assert.ok(gap < 0.05, `${key} must stay near the background, not wash out (gap ${gap.toFixed(3)})`)
  }
  assert.equal(dark['--accent'], undefined, 'background alone must not invent an accent')
  const light = customThemeVars({ background: '#F5F5F0', mode: 'dark' })
  assert.equal(light['--canvas'], '#f5f5f0')
  assert.equal(light['--terminal-fg'], '#252d29', 'pale grounds get dark text')
  assert.equal(light['--text'], '#252d29', 'pale grounds flip the app text ramp too')
  assert.equal(light['--sidebar'], mixHex('#252d29', '#f5f5f0', 0.02), 'sidebar derives from the background, not stock graphite')
  assert.notEqual(light['--sidebar'], '#f8f9f6', 'stock light sidebar must be gone')
  assert.equal(light['--warning'], '#73511e', 'semantics follow the grounds')
})

test('a custom accent derives the shared accent family without touching grounds', () => {
  const vars = customThemeVars({ accent: '#7C5CFF', mode: 'dark' })
  assert.equal(vars['--accent'], '#7c5cff')
  for (const key of ['--accent-hover', '--accent-soft', '--accent-ink', '--selection']) {
    assert.match(vars[key] ?? '', /^#[0-9a-f]{6}$/, `${key} must be derived`)
  }
  assert.equal(vars['--accent-ink'], '#ffffff', 'dark accents get white ink')
  assert.equal(vars['--canvas'], undefined, 'accent alone must not move grounds')
  const pale = customThemeVars({ accent: '#F2C14E', mode: 'light' })
  assert.equal(pale['--accent-ink'], '#1a1d1c', 'light accents get dark ink')
})

test('applying vars sets overrides and removes cleared ones', () => {
  const applied = new Map<string, string>()
  const style = {
    setProperty: (key: string, value: string) => { applied.set(key, value) },
    removeProperty: (key: string) => { applied.delete(key as string) },
  }
  applyThemeVars(style, customThemeVars({ background: '#20242a', accent: '#7c5cff', mode: 'dark' }))
  assert.equal(applied.size, MANAGED_THEME_KEYS.length, 'both colours manage every key')
  applyThemeVars(style, customThemeVars({ mode: 'dark' }))
  assert.equal(applied.size, 0, 'clearing the theme must restore stylesheet defaults')
})

test('the TUI theme keeps dark defaults and honours custom colours', () => {
  const dark = buildXtermTheme({ mode: 'dark' })
  assert.equal(dark.background, '#1c1e22')
  assert.equal(dark.foreground, '#dedfe3')
  assert.equal(dark.cursor, '#a3cbb1')
  assert.equal(dark.cursorAccent, '#1c1e22')
  const light = buildXtermTheme({ mode: 'light' })
  assert.equal(light.background, '#1c1e22', 'the TUI stays dark unless customized')
  assert.equal(light.cursor, '#a3cbb1', 'dark grounds keep the readable sage accent')
  const custom = buildXtermTheme({ background: '#F5F5F0', accent: '#386748', mode: 'light' })
  assert.equal(custom.background, '#f5f5f0')
  assert.equal(custom.foreground, '#252d29')
  assert.equal(custom.cursor, '#386748', 'an explicit accent is always honoured')
})

test('themeEnvironment forwards only valid custom colours', () => {
  assert.deepEqual(themeEnvironment('#20242a', '#7C5CFF'), { AGENT_HUB_THEME_BACKGROUND: '#20242a', AGENT_HUB_THEME_ACCENT: '#7c5cff' })
  assert.deepEqual(themeEnvironment(undefined, undefined), {})
  assert.deepEqual(themeEnvironment('bogus', undefined), {})
})

test('preferences store, normalize, ignore and clear custom colours', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-theme-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    let broadcasts = 0
    service.on('workspace', () => { broadcasts++ })
    await service.invoke('preferences', { themeBackground: '#ABC', themeAccent: 'bogus' })
    assert.equal(service.store.state.themeBackground, '#aabbcc')
    assert.equal(service.store.state.themeAccent, undefined, 'invalid colours are ignored')
    assert.equal(broadcasts, 1, 'a colour change broadcasts the workspace')
    await service.invoke('preferences', { themeAccent: '#7C5CFF' })
    assert.equal(service.store.state.themeAccent, '#7c5cff')
    await service.invoke('preferences', { themeBackground: null, themeAccent: '' })
    assert.equal(service.store.state.themeBackground, undefined)
    assert.equal(service.store.state.themeAccent, undefined)
    const raw = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'))
    assert.equal(raw.themeBackground, undefined)
    assert.equal(raw.themeAccent, undefined)
    await service.invoke('preferences', { themeBackground: '#20242a' })
    const { Store } = await import('../server/store')
    assert.equal(new Store(dir).state.themeBackground, '#20242a', 'custom colours survive reopening')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('switching appearance presets clears a custom background but keeps the accent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-theme-preset-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    await service.invoke('preferences', { themeBackground: '#20242a', themeAccent: '#7c5cff' })
    await service.invoke('preferences', { theme: 'light' })
    assert.equal(service.store.state.theme, 'light')
    assert.equal(service.store.state.themeBackground, undefined, 'the preset defines the grounds')
    assert.equal(service.store.state.themeAccent, '#7c5cff', 'accents suit either preset')
    // Re-selecting the active preset is a no-op for the background.
    await service.invoke('preferences', { themeBackground: '#20242a' })
    await service.invoke('preferences', { theme: 'light' })
    assert.equal(service.store.state.themeBackground, '#20242a')
    // An explicit background in the same call wins over the preset clear.
    await service.invoke('preferences', { theme: 'dark', themeBackground: '#123456' })
    assert.equal(service.store.state.theme, 'dark')
    assert.equal(service.store.state.themeBackground, '#123456')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('custom theme colours reach the spawned PTY environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-theme-pty-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  const original = service.terminals.open.bind(service.terminals)
  let opened: unknown[] = []
  service.terminals.open = (async (...args: unknown[]) => { opened = args; return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof original
  try {
    await service.invoke('preferences', { themeBackground: '#20242a', themeAccent: '#7c5cff' })
    const session = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: {} })
    await service.invoke('terminalOpen', { id: session.id })
    const extraEnv = opened[7] as Record<string, string>
    assert.equal(extraEnv.AGENT_HUB_THEME_BACKGROUND, '#20242a')
    assert.equal(extraEnv.AGENT_HUB_THEME_ACCENT, '#7c5cff')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

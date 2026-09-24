import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// FitAddon.proposeDimensions() measures the xterm *parent* element height
// but only subtracts padding found on the xterm element itself. Visual
// padding therefore must stay on the outer .terminal-screen while xterm
// mounts in the padding-free inner .terminal-fit. Padding directly on
// .terminal-screen overflowed ~1 row (half-cut status line); padding on
// .xterm showed a mismatched black frame.
const root = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(root, '../src/style.css'), 'utf8').replace(/\s+/g, '')
const view = readFileSync(join(root, '../src/TerminalView.tsx'), 'utf8').replace(/\s+/g, '')

test('terminal fit wrapper is padding-free with padding on the outer screen', () => {
  assert.ok(
    css.includes('.terminal-screen,.single-view.terminal-screen{padding:10px8px2px;'),
    'visual padding stays on the outer .terminal-screen',
  )
  assert.ok(
    css.includes('.terminal-fit{flex:1;min-height:0;min-width:0;overflow:hidden}'),
    'inner .terminal-fit must fill the screen without padding',
  )
  assert.ok(
    css.includes('.terminal-fit.xterm{height:100%;padding:0}'),
    'xterm element itself must carry no padding',
  )
  assert.ok(
    css.includes('.terminal-fit.xterm.xterm-viewport{background-color:var(--terminal-bg,#1c1e22)}'),
    'xterm keeps its viewport pure black; it must follow the terminal ground',
  )
  assert.ok(
    view.includes('<divclassName="terminal-screen"><divref={container}className="terminal-fit"/>'),
    'xterm must mount in .terminal-fit so fit measures a padding-free parent',
  )
})

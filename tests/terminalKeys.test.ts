import test from 'node:test'
import assert from 'node:assert/strict'
import { macShortcutToInput } from '../src/terminalKeys'

const chr = (n: number) => String.fromCharCode(n)
const meta = { meta: true, alt: false, ctrl: false, shift: false }
const alt = { meta: false, alt: true, ctrl: false, shift: false }
const plain = { meta: false, alt: false, ctrl: false, shift: false }

test('Cmd+Backspace kills the line instead of deleting one char', () => {
  assert.equal(macShortcutToInput('Backspace', meta, true), chr(0x15))
  assert.equal(macShortcutToInput('Delete', meta, true), chr(0x0b))
  assert.equal(macShortcutToInput('ArrowLeft', meta, true), chr(0x01))
  assert.equal(macShortcutToInput('ArrowRight', meta, true), chr(0x05))
})

test('Option editing shortcuts map to word-wise control bytes', () => {
  assert.equal(macShortcutToInput('Backspace', alt, true), chr(0x17))
  assert.equal(macShortcutToInput('ArrowLeft', alt, true), chr(0x1b) + 'b')
  assert.equal(macShortcutToInput('ArrowRight', alt, true), chr(0x1b) + 'f')
})

test('everything else is left to xterm.js and the browser', () => {
  for (const key of ['c', 'v', 'x', 'a', 'z', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Delete']) {
    assert.equal(macShortcutToInput(key, { ...meta, shift: true }, true), null, `shifted ${key}`)
  }
  assert.equal(macShortcutToInput('Backspace', plain, true), null)
  assert.equal(macShortcutToInput('a', plain, true), null)
  assert.equal(macShortcutToInput('Backspace', { ...meta, ctrl: true }, true), null)
  assert.equal(macShortcutToInput('Backspace', { meta: true, alt: true, ctrl: false, shift: false }, true), null)
  assert.equal(macShortcutToInput('Dead', alt, true), null)
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(macShortcutToInput(key, meta, false), null, `non-mac ${key}`)
    assert.equal(macShortcutToInput(key, alt, false), null, `non-mac ${key}`)
  }
})

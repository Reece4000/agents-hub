export interface KeyModifiers { meta: boolean; alt: boolean; ctrl: boolean; shift: boolean }

// macOS text-editing shortcuts a terminal should honor, mapped to the control bytes
// prompt-style TUIs expect. xterm.js otherwise delivers e.g. a bare DEL for Cmd+Backspace.
// Returns the bytes to send, or null to leave the key to xterm.js and the browser
// (plain keys, Ctrl combinations, Cmd+C/V/X/A/Z and other app shortcuts are untouched).
const CTRL_U = String.fromCharCode(0x15) // kill line
const CTRL_K = String.fromCharCode(0x0b) // kill to end of line
const CTRL_A = String.fromCharCode(0x01) // beginning of line
const CTRL_E = String.fromCharCode(0x05) // end of line
const CTRL_W = String.fromCharCode(0x17) // kill word
const ESC = String.fromCharCode(0x1b)
export function macShortcutToInput(key: string, mod: KeyModifiers, mac: boolean): string | null {
  if (!mac || mod.ctrl || mod.shift) return null
  if (mod.meta && !mod.alt) {
    switch (key) {
      case 'Backspace': return CTRL_U
      case 'Delete': return CTRL_K
      case 'ArrowLeft': return CTRL_A
      case 'ArrowRight': return CTRL_E
      default: return null
    }
  }
  if (mod.alt && !mod.meta) {
    switch (key) {
      case 'Backspace': return CTRL_W
      case 'ArrowLeft': return ESC + 'b'
      case 'ArrowRight': return ESC + 'f'
      default: return null
    }
  }
  return null
}

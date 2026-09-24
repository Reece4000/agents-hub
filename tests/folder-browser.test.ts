import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Clicking a folder opens its context pane; expanding its contents is a
// separate act (chevron or double-click). reveal() used to expand the full
// ancestor chain including the selected folder itself, so no click could
// open a context without also opening its files.
const root = dirname(fileURLToPath(import.meta.url))
const browser = readFileSync(join(root, '../src/FolderBrowser.tsx'), 'utf8').replace(/\s+/g, '')

test('selecting a folder expands its ancestors but never the folder itself', () => {
  assert.ok(
    browser.includes('for(constprefixofchain.slice(0,-1))'),
    'reveal must expand ancestors only, never the selected folder',
  )
})

test('a single click selects while expansion stays on chevron and double-click', () => {
  assert.ok(
    browser.includes('onClick={()=>onSelect(path)}'),
    'row click opens the folder context pane',
  )
  assert.ok(
    browser.includes('onDoubleClick={()=>toggle(path)}'),
    'row double-click still toggles expansion',
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { centerOnNode } from '../src/viewport'

test('centering puts the node center at the container center', () => {
  const viewport = centerOnNode(1200, 800, { x: 100, y: 200 }, 560, 620, 1)
  assert.equal(viewport.zoom, 1)
  // Node center (380, 510) must map to container center (600, 400).
  assert.equal(100 + 560 / 2 + viewport.x, 600)
  assert.equal(200 + 620 / 2 + viewport.y, 400)
})

test('centering scales with zoom', () => {
  const viewport = centerOnNode(1000, 600, { x: 0, y: 0 }, 400, 200, 2)
  assert.equal((0 + 200) * 2 + viewport.x, 500)
  assert.equal((0 + 100) * 2 + viewport.y, 300)
})

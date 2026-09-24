import type { BoardNote, BoardPosition } from './board'

export const cardWidth = 246
export const cardHeight = 172

/** Give notes created outside the canvas a reachable position without moving placed notes. */
export function withMissingPositions(notes: BoardNote[], saved: Record<string, BoardPosition>): Record<string, BoardPosition> {
  const positions = { ...saved }
  const occupied = notes.flatMap(note => positions[note.id] ? [positions[note.id]] : [])
  const free = (candidate: BoardPosition) => occupied.every(position =>
    Math.abs(position.x - candidate.x) >= cardWidth + 24 || Math.abs(position.y - candidate.y) >= cardHeight + 24
  )
  for (const note of notes) {
    if (positions[note.id]) continue
    const related = [...(note.sourceTaskIds ?? []), ...note.links.map(link => link.to)]
    const anchor = related.map(id => positions[id]).find(Boolean)
    let candidate: BoardPosition | undefined
    for (let row = 0; row < 100 && !candidate; row++) {
      const offset = row === 0 ? 0 : Math.ceil(row / 2) * (cardHeight + 40) * (row % 2 ? 1 : -1)
      for (let col = 0; col < 20; col++) {
        const point = anchor
          ? { x: anchor.x + (col + 1) * (cardWidth + 40), y: anchor.y + offset }
          : { x: 100 + col * (cardWidth + 40), y: 100 + row * (cardHeight + 40) }
        if (free(point)) { candidate = point; break }
      }
    }
    if (!candidate) candidate = { x: 100 + occupied.length * (cardWidth + 40), y: 100 }
    positions[note.id] = candidate
    occupied.push(candidate)
  }
  return positions
}

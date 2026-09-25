/** Subsequence match score: higher for earlier, contiguous, word-start hits; -1 for no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim(), t = text.toLowerCase()
  if (!q) return 0
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 - direct - (/\w/.test(t[direct - 1] ?? '') ? 50 : 0)
  let score = 0, position = -1, streak = 0
  for (const char of q) {
    const next = t.indexOf(char, position + 1)
    if (next < 0) return -1
    streak = next === position + 1 ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(9, next - position - 1) + (next === 0 || /\W/.test(t[next - 1]) ? 8 : 0)
    position = next
  }
  return score
}

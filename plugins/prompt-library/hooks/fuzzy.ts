// Classic fuzzy subsequence matching: every query character must appear in
// order; consecutive runs and word starts score higher. Returns null on no match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (q === '') return 0
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at === -1) return null
    streak = at === ti && ti > 0 ? streak + 1 : 0
    const isWordStart = at === 0 || /[\s\-_/.]/.test(t[at - 1] ?? '')
    score += 1 + streak * 3 + (isWordStart ? 4 : 0) - Math.min(at - ti, 10) * 0.1
    ti = at + 1
  }
  return score
}

export function fuzzyFilter<T extends { text: string }>(query: string, items: T[]): T[] {
  if (query.trim() === '') return items
  return items
    .map(item => ({ item, score: fuzzyScore(query, item.text) }))
    .filter((r): r is { item: T; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map(r => r.item)
}

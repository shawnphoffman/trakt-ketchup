// Deterministic visuals derived from a title, used as the fallback whenever
// Trakt doesn't return artwork (so a missing image still looks intentional).

function hash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** A stable two-stop gradient for a given title. */
export function gradientFor(seed: string): string {
  const h = hash(seed || 'untitled')
  const h1 = h % 360
  const h2 = (h1 + 35 + ((h >> 9) % 50)) % 360
  return `linear-gradient(140deg, hsl(${h1} 62% 42%), hsl(${h2} 68% 24%))`
}

/** Up to two initials from a title, for the poster fallback. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

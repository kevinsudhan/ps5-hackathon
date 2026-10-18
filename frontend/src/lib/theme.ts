// Colours for code that cannot use CSS variables directly (three.js, translucent SVG fills).
// They are read from src/styles/tokens.css at runtime, so the token file stays the one place to
// change the theme; the fallbacks below are the same values, used before the stylesheet loads.

const FALLBACK: Record<string, string> = {
  '--indigo': '#2E365A', '--purple': '#6B597F', '--mauve': '#A2869C', '--coral': '#BD6C73',
  '--periwinkle': '#92A1C2', '--steel': '#3F5B8D', '--bg': '#1E2340', '--bg-deep': '#171B33',
  '--text': '#F1EEF6', '--text-2': '#92A1C2', '--danger': '#BD6C73', '--danger-text': '#E8A3A9',
  '--delayed': '#D9A86C', '--ok': '#7FB59A', '--other': '#92A1C2',
  '--engine-falkor': '#92A1C2', '--engine-pg': '#A2869C',
}

const cache = new Map<string, string>()
export function token(name: string): string {
  const hit = cache.get(name)
  if (hit) return hit
  let v = ''
  try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { /* no DOM */ }
  if (v) cache.set(name, v)
  return v || FALLBACK[name] || '#92A1C2'
}

/** "#BD6C73" -> "189, 108, 115", for rgba() with a chosen alpha. */
export function rgb(hex: string): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

/**
 * Finding blank canvas in a region that has already been fetched.
 *
 * The old approach sampled twelve positions at random and asked the server
 * whether each was pristine. That is twelve round trips to answer a question
 * badly: it cannot find the *largest* space, it cannot tolerate a single stray
 * tile, and on a canvas seeded with 34,000 scattered singles a stray tile is
 * exactly what it keeps finding.
 *
 * Instead: fetch one region and answer every question about it locally.
 */

/**
 * Summed-area table over "is this tile painted".
 *
 * sat is (w+1) x (h+1) with a zero row and column, which is what removes the
 * boundary special-cases from every query below. Built once in O(w*h), after
 * which the painted count of ANY rectangle is four array reads.
 */
export function buildSat(bytes, w, h) {
  const stride = w + 1
  const sat = new Uint32Array(stride * (h + 1))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const painted = bytes[y * w + x] !== 0 ? 1 : 0
      sat[(y + 1) * stride + (x + 1)] =
        painted
        + sat[y * stride + (x + 1)]
        + sat[(y + 1) * stride + x]
        - sat[y * stride + x]
    }
  }
  return sat
}

/** Painted tiles inside the rectangle at (x, y) of size (rw, rh). O(1). */
export function rectPainted(sat, w, x, y, rw, rh) {
  const stride = w + 1
  const x2 = x + rw
  const y2 = y + rh
  return (
    sat[y2 * stride + x2]
    - sat[y * stride + x2]
    - sat[y2 * stride + x]
    + sat[y * stride + x]
  )
}

/**
 * Every position where an rw x rh rectangle holds at most `maxPainted` tiles,
 * best first, spread out so the answers are genuinely different places rather
 * than the same spot nudged by one tile.
 *
 * Ties break toward the centre of the search window, which is where the caller
 * asked to look.
 */
export function findFit(sat, w, h, rw, rh, maxPainted, limit = 3) {
  if (rw > w || rh > h) return []
  const cx = w / 2
  const cy = h / 2
  const hits = []

  for (let y = 0; y + rh <= h; y++) {
    for (let x = 0; x + rw <= w; x++) {
      const painted = rectPainted(sat, w, x, y, rw, rh)
      if (painted > maxPainted) continue
      const dx = x + rw / 2 - cx
      const dy = y + rh / 2 - cy
      hits.push({ x, y, painted, dist2: dx * dx + dy * dy })
    }
  }

  hits.sort((a, b) => a.painted - b.painted || a.dist2 - b.dist2)

  // Overlapping answers are the same answer. Require candidates to be at least
  // half a rectangle apart on one axis before counting as distinct.
  const chosen = []
  for (const hit of hits) {
    if (chosen.length >= limit) break
    const clashes = chosen.some(
      (c) => Math.abs(c.x - hit.x) < rw / 2 && Math.abs(c.y - hit.y) < rh / 2,
    )
    if (!clashes) chosen.push(hit)
  }
  return chosen
}

/**
 * The largest square that fits with at most `maxPaintedFraction` of it painted.
 *
 * Binary search on the side length: emptiness is monotonic in size here (any
 * square that fails at size s also fails at every larger size containing it),
 * so log(size) scans answer it rather than one scan per candidate size.
 */
export function findLargestSquare(sat, w, h, maxPaintedFraction = 0) {
  let lo = 1
  let hi = Math.min(w, h)
  let best = null

  while (lo <= hi) {
    const size = (lo + hi) >> 1
    const allowed = Math.floor(size * size * maxPaintedFraction)
    const found = findFit(sat, w, h, size, size, allowed, 1)[0]
    if (found) {
      best = { ...found, w: size, h: size }
      lo = size + 1
    } else {
      hi = size - 1
    }
  }
  return best
}

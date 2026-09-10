#!/usr/bin/env node
/**
 * Checks the summed-area arithmetic against brute force.
 *
 * A summed-area table is four array reads and two chances to be off by one, and
 * a wrong answer here is silent: it would just quietly recommend places that are
 * not actually empty, and the only symptom would be paid tiles landing on top of
 * other people's art.
 */
import { buildSat, rectPainted, findFit, findLargestSquare } from './space.mjs'

let checks = 0
let failures = 0

function check(label, actual, expected) {
  checks++
  if (actual !== expected) {
    failures++
    console.error(`  FAIL ${label}: got ${actual}, expected ${expected}`)
  }
}

// Deterministic, so a failure is reproducible.
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

// ---- rectPainted matches brute force over random grids and rectangles ----
for (let trial = 0; trial < 40; trial++) {
  const w = 1 + Math.floor(rnd() * 40)
  const h = 1 + Math.floor(rnd() * 40)
  const bytes = new Uint8Array(w * h)
  for (let i = 0; i < bytes.length; i++) bytes[i] = rnd() < 0.3 ? 1 + Math.floor(rnd() * 32) : 0
  const sat = buildSat(bytes, w, h)

  for (let q = 0; q < 60; q++) {
    const rw = 1 + Math.floor(rnd() * w)
    const rh = 1 + Math.floor(rnd() * h)
    const x = Math.floor(rnd() * (w - rw + 1))
    const y = Math.floor(rnd() * (h - rh + 1))

    let brute = 0
    for (let dy = 0; dy < rh; dy++) {
      for (let dx = 0; dx < rw; dx++) if (bytes[(y + dy) * w + (x + dx)] !== 0) brute++
    }
    check(`rect ${x},${y} ${rw}x${rh} in ${w}x${h}`, rectPainted(sat, w, x, y, rw, rh), brute)
  }
}

// ---- whole-grid and single-tile edges, where off-by-one shows up ----
{
  const w = 5, h = 4
  const bytes = new Uint8Array(w * h)
  bytes[0] = 7                    // top-left
  bytes[w - 1] = 7                // top-right
  bytes[(h - 1) * w] = 7          // bottom-left
  bytes[h * w - 1] = 7            // bottom-right
  bytes[2 * w + 2] = 7            // middle
  const sat = buildSat(bytes, w, h)

  check('whole grid', rectPainted(sat, w, 0, 0, w, h), 5)
  check('top-left 1x1', rectPainted(sat, w, 0, 0, 1, 1), 1)
  check('bottom-right 1x1', rectPainted(sat, w, w - 1, h - 1, 1, 1), 1)
  check('middle 1x1', rectPainted(sat, w, 2, 2, 1, 1), 1)
  check('empty 1x1', rectPainted(sat, w, 1, 1, 1, 1), 0)
  check('left column', rectPainted(sat, w, 0, 0, 1, h), 2)
  check('bottom row', rectPainted(sat, w, 0, h - 1, w, 1), 2)
  check('interior 3x2 excluding corners', rectPainted(sat, w, 1, 1, 3, 2), 1)
}

// ---- findFit only returns positions that really are within tolerance ----
{
  const w = 60, h = 60
  const bytes = new Uint8Array(w * h)
  for (let i = 0; i < bytes.length; i++) bytes[i] = rnd() < 0.05 ? 9 : 0
  // Guarantee one pristine 10x10 at (20,20).
  for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) bytes[y * w + x] = 0
  const sat = buildSat(bytes, w, h)

  const strict = findFit(sat, w, h, 10, 10, 0, 5)
  check('found at least one pristine 10x10', strict.length > 0, true)
  for (const c of strict) {
    let brute = 0
    for (let dy = 0; dy < 10; dy++) {
      for (let dx = 0; dx < 10; dx++) if (bytes[(c.y + dy) * w + (c.x + dx)] !== 0) brute++
    }
    check(`candidate ${c.x},${c.y} truly empty`, brute, 0)
  }

  // Tolerance must admit strictly more places than zero-tolerance does.
  const loose = findFit(sat, w, h, 10, 10, 5, 20)
  check('tolerance finds at least as many', loose.length >= strict.length, true)

  // Candidates must not be near-duplicates of each other.
  for (let i = 0; i < strict.length; i++) {
    for (let j = i + 1; j < strict.length; j++) {
      const far = Math.abs(strict[i].x - strict[j].x) >= 5
        || Math.abs(strict[i].y - strict[j].y) >= 5
      check(`candidates ${i},${j} are distinct places`, far, true)
    }
  }
}

// ---- findLargestSquare finds the real maximum ----
{
  const w = 40, h = 40
  const bytes = new Uint8Array(w * h).fill(3)   // everything painted...
  for (let y = 5; y < 22; y++) for (let x = 8; x < 25; x++) bytes[y * w + x] = 0  // ...but a 17x17 hole
  const sat = buildSat(bytes, w, h)

  const best = findLargestSquare(sat, w, h, 0)
  check('largest empty square is 17', best.w, 17)
  check('largest square has no paint', best.painted, 0)
  check('largest square sits in the hole', best.x >= 8 && best.y >= 5, true)
}

// ---- a fully painted grid has no space, and does not crash ----
{
  const w = 12, h = 12
  const sat = buildSat(new Uint8Array(w * h).fill(1), w, h)
  check('no fit in a full grid', findFit(sat, w, h, 3, 3, 0, 3).length, 0)
  check('no largest square in a full grid', findLargestSquare(sat, w, h, 0), null)
  check('full grid counts every tile', rectPainted(sat, w, 0, 0, w, h), w * h)
}

// ---- requesting more than the window holds is refused, not clamped silently ----
{
  const w = 10, h = 10
  const sat = buildSat(new Uint8Array(w * h), w, h)
  check('oversized request returns nothing', findFit(sat, w, h, 20, 5, 0, 3).length, 0)
  check('exact-fit request works', findFit(sat, w, h, 10, 10, 0, 3).length, 1)
}

console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

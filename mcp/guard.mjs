/**
 * What stands between a 402 and a signature.
 *
 * The canvas server names the price, the recipient, the token and the validity
 * window, and until 2026-08-28 the client signed all four as given. A hostile
 * or intercepted server could therefore obtain a valid authorization for any
 * amount of any EIP-3009 token, to any address, good for years -- while the
 * tool reported "spent $0.005". Everything a quote can say is checked here
 * against what the client already knows, and the budget is reserved before the
 * first await so parallel calls cannot slip past it.
 *
 * Pure functions and one small class; no I/O, so the tests need no server.
 */

/** USDC on Base mainnet. The only token this client will ever authorize. */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/**
 * Hardcoded ceiling per tile, in atomic USDC ($0.01). The advertised price is
 * checked too, but /api/info comes from the same server as the quote, so a
 * ceiling the server cannot move has to exist as well.
 */
export const MAX_ATOMIC_PER_TILE = 10000

/** Longest validity window accepted. A paint settles in seconds, not years. */
export const MAX_TIMEOUT_SECONDS = 120

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const DIGITS = /^\d+$/
/** shared/username.ts SHAPE, plus the anon-xxxx the room substitutes. */
const USERNAME = /^(?:[a-z0-9_-]{3,20}|anon-[0-9a-f]{4})$/

/**
 * Returns null when `req` is exactly what a paint should cost, otherwise the
 * name of the first thing wrong with it. Reasons are constants, never text
 * from the quote, so nothing the server says reaches the model through here.
 */
export function checkRequirements(req, expected) {
  if (!req || typeof req !== 'object') return 'no_payment_requirements'
  if (req.scheme !== 'exact') return 'bad_scheme'
  if (req.network !== 'base' || req.network !== expected.network) return 'bad_network'
  if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== USDC_BASE.toLowerCase()
    || expected.asset.toLowerCase() !== USDC_BASE.toLowerCase()) return 'bad_asset'
  if (typeof req.payTo !== 'string' || !ADDRESS.test(req.payTo)) return 'bad_recipient'
  if (typeof req.maxAmountRequired !== 'string' || !DIGITS.test(req.maxAmountRequired)) {
    return 'amount_not_numeric'
  }
  const amount = BigInt(req.maxAmountRequired)
  if (!DIGITS.test(String(expected.atomic)) || amount > BigInt(expected.atomic)) return 'amount_above_price'
  if (amount > BigInt(MAX_ATOMIC_PER_TILE)) return 'amount_above_ceiling'
  if (req.maxTimeoutSeconds !== undefined) {
    if (typeof req.maxTimeoutSeconds !== 'number' || !Number.isFinite(req.maxTimeoutSeconds)) {
      return 'timeout_not_numeric'
    }
    if (req.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) return 'timeout_too_long'
    if (req.maxTimeoutSeconds < 1) return 'timeout_too_short'
  }
  const name = req.extra?.name ?? 'USD Coin'
  const version = req.extra?.version ?? '2'
  if (name !== 'USD Coin' || version !== '2') return 'bad_domain'
  return null
}

/**
 * The session's spend, reserved synchronously.
 *
 * reserve() runs to completion with no await, so however many tool calls the
 * MCP client dispatches at once, they take turns here and the cap holds.
 * A reservation is released only on a failure known not to have spent.
 */
export class Budget {
  constructor(capUsd) {
    const cap = typeof capUsd === 'number' ? capUsd : Number(capUsd)
    if (capUsd === '' || capUsd === undefined || capUsd === null
      || !Number.isFinite(cap) || cap < 0) {
      throw new Error(`MAX_SPEND_USD must be a non-negative number, got ${JSON.stringify(capUsd)}`)
    }
    this.capUsd = cap
    this.spentUsd = 0
    this.painted = 0
    this.attempted = 0
  }

  reserve(priceUsd) {
    if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) return false
    if (priceUsd > MAX_ATOMIC_PER_TILE / 1e6) return false
    // Compared in atomic units so 0.1 + 0.2 arithmetic cannot admit an extra tile.
    const spent = Math.round(this.spentUsd * 1e6)
    const price = Math.round(priceUsd * 1e6)
    const cap = Math.round(this.capUsd * 1e6)
    if (spent + price > cap) return false
    this.spentUsd = (spent + price) / 1e6
    this.attempted++
    return true
  }

  release(priceUsd) {
    this.spentUsd = Math.max(0, Math.round(this.spentUsd * 1e6) - Math.round(priceUsd * 1e6)) / 1e6
  }

  settle() {
    this.painted++
  }

  state() {
    return {
      spentUsd: this.spentUsd,
      remainingUsd: Math.max(0, Math.round((this.capUsd - this.spentUsd) * 1e6)) / 1e6,
      capUsd: this.capUsd,
      tilesPainted: this.painted,
    }
  }
}

/**
 * The extent a region response claims, accepted only when the body is exactly
 * that many bytes and neither side exceeds what was asked for.
 */
export function parseRegionHeader(header, byteLength, max) {
  if (typeof header !== 'string') return null
  const parts = header.split(',')
  if (parts.length !== 4) return null
  const w = Number(parts[2])
  const h = Number(parts[3])
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return null
  if (w > max || h > max || w * h !== byteLength) return null
  return { w, h }
}

/** A tile as the model may see it: known fields, checked shapes, nothing else. */
export function sanitizeTile(body) {
  if (!body || typeof body !== 'object') return null
  const { x, y, color } = body
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return null
  if (!Number.isInteger(color) || color < 0) return null
  const out = { x, y, color }
  if (typeof body.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.hex)) out.hex = body.hex
  if (typeof body.painted === 'boolean') out.painted = body.painted
  if ('paintedBy' in body) {
    out.paintedBy = typeof body.paintedBy === 'string' && USERNAME.test(body.paintedBy)
      ? body.paintedBy : null
  }
  if (Number.isInteger(body.paintedAt)) out.paintedAt = body.paintedAt
  if (Number.isInteger(body.version)) out.version = body.version
  return out
}

const KNOWN_REASONS = new Set([
  'plot_locked', 'landowners_only', 'rate_limited', 'paint_failed_after_settlement',
  'invalid_tile', 'ownership_unavailable', 'settlement_failed', 'settlement_unknown',
  'nonce_reused', 'insufficient_funds', 'facilitator_refused',
])

/** A paint failure as one of a fixed set of reasons. The body itself stays here. */
export function reasonFor(status, body) {
  const reason = body && typeof body === 'object' ? body.reason : undefined
  if (typeof reason === 'string' && KNOWN_REASONS.has(reason)) return reason
  if (status === 402) return 'payment_rejected'
  if (status === 423) return 'plot_locked'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'canvas_unavailable'
  return 'canvas_error'
}

export function explorerUrl(tx) {
  return typeof tx === 'string' && TX_HASH.test(tx) ? `https://basescan.org/tx/${tx}` : null
}

/**
 * Where the canvas is. Production over https by default; plain http is
 * allowed only to loopback when a key is loaded, because a key that signs
 * over an interceptable connection is a key that signs for the interceptor.
 */
export function resolveCanvasUrl(env) {
  const raw = (env.CANVAS_URL ?? 'https://21millionpixels.art').replace(/\/$/, '')
  if (env.AGENT_PRIVATE_KEY) {
    const u = new URL(raw)
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (u.protocol !== 'https:' && !loopback) {
      throw new Error(`CANVAS_URL must be https when AGENT_PRIVATE_KEY is set (got ${u.protocol}//${u.host})`)
    }
  }
  return raw
}

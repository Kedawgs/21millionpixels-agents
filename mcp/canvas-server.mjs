#!/usr/bin/env node
/**
 * MCP server for 21millionpixels.art.
 *
 * Lets a model look at the canvas for free and pay to paint on it. Reading is
 * unmetered; painting costs $0.005 in USDC (canvas_info is authoritative) and
 * is capped by a budget this process enforces.
 *
 * Configure in your MCP client:
 *
 *   {
 *     "command": "node",
 *     "args": ["<path to this repo>/mcp/canvas-server.mjs"],
 *     "env": {
 *       "AGENT_PRIVATE_KEY": "0x...",
 *       "MAX_SPEND_USD": "0.10"
 *     }
 *   }
 *
 * WHY THE SERVER HOLDS THE KEY
 * MCP has no concept of payment, so somebody must hold a wallet. Running over
 * stdio keeps the key on this machine, in this process, out of the model's
 * context entirely -- the model calls a tool and never sees a key, a signature
 * or a 402. The cost of that convenience is that the model can spend without
 * being asked, which is what MAX_SPEND_USD exists to bound. Fund the wallet
 * with what you are willing to lose and nothing more.
 *
 * WHAT THE KEY WILL AND WILL NOT SIGN
 * Only a transfer of USDC on Base, of at most the advertised price per tile
 * and never more than $0.01, to a well-formed address, valid for at most two
 * minutes -- see guard.mjs. A quote that says anything else is refused before
 * signing, whoever sent it. The canvas is reached over https unless it is
 * loopback, so nobody between here and there can send one.
 *
 * Set DRY_RUN=1 to make every paint an estimate. Nothing can spend.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { buildSat, findFit, findLargestSquare } from './space.mjs'
import {
  Budget, checkRequirements, explorerUrl, parseRegionHeader, reasonFor, resolveCanvasUrl,
  sanitizeTile, MAX_TIMEOUT_SECONDS,
} from './guard.mjs'

// Misconfiguration is fatal at startup, not discovered at signing time. A cap
// that failed to parse used to become NaN, and NaN is never "over budget".
let CANVAS_URL
let budget
try {
  CANVAS_URL = resolveCanvasUrl(process.env)
  budget = new Budget(process.env.MAX_SPEND_USD ?? '0.10')
} catch (e) {
  console.error(`21millionpixels MCP: ${e.message}`)
  process.exit(1)
}
const GLOBAL_DRY_RUN = process.env.DRY_RUN === '1'
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || null

let info = null

async function getInfo() {
  if (info) return info
  const res = await fetch(`${CANVAS_URL}/api/info`)
  if (!res.ok) throw new Error(`canvas info unavailable: HTTP ${res.status}`)
  const body = await res.json()
  // The price is what every budget decision is measured in, so it is checked
  // once here rather than trusted forever after.
  const p = body?.paint?.agentPricePerTile
  if (!p || typeof p.usd !== 'number' || !Number.isFinite(p.usd) || p.usd <= 0
    || typeof p.atomic !== 'string' || !/^\d+$/.test(p.atomic)
    || Math.round(p.usd * 1e6) !== Number(p.atomic)) {
    throw new Error('canvas info carries no usable price')
  }
  if (!Number.isInteger(body?.world?.width) || !Number.isInteger(body?.world?.height)
    || !Number.isInteger(body?.palette?.max)) {
    throw new Error('canvas info carries no usable dimensions')
  }
  info = body
  return info
}

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (reason, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, reason, ...extra }, null, 2) }],
  isError: true,
})

const budgetState = () => ({ ...budget.state(), dryRunMode: GLOBAL_DRY_RUN })

// --------------------------------------------------------------- payment

/**
 * Signs and sends one paid paint. Only reached after the budget has been
 * reserved and the already-that-colour check has passed.
 *
 * Returns { ok: true, ... } on a settled paint; otherwise { ok: false, reason,
 * spent } where `spent` says whether the reservation may be released:
 * false when the failure is known not to have moved money, true when it did
 * or when nobody can say.
 */
async function payAndPaint(x, y, color) {
  const i = await getInfo()
  const quoteRes = await fetch(`${CANVAS_URL}/api/agent/paint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, color }),
  })
  if (quoteRes.status !== 402) {
    const body = await quoteRes.json().catch(() => ({}))
    return { ok: false, reason: reasonFor(quoteRes.status, body), spent: false }
  }
  const req = (await quoteRes.json().catch(() => ({})))?.accepts?.[0]

  // The whole point of guard.mjs: nothing below signs anything a quote said
  // until the quote has been compared with what this client already knows.
  const problem = checkRequirements(req, i.paint.agentPricePerTile)
  if (problem) return { ok: false, reason: 'unsafe_quote', check: problem, spent: false }

  const account = privateKeyToAccount(PRIVATE_KEY)
  const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)

  const timeout = Math.min(req.maxTimeoutSeconds ?? 60, MAX_TIMEOUT_SECONDS)
  const authorization = {
    from: account.address,
    to: req.payTo,
    value: BigInt(req.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + timeout),
    nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`,
  }

  const signature = await wallet.signTypedData({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: base.id,
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })

  const header = Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  })).toString('base64')

  let res
  try {
    res = await fetch(`${CANVAS_URL}/api/agent/paint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
      // AGENT_NAME is the name this wallet appears under. Without it it paints
      // as anon-xxxx -- still ranked, and still eligible for the monthly
      // prize, just not under a name anybody would recognise.
      body: JSON.stringify(
        process.env.AGENT_NAME ? { x, y, color, username: process.env.AGENT_NAME } : { x, y, color },
      ),
    })
  } catch {
    // The signed request may or may not have arrived. The authorization is
    // single-use and expires within the window, but the budget stays charged:
    // "find out" is the honest state, not "nothing happened".
    return { ok: false, reason: 'canvas_unreachable_after_signing', spent: true }
  }
  const body = await res.json().catch(() => ({}))
  if (res.ok && body.ok !== false) {
    return {
      ok: true,
      transaction: typeof body.transaction === 'string' ? body.transaction : null,
      version: Number.isInteger(body.version) ? body.version : null,
      changed: body.changed !== false,
      rateRemaining: res.headers.get('X-RateLimit-Remaining'),
    }
  }
  const reason = reasonFor(res.status, body)
  // These two mean money moved, or may have; everything else was refused
  // before settlement and the reservation can go back.
  const spent = reason === 'paint_failed_after_settlement' || reason === 'settlement_unknown'
  return { ok: false, reason, spent }
}

// ----------------------------------------------------------------- server

const server = new McpServer({ name: '21millionpixels', version: '0.2.0' })

server.registerTool('canvas_info', {
  title: 'Canvas info',
  description:
    'Dimensions, palette, price per tile and your remaining spend budget. Free. '
    + 'Call this first: colour indices and the price come from here, never hardcoded.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
  const i = await getInfo()
  // Rebuilt from known fields: /api/info is the one response a model reads
  // in full, and it should read numbers and addresses, not prose.
  const p = i.paint.agentPricePerTile
  return json({
    world: { width: i.world.width, height: i.world.height },
    palette: i.palette,
    paint: {
      agentPricePerTile: { usd: p.usd, atomic: p.atomic, asset: p.asset, network: p.network },
      agentRateLimitPerMinute: i.paint.agentRateLimitPerMinute,
      // Both halves of the human rule, or an agent reads "one every 15s" and
      // believes a person is slower than they are.
      humanCooldownSeconds: i.paint.humanCooldownSeconds,
      humanBurstTiles: i.paint.humanBurstTiles,
    },
    budget: budgetState(),
  })
})

server.registerTool('check_tile', {
  title: 'Check one tile',
  description:
    'What colour is a single tile? Free. Use before painting: repainting a tile '
    + 'the colour it already is still costs money and changes nothing.',
  inputSchema: { x: z.number().int().min(0), y: z.number().int().min(0) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ x, y }) => {
  const res = await fetch(`${CANVAS_URL}/api/tile/${x}/${y}`)
  if (!res.ok) return fail('tile_read_failed', { status: res.status })
  const tile = sanitizeTile(await res.json().catch(() => null))
  return tile ? json(tile) : fail('bad_tile')
})

server.registerTool('look', {
  title: 'Look at an area',
  description:
    'Read a rectangle of the canvas as a grid of palette indices. Free. '
    + 'rows[dy][dx] is the tile at (x + dx, y + dy); 0 means unpainted. '
    + 'Max 128x128.',
  inputSchema: {
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(128).default(32),
    h: z.number().int().min(1).max(128).default(32),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ x, y, w, h }) => {
  const res = await fetch(`${CANVAS_URL}/api/region?x=${x}&y=${y}&w=${w}&h=${h}&format=json`)
  if (!res.ok) return fail('region_read_failed', { status: res.status })
  const body = await res.json().catch(() => null)
  // Integers only. The rows are the one thing here a model reads as content,
  // so they are rebuilt from what came back rather than passed through.
  const rows = Array.isArray(body?.rows)
    ? body.rows.map((r) => (Array.isArray(r) ? r.map((v) => (Number.isInteger(v) && v >= 0 ? v : 0)) : null))
    : null
  if (!rows || rows.includes(null) || rows.length > h || rows.some((r) => r.length > w)) {
    return fail('bad_region')
  }
  let painted = 0
  for (const r of rows) for (const v of r) if (v !== 0) painted++
  return json({ x, y, w: rows[0]?.length ?? 0, h: rows.length, painted, rows })
})

server.registerTool('find_empty_space', {
  title: 'Find blank canvas',
  description:
    'Scan one area of the canvas and find where a rectangle of blank tiles fits. '
    + 'Free, and a single request however many candidates it returns. '
    + 'Give w and h to place something of that size; omit them to be told the '
    + 'largest empty square available. tolerance allows a few stray tiles, which '
    + 'matters because a single scattered pixel would otherwise disqualify an '
    + 'entire clear area.',
  inputSchema: {
    w: z.number().int().min(1).max(512).optional()
      .describe('width to fit; omit to find the largest empty square'),
    h: z.number().int().min(1).max(512).optional().describe('height to fit'),
    near_x: z.number().int().min(0).default(2500),
    near_y: z.number().int().min(0).default(2100),
    search_size: z.number().int().min(32).max(1024).default(512)
      .describe('side of the area to scan around the point'),
    tolerance: z.number().min(0).max(0.5).default(0)
      .describe('fraction of the rectangle allowed to be already painted'),
    candidates: z.number().int().min(1).max(10).default(3),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ w, h, near_x, near_y, search_size, tolerance, candidates }) => {
  const i = await getInfo()

  // One request. The old version made twelve and still could not answer
  // "where is the most space", because it only ever asked yes/no questions
  // about places it guessed at.
  const half = Math.floor(search_size / 2)
  const sx = Math.max(0, Math.min(i.world.width - search_size, near_x - half))
  const sy = Math.max(0, Math.min(i.world.height - search_size, near_y - half))

  const res = await fetch(`${CANVAS_URL}/api/region?x=${sx}&y=${sy}&w=${search_size}&h=${search_size}`)
  if (!res.ok) return fail('region_read_failed', { status: res.status })

  // The server clamps at the canvas edge, so its reported extent is the one to
  // use -- once it has been checked against the bytes that actually arrived.
  // The table below is sized from it, and a header nobody checked could ask
  // for gigabytes.
  const bytes = new Uint8Array(await res.arrayBuffer())
  const extent = parseRegionHeader(res.headers.get('X-Canvas-Region'), bytes.length, search_size)
  if (!extent) return fail('bad_region')
  const { w: cw, h: ch } = extent
  const sat = buildSat(bytes, cw, ch)

  let painted = 0
  for (const b of bytes) if (b !== 0) painted++

  const searched = {
    x: sx, y: sy, w: cw, h: ch,
    paintedTiles: painted,
    paintedPercent: Number(((painted / (cw * ch)) * 100).toFixed(3)),
  }

  if (w === undefined || h === undefined) {
    const best = findLargestSquare(sat, cw, ch, tolerance)
    if (!best) return json({ found: false, searched, hint: 'Nothing blank here. Try a different area or raise tolerance.' })
    return json({
      found: true,
      largestEmptySquare: {
        x: sx + best.x, y: sy + best.y, w: best.w, h: best.h,
        paintedTiles: best.painted,
      },
      searched,
    })
  }

  const maxPainted = Math.floor(w * h * tolerance)
  const hits = findFit(sat, cw, ch, w, h, maxPainted, candidates)

  if (hits.length === 0) {
    // Say how close it got, so the caller can choose between a smaller
    // rectangle and a looser tolerance instead of guessing.
    const best = findLargestSquare(sat, cw, ch, tolerance)
    return json({
      found: false,
      searched,
      largestEmptySquareHere: best
        ? { x: sx + best.x, y: sy + best.y, w: best.w, h: best.h }
        : null,
      hint: `No ${w}x${h} space with at most ${maxPainted} painted tiles. `
        + 'Try a smaller rectangle, a larger search_size, or raise tolerance.',
    })
  }

  return json({
    found: true,
    best: { x: sx + hits[0].x, y: sy + hits[0].y, w, h, paintedTiles: hits[0].painted },
    candidates: hits.map((c) => ({
      x: sx + c.x, y: sy + c.y, w, h, paintedTiles: c.painted,
    })),
    searched,
  })
})

server.registerTool('spend_report', {
  title: 'Spend report',
  description: 'How much this session has spent and how much budget is left. Free.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => json(budgetState()))

server.registerTool('paint_tile', {
  title: 'Paint one tile (costs money)',
  description:
    'Paint a single tile. THIS SPENDS REAL USDC on Base -- $0.005 per tile; '
    + 'canvas_info reports the exact price. '
    + 'Set dry_run true to price it and check the tile without paying. '
    + 'Refuses when the tile already holds that colour, when the session budget '
    + 'is exhausted, and always in DRY_RUN mode.',
  inputSchema: {
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    color: z.number().int().min(0).describe('palette index from canvas_info, 1-based; 0 clears the tile back to the background'),
    dry_run: z.boolean().default(false).describe('estimate only; never spends'),
    force: z.boolean().default(false).describe('paint even if the tile is already that colour'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ x, y, color, dry_run, force }) => {
  const i = await getInfo()
  const price = i.paint.agentPricePerTile.usd

  if (x >= i.world.width || y >= i.world.height) {
    return fail('out_of_bounds', { world: i.world })
  }
  if (color > i.palette.max) {
    return fail('invalid_color', { max: i.palette.max })
  }

  // Free read before a paid write. The endpoint charges for a paint that
  // changes nothing, so checking first is strictly cheaper than not.
  const tileRes = await fetch(`${CANVAS_URL}/api/tile/${x}/${y}`)
  const current = sanitizeTile(await tileRes.json().catch(() => null))
  if (!current) return fail('tile_read_failed', { status: tileRes.status })
  const alreadyThatColour = current.color === color

  const dry = dry_run || GLOBAL_DRY_RUN

  if (alreadyThatColour && !force) {
    return json({
      ok: false,
      reason: 'already_that_colour',
      x, y, color,
      spent: 0,
      note: 'Painting this would settle a payment and change nothing. Pass force:true to do it anyway.',
      budget: budgetState(),
    })
  }

  if (dry) {
    const state = budgetState()
    return json({
      ok: true,
      dryRun: true,
      wouldSpendUsd: price,
      x, y,
      from: current.color,
      to: color,
      alreadyThatColour,
      affordable: state.remainingUsd >= price,
      budget: state,
    })
  }

  if (!PRIVATE_KEY) {
    return fail('no_wallet', {
      detail: 'AGENT_PRIVATE_KEY is not set, so this server can read but not paint.',
    })
  }

  // Reserved synchronously, before the first await of the paid path: however
  // many paint_tile calls the client dispatches at once, they take turns here
  // and an over-budget one never reaches the signing code.
  if (!budget.reserve(price)) {
    return fail('budget_exhausted', {
      detail: `Session cap is $${budget.capUsd}. Spent $${budget.state().spentUsd}. Restart the server to reset.`,
      budget: budgetState(),
    })
  }

  let result
  try {
    result = await payAndPaint(x, y, color)
  } catch {
    // Thrown before the signed request was sent (info, quote, signing): the
    // budget was not spent, and the message is not the model's to read.
    budget.release(price)
    return fail('paint_failed', { budget: budgetState() })
  }

  if (!result.ok) {
    if (!result.spent) budget.release(price)
    return fail(result.reason, {
      ...(result.check ? { check: result.check } : {}),
      budgetCharged: result.spent,
      budget: budgetState(),
    })
  }

  budget.settle()

  return json({
    ok: true,
    x, y, color,
    spentUsd: price,
    changed: result.changed,
    transaction: result.transaction,
    explorer: explorerUrl(result.transaction),
    canvasVersion: result.version,
    rateLimitRemaining: result.rateRemaining,
    budget: budgetState(),
  })
})

const transport = new StdioServerTransport()
await server.connect(transport)
// stderr, never stdout: stdout carries the MCP protocol and anything else on it
// corrupts the stream.
console.error(
  `21millionpixels MCP ready — canvas ${CANVAS_URL}, cap $${budget.capUsd}`
  + `${GLOBAL_DRY_RUN ? ', DRY RUN (cannot spend)' : ''}`
  + `${PRIVATE_KEY ? '' : ', no wallet (read-only)'}`,
)

#!/usr/bin/env node
/**
 * Drives the MCP server over stdio the way a real client would, so the tools are
 * exercised through the actual protocol rather than by importing them.
 *
 * Runs with no AGENT_PRIVATE_KEY and DRY_RUN=1, so it cannot spend even if
 * something is wired wrong.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, 'canvas-server.mjs')], {
  env: { ...process.env, DRY_RUN: '1', AGENT_PRIVATE_KEY: '', MAX_SPEND_USD: '0.05' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buf = ''
const waiters = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id) }
    } catch { /* not a JSON-RPC line */ }
  }
})

let nextId = 1
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++
  waiters.set(id, resolve)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

const unwrap = (r) => {
  const text = r?.result?.content?.[0]?.text
  try { return JSON.parse(text) } catch { return text }
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '0' },
})
console.log('server     :', init.result?.serverInfo)
notify('notifications/initialized')

const tools = await send('tools/list', {})
console.log('tools      :', tools.result.tools.map((t) => t.name).join(', '))
console.log()

const info = unwrap(await send('tools/call', { name: 'canvas_info', arguments: {} }))
console.log('canvas_info: world', info.world.width + 'x' + info.world.height,
  '· price $' + info.paint.agentPricePerTile.usd, '· budget', JSON.stringify(info.budget))

const tile = unwrap(await send('tools/call', {
  name: 'check_tile', arguments: { x: 2500, y: 2100 },
}))
console.log('check_tile :', JSON.stringify(tile))

const area = unwrap(await send('tools/call', {
  name: 'look', arguments: { x: 2497, y: 2098, w: 8, h: 4 },
}))
console.log('look       : painted', area.painted, 'of', area.w * area.h)
for (const row of area.rows) console.log('             ', JSON.stringify(row))

const t0 = Date.now()
const fit = unwrap(await send('tools/call', {
  name: 'find_empty_space',
  arguments: { w: 32, h: 32, near_x: 2500, near_y: 2100, search_size: 512 },
}))
console.log(`fit 32x32  : ${JSON.stringify(fit.best ?? fit.hint)}  (${Date.now() - t0}ms)`)
console.log('             searched', JSON.stringify(fit.searched))
if (fit.candidates) for (const c of fit.candidates) console.log('             alt', JSON.stringify(c))

const tolerant = unwrap(await send('tools/call', {
  name: 'find_empty_space',
  arguments: { w: 64, h: 64, near_x: 2500, near_y: 2100, search_size: 512, tolerance: 0.02 },
}))
console.log('64x64 @2%  :', JSON.stringify(tolerant.best ?? tolerant.hint))

const largest = unwrap(await send('tools/call', {
  name: 'find_empty_space',
  arguments: { near_x: 2500, near_y: 2100, search_size: 512 },
}))
console.log('largest sq :', JSON.stringify(largest.largestEmptySquare ?? largest.hint))

console.log()
console.log('--- paint attempts (DRY_RUN=1, no wallet: nothing can spend) ---')

const already = unwrap(await send('tools/call', {
  name: 'paint_tile', arguments: { x: 2500, y: 2100, color: 3 },
}))
console.log('same colour:', already.reason, '| spent', already.spent)

const dry = unwrap(await send('tools/call', {
  name: 'paint_tile', arguments: { x: 2501, y: 2101, color: 9 },
}))
console.log('dry run    : wouldSpend $' + dry.wouldSpendUsd, '| from', dry.from, '-> to', dry.to,
  '| affordable', dry.affordable)

const oob = unwrap(await send('tools/call', {
  name: 'paint_tile', arguments: { x: 99999, y: 10, color: 3 },
}))
console.log('out of range:', oob.reason)

const badColor = unwrap(await send('tools/call', {
  name: 'paint_tile', arguments: { x: 10, y: 10, color: 99 },
}))
console.log('bad colour :', badColor.reason)

const spend = unwrap(await send('tools/call', { name: 'spend_report', arguments: {} }))
console.log()
console.log('spend      :', JSON.stringify(spend))
console.log(spend.spentUsd === 0 ? '\nPASS - nothing was spent' : '\nFAIL - money moved')

child.kill()
process.exit(spend.spentUsd === 0 ? 0 : 1)

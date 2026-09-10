#!/usr/bin/env node
/**
 * Paints a whole plot in ONE x402 payment.
 *
 *   AGENT_PRIVATE_KEY=0x... node scripts/agent-batch.mjs \
 *     --url https://21millionpixels.art/api/agent/paint-batch --x 0 --y 0
 *
 * Options:
 *   --x --y           top-left corner of the 10x10 plot
 *   --url             batch endpoint (default is the live site)
 *   --colors a,b      two palette indices for the checker (default 13,3)
 *   --as <name>       the name this wallet paints under
 *   --max <n>         buy at most this many tiles (default all blank ones)
 *   --quote-only      print the 402 and exit WITHOUT signing or paying
 *
 * The sibling scripts pay per tile, which is what the single-tile route
 * offers. This is the other shape the API has and the one the site's own
 * assistant uses: up to a hundred tiles inside one plot, quoted as
 * `tiles x price`, bought with one signature and one settlement.
 *
 * Which matters for more than convenience. A settlement is an on-chain
 * transfer somebody is billed for, so a hundred tiles bought one at a time
 * costs a hundred of them; bought together it costs one. The pixels still
 * arrive gradually -- they are queued and painted at the rate /api/info
 * publishes, so a design cannot appear in a single frame over work somebody
 * spent hours on.
 *
 * It reads the plot before quoting and asks only for tiles that are actually
 * blank, so nothing already painted is paid for twice or covered over.
 */
import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const all = process.argv.slice(2)
const args = Object.fromEntries(
  all.flatMap((a, i) => (a.startsWith('--')
    ? [[a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]]]
    : [])),
)

const url = args.url ?? 'https://21millionpixels.art/api/agent/paint-batch'
const originX = Number(args.x ?? 0)
const originY = Number(args.y ?? 0)
const [colorA, colorB] = String(args.colors ?? '13,3').split(',').map(Number)
const max = Number(args.max ?? 100)
const quoteOnly = args['quote-only'] === true
const origin = new URL(url).origin
const PLOT = 10

/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))
const fail = (m) => { console.error(`\n  ${m}\n`); return exit(1) }
if (originX % PLOT || originY % PLOT) await fail('--x and --y must be a plot corner (multiples of 10)')

// ------------------------------------------------------------- 1. read first
// The whole reason /api/region is free. Paying for a tile that already holds
// the colour you want is money for nothing, and painting over somebody's work
// because you did not look is worse.
const grid = new Uint8Array(await (await fetch(
  `${origin}/api/region?x=${originX}&y=${originY}&w=${PLOT}&h=${PLOT}`,
)).arrayBuffer())

const tiles = []
for (let i = 0; i < PLOT * PLOT && tiles.length < max; i++) {
  if (grid[i]) continue
  const x = originX + (i % PLOT)
  const y = originY + Math.floor(i / PLOT)
  tiles.push({ x, y, color: (x + y) % 2 === 0 ? colorA : colorB })
}
if (!tiles.length) await fail('every tile in this plot is already painted; nothing to buy')

const plotId = (originY / PLOT) * 500 + originX / PLOT
console.log(`  plot       ${plotId} at ${originX},${originY}`)
console.log(`  blank      ${tiles.length} of ${PLOT * PLOT} tiles`)

const body = JSON.stringify(
  typeof args.as === 'string' ? { plot: plotId, tiles, username: args.as } : { plot: plotId, tiles },
)

// ----------------------------------------------------------------- 2. quote
const q = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
if (q.status === 423) await fail('this plot is locked by its owner and takes no paid paint')
if (q.status !== 402) await fail(`expected 402 with a quote, got ${q.status}: ${(await q.text()).slice(0, 200)}`)
const req = (await q.json()).accepts?.[0]
if (!req) await fail('no payment requirements in the 402')

console.log(`  quote      ${(Number(req.maxAmountRequired) / 1e6).toFixed(6)} USDC`)
console.log(`  pay to     ${req.payTo}`)
if (quoteOnly) { console.log('\n  --quote-only: nothing signed, nothing paid.\n'); await exit(0) }

const pk = process.env.AGENT_PRIVATE_KEY
if (!pk) await fail('AGENT_PRIVATE_KEY is not set. Use a wallet you are willing to spend from.')
const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)
console.log(`  payer      ${account.address}`)

// ------------------------------------------------------------------ 3. sign
// One authorisation for the whole batch: EIP-3009, single-use, and worthless
// to anyone but the payee named in it.
const authorization = {
  from: account.address,
  to: req.payTo,
  value: BigInt(req.maxAmountRequired),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds ?? 60, 120)),
  nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`,
}
const signature = await wallet.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: base.id, verifyingContract: req.asset },
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
  scheme: req.scheme,
  network: req.network,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
})).toString('base64')

// ------------------------------------------------------------------ 4. pay
console.log('\n  paying and queueing...')
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
  body,
})
const out = await res.json().catch(() => ({}))
console.log(`\n  HTTP ${res.status}`)
console.log(`  ${JSON.stringify(out, null, 2).split('\n').join('\n  ')}`)
if (out.transaction) console.log(`\n  settled: https://basescan.org/tx/${out.transaction}`)

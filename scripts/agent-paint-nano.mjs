#!/usr/bin/env node
/**
 * Paints one tile (or, with --batch, one plot's worth of tiles), paying in XNO on Nano over x402.
 *
 *   NANO_AGENT_KEY=<64-hex-seed> \
 *     node scripts/agent-paint-nano.mjs --url https://21millionpixels.art/api/agent/paint \
 *     --x 2500 --y 2100 --color 3
 *
 * Options: --x --y --color --batch --url --as --v1 --quote-only --allow-unfunded
 *
 * The send block is built and signed by the Nano x402 scheme
 * (@x402nano/exact), not by hand: interop with the real scheme package is the
 * point of this script, exactly as agent-paint-solana.mjs uses @x402/svm rather
 * than hand-rolling an SVM transaction.
 *
 * Differences from the Base and Solana scripts, and why:
 *
 *  * Nano has no gas and no fee payer. A Nano send is feeless and the sender
 *    signs its own block, so where the Solana script needs the site's quote to
 *    name a fee payer, this one needs only `payTo` and `amount`.
 *  * Nonce (proof of work). Every Nano block carries work, which is a small
 *    proof-of-work over the previous block's hash. The helper does this for
 *    you against a work server; it is the one step with real latency, which is
 *    why --quote-only exists and why the timing print below is useful.
 *  * No minimum balance beyond the payment. The account needs the amount plus
 *    nothing else, so an unfunded account fails only for lack of funds, never
 *    for lack of "gas".
 *
 * --allow-unfunded runs the whole path from an account holding nothing. The
 * expected answer is a 402 invalid_payment whose detail names insufficient
 * balance. Reaching that proves the quote, the parse, the send-block
 * construction, the work, and the facilitator request; only the money was
 * missing. It costs nothing and is the intended way to test this script.
 *
 * The seed is a 64-character hex Nano private key in NANO_AGENT_KEY. It is
 * read from the environment and never written to disk or logged.
 *
 * NOTE: this script needs a `nano:` quote from the site. Until the site's
 * payment routing offers one it will stop at step 1 with a clear message;
 * that is expected and is the server-side half of the integration.
 */
import { ExactNanoScheme } from '@x402nano/exact/client'
import { Helper, validateNanoAccountPrivateKey, validateNanoRpcUrl } from '@x402nano/helper'

const all = process.argv.slice(2)
const args = Object.fromEntries(
  all.flatMap((a, i) => (a.startsWith('--')
    ? [[a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]]]
    : [])),
)
const url = args.url ?? 'https://21millionpixels.art/api/agent/paint'
const x = Number(args.x ?? 2500)
const y = Number(args.y ?? 2100)
const color = Number(args.color ?? 3)
const useV1 = args.v1 === true
const quoteOnly = args['quote-only'] === true
const allowUnfunded = args['allow-unfunded'] === true
/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))
const fail = (m) => { console.error(`\n  ${m}\n`); return exit(1) }

/**
 * NANO_RPC_URL defaults to a public node. A public node is fine for reads and
 * for broadcasting; it is not fine for a work server under load, so
 * NANO_WORK_URL can point at a dedicated one.
 */
const rpcUrl = process.env.NANO_RPC_URL ?? 'https://rpc.nano.to'
const workUrl = process.env.NANO_WORK_GENERATION_URL ?? process.env.NANO_WORK_URL
try {
  validateNanoRpcUrl(rpcUrl)
} catch (e) {
  await fail(`NANO_RPC_URL is not a valid Nano RPC URL: ${e?.message ?? e}`)
}
/*
 * Config keys are UPPERCASE and are read straight off the object handed to the
 * constructor -- there is no snake_case or camelCase accepted, and no env
 * fallback. Passing `nanoRpcUrl` silently leaves config.NANO_RPC_URL unset and
 * the send block later dies with "[error_config] NANO_RPC_URL is not set".
 * (Found by running the unfunded path against a mock quote, 2026-09-10.)
 */
const helperConfig = { NANO_RPC_URL: rpcUrl }
if (workUrl) helperConfig.NANO_WORK_GENERATION_URL = workUrl

if (args.batch === true) await fail('--batch needs a value: "x,y,color;x,y,color;..."')
const batch = typeof args.batch === 'string'
  ? args.batch.split(';').map((t) => { const [bx, by, bc] = t.split(',').map(Number); return { x: bx, y: by, color: bc } })
  : null
const plotOf = (t) => Math.floor(t.y / 10) * 500 + Math.floor(t.x / 10)
const body = JSON.stringify(
  batch
    ? { plot: plotOf(batch[0]), tiles: batch, ...(typeof args.as === 'string' ? { username: args.as } : {}) }
    : typeof args.as === 'string' ? { x, y, color, username: args.as } : { x, y, color },
)

// ------------------------------------------------------------------ 1. quote
const q = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
if (q.status !== 402) await fail(`expected 402, got ${q.status}: ${(await q.text()).slice(0, 200)}`)
const v1Body = await q.json()
const raw = q.headers.get('PAYMENT-REQUIRED')
if (!raw) await fail('no PAYMENT-REQUIRED header: this server is not speaking v2')
const required = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))

// Nano quotes are identified by the CAIP-2 family `nano:` (v2) or the bare
// network name `nano` (v1), matching how the Solana script finds `solana:`.
const v2Terms = required.accepts.find((a) => String(a.network).startsWith('nano:'))
const v1Terms = v1Body.accepts.find((a) => a.network === 'nano' || String(a.network).startsWith('nano:'))
if (!v2Terms || !v1Terms) {
  const offered = (required.accepts ?? []).map((a) => a.network).join(', ') || 'none'
  await fail(
    `the 402 offers no Nano quote; it offers: ${offered}.\n` +
    '  This is the server-side half of the integration: the site must expose a\n' +
    '  `nano:mainnet` entry in its accepts list (and a facilitator that can\n' +
    '  verify Nano) before this script can proceed. Nothing was signed or paid.'
  )
}

// Nano amounts are raw units (1 XNO = 10^30 raw). Format without floats.
const toXno = (raw_) => {
  const s = String(raw_ ?? '0').replace(/n$/, '')
  const neg = s.startsWith('-')
  const digits = (neg ? s.slice(1) : s).padStart(31, '0')
  const whole = digits.slice(0, -30).replace(/^0+(?=\d)/, '')
  const frac = digits.slice(-30).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac.slice(0, 6) : ''}`
}

console.log(`  dialect    ${useV1 ? 'v1 (X-PAYMENT)' : 'v2 (PAYMENT-SIGNATURE)'}`)
console.log(`  quote      ${toXno(v2Terms.amount)} XNO (${v2Terms.amount} raw)`)
console.log(`  pay to     ${v2Terms.payTo}`)
console.log(`  network    ${useV1 ? v1Terms.network : v2Terms.network}`)
console.log(`  rpc        ${rpcUrl}`)
if (quoteOnly) { console.log('\n  --quote-only: nothing signed, nothing paid.\n'); await exit(0) }

// -------------------------------------------------------------------- 2. key
const seed = process.env.NANO_AGENT_KEY
if (!seed) await fail('NANO_AGENT_KEY is not set: set it to a 64-character hex Nano private key.')
try {
  validateNanoAccountPrivateKey(seed)
} catch (e) {
  await fail(`NANO_AGENT_KEY is not a valid Nano private key: ${e?.message ?? e}`)
}

const helper = new Helper(helperConfig)
helper.setNanoAccountPrivateKey(seed)

// -------------------------------------------------------------------- 3. pay
// The scheme builds the send block, computes work, signs it, and returns the
// payload. This is where an unfunded account first becomes visible, because
// work must be done over the account's real frontier.
const scheme = new ExactNanoScheme(helper)
let payload
const t0 = Date.now()
try {
  ;({ payload } = await scheme.createPaymentPayload(useV1 ? 1 : 2, v2Terms))
} catch (e) {
  const msg = e?.message ?? String(e)
  if (allowUnfunded) console.log(`  (--allow-unfunded: send block not built: ${msg})`)
  else await fail(
    `could not build the send block: ${msg}\n` +
    '  (an account with no balance or no receive history cannot sign a send; try --allow-unfunded)'
  )
}
const workMs = Date.now() - t0
if (payload) console.log(`  built      in ${workMs}ms (work included)`)

const header = useV1
  ? Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'nano', payload })).toString('base64')
  : Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: v2Terms,
    ...(required.extensions ? { extensions: required.extensions } : {}),
    payload,
  })).toString('base64')

console.log('\n  paying and painting...')
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', [useV1 ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE']: header },
  body,
})
const out = await res.json().catch(() => ({}))
console.log(`\n  HTTP ${res.status}`)
console.log(`  ${JSON.stringify(out, null, 2).split('\n').join('\n  ')}`)
const receipt = res.headers.get('PAYMENT-RESPONSE')
if (receipt) console.log(`\n  PAYMENT-RESPONSE: ${JSON.stringify(JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')))}`)
if (out.block || out.hash) console.log(`\n  settled: https://nanohub.io/block/${out.block ?? out.hash}`)
if (allowUnfunded && out.reason === 'invalid_payment') {
  const fundsOnly = /insufficient|balance|unreceivable|nothing/i.test(String(out.detail))
  console.log(`\n  expected refusal: ${out.detail}. ${fundsOnly ? 'Everything but the money is right.' : 'Read the detail; this is not the funds-only refusal.'}\n`)
}

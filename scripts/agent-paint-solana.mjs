#!/usr/bin/env node
/**
 * Paints one tile (or, with --batch, one plot's worth of tiles), paying in USDC on Solana over x402.
 *
 *   SOLANA_AGENT_KEY_FILE=~/.config/solana/throwaway.json \
 *     node scripts/agent-paint-solana.mjs --url https://21millionpixels.art/api/agent/paint \
 *     --x 2500 --y 2100 --color 3
 *
 * Options: --x --y --color --batch --url --as --v1 --quote-only --allow-unfunded
 *
 * The transaction is built and half-signed by Coinbase's own client
 * (@x402/svm), not by hand: interop with the real client is the point of
 * this script. The site's quote names Coinbase's fee payer, so this wallet
 * needs USDC and no SOL at all.
 *
 * --v1 pays in the v1 envelope (X-PAYMENT, network "solana"), built against
 * the v1 quote's fee payer, which differs from the v2 one.
 *
 * --allow-unfunded runs the whole path from a key holding nothing. The
 * expected answer is 402 invalid_payment with detail
 * invalid_exact_svm_payload_transaction_simulation_failed: Coinbase decoded
 * a real signed transaction and simulated it, which proves the quote, the
 * parse, the reconcile and our facilitator request; only the money was
 * missing. Free. Confirmed against live Coinbase in both dialects on
 * 2026-09-04.
 *
 * The key file is the throwaway Solana wallet file: the line that is a JSON
 * array of 64 numbers (seed || public key) is read; nothing else in it is.
 */
import { readFileSync } from 'node:fs'
import { createKeyPairSignerFromBytes } from '@solana/kit'
import { ExactSvmScheme } from '@x402/svm'

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
 * --batch "x,y,color;x,y,color;..." pays the batch route instead: one payment
 * covering every tile listed, all inside the plot of the first one. Point
 * --url at /api/agent/paint-batch. Paying the batch route with the v2 dialect
 * is also what lists that route in Coinbase's Bazaar, since a listing follows
 * a settled payment that echoed the route's own discovery extension.
 *
 * A bare --batch is refused. Left to the parser it is `true`, which is not
 * a batch, and the script would go on to pay for the default single tile
 * that nobody asked for.
 */
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

const v2Terms = required.accepts.find((a) => String(a.network).startsWith('solana:'))
const v1Terms = v1Body.accepts.find((a) => a.network === 'solana')
if (!v2Terms || !v1Terms) await fail('the 402 offers no Solana quote; is X402_SOLANA_PAY_TO configured?')

console.log(`  dialect    ${useV1 ? 'v1 (X-PAYMENT)' : 'v2 (PAYMENT-SIGNATURE)'}`)
console.log(`  quote      ${(Number(v2Terms.amount) / 1e6).toFixed(6)} USDC`)
console.log(`  pay to     ${v2Terms.payTo}`)
console.log(`  network    ${useV1 ? v1Terms.network : v2Terms.network}`)
console.log(`  fee payer  ${useV1 ? v1Terms.extra?.feePayer : v2Terms.extra?.feePayer}`)
if (quoteOnly) { console.log('\n  --quote-only: nothing signed, nothing paid.\n'); await exit(0) }

// -------------------------------------------------------------------- 2. key
const keyFile = process.env.SOLANA_AGENT_KEY_FILE
if (!keyFile) await fail('SOLANA_AGENT_KEY_FILE is not set: point it at the throwaway Solana wallet file.')
const arrayLine = readFileSync(keyFile, 'utf8').split(/\r?\n/).find((l) => /^\[\s*\d+(\s*,\s*\d+){63}\s*\]$/.test(l.trim()))
if (!arrayLine) await fail('the key file has no 64-number JSON array line')
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(arrayLine)))
console.log(`  payer      ${signer.address}`)

// ------------------------------------------------------------------- 3. sign
// The official client builds the transaction: compute budget, USDC
// TransferChecked to payTo's token account, a memo, fee payer from `extra`,
// and signs this wallet's half. It reads v2-shaped requirements. For v1 the
// v2 shape is handed over with the v1 fee payer, since that is what the v1
// facilitator will sign as.
const scheme = new ExactSvmScheme(signer, process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined)
const forClient = useV1
  ? { ...v2Terms, extra: { ...(v2Terms.extra ?? {}), feePayer: v1Terms.extra.feePayer } }
  : v2Terms
let payload
try {
  ;({ payload } = await scheme.createPaymentPayload(2, forClient))
} catch (e) {
  await fail(`could not build the transaction: ${e?.message ?? e}${allowUnfunded ? '' : '\n  (an unfunded wallet may have no USDC token account; try --allow-unfunded or fund it)'}`)
}
if (allowUnfunded) console.log('  (--allow-unfunded: continuing; this payment cannot succeed)')

const header = useV1
  ? Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'solana', payload })).toString('base64')
  : Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: v2Terms,
    ...(required.extensions ? { extensions: required.extensions } : {}),
    payload,
  })).toString('base64')

// -------------------------------------------------------------------- 4. pay
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
if (out.transaction) console.log(`\n  settled: https://solscan.io/tx/${out.transaction}`)
if (allowUnfunded && out.reason === 'invalid_payment') {
  // Coinbase prefixes its SVM reasons: invalid_exact_svm_payload_transaction_simulation_failed.
  const fundsOnly = String(out.detail).endsWith('transaction_simulation_failed')
  console.log(`\n  expected refusal: ${out.detail}. ${fundsOnly ? 'Everything but the money is right.' : 'Read the detail; this is not the funds-only refusal.'}\n`)
}

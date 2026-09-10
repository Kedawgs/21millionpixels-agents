#!/usr/bin/env node
/**
 * Paints one tile using x402 **v2** -- the header transport.
 *
 *   AGENT_PRIVATE_KEY=0x... node scripts/agent-paint-v2.mjs \
 *     --url https://21millionpixels.art/api/agent/paint --x 2500 --y 2100 --color 3
 *
 * Options: --x --y --color --url --as --quote-only
 *
 * v1 puts the quote in the 402's JSON body and the payment in `X-PAYMENT`.
 * v2 puts the quote in a `PAYMENT-REQUIRED` header, the payment in
 * `PAYMENT-SIGNATURE`, names the network as CAIP-2 (`eip155:8453`), and
 * echoes back the exact requirements it accepted -- which the server compares
 * field by field against its own before it will settle.
 *
 * The signed authorization is byte-identical in both. Nothing about the money
 * changes; this is the same EIP-3009 transfer in a different envelope. It
 * exists as its own script because "the site speaks v2" is a claim worth
 * being able to check by actually paying with it.
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
const url = args.url ?? 'https://21millionpixels.art/api/agent/paint'
const x = Number(args.x ?? 2500)
const y = Number(args.y ?? 2100)
const color = Number(args.color ?? 3)
const quoteOnly = args['quote-only'] === true
/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))
const fail = (m) => { console.error(`\n  ${m}\n`); return exit(1) }

const body = JSON.stringify(
  typeof args.as === 'string' ? { x, y, color, username: args.as } : { x, y, color },
)

// ------------------------------------------------- 1. quote, from the header
const q = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
if (q.status !== 402) await fail(`expected 402, got ${q.status}: ${(await q.text()).slice(0, 200)}`)

const raw = q.headers.get('PAYMENT-REQUIRED')
if (!raw) await fail('no PAYMENT-REQUIRED header: this server is not speaking v2')
const required = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
const accepted = required.accepts?.[0]
if (!accepted) await fail('PAYMENT-REQUIRED carried no accepts[0]')

console.log(`  x402       v${required.x402Version} (header transport)`)
console.log(`  quote      ${(Number(accepted.amount) / 1e6).toFixed(6)} USDC`)
console.log(`  pay to     ${accepted.payTo}`)
console.log(`  network    ${accepted.network}`)
console.log(`  extensions ${Object.keys(required.extensions ?? {}).join(', ') || '(none)'}`)
if (quoteOnly) { console.log('\n  --quote-only: nothing signed, nothing paid.\n'); await exit(0) }

const pk = process.env.AGENT_PRIVATE_KEY
if (!pk) await fail('AGENT_PRIVATE_KEY is not set.')
const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)
console.log(`  payer      ${account.address}`)

// ------------------------------------------------------------------ 2. sign
// Identical to v1: the envelope changed, the authorisation did not.
const authorization = {
  from: account.address,
  to: accepted.payTo,
  value: BigInt(accepted.amount),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + Math.min(accepted.maxTimeoutSeconds ?? 60, 120)),
  nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`,
}
const signature = await wallet.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: base.id, verifyingContract: accepted.asset },
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

// `accepted` goes back exactly as it came. The server compares it field by
// field with the quote it would issue now, so a client that quietly edited
// the amount or the payee is refused before anything is settled.
const header = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepted,
  ...(required.extensions ? { extensions: required.extensions } : {}),
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

// ------------------------------------------------------------------- 3. pay
console.log('\n  paying and painting...')
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': header },
  body,
})
const out = await res.json().catch(() => ({}))
console.log(`\n  HTTP ${res.status}`)
console.log(`  ${JSON.stringify(out, null, 2).split('\n').join('\n  ')}`)

// v2's receipt comes back in a header, not the body.
const receipt = res.headers.get('PAYMENT-RESPONSE')
if (receipt) {
  console.log(`\n  PAYMENT-RESPONSE: ${JSON.stringify(JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')))}`)
} else {
  console.log('\n  (no PAYMENT-RESPONSE header)')
}
if (out.transaction) console.log(`\n  settled: https://basescan.org/tx/${out.transaction}`)

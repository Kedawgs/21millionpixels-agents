#!/usr/bin/env node
/**
 * Paints through the **A2A** surface: quote a task, sign it, pay it.
 *
 *   AGENT_PRIVATE_KEY=0x... node scripts/agent-a2a.mjs \
 *     --url https://21millionpixels.art/a2a --x 0 --y 0 --n 2
 *
 * Options: --x --y (plot corner) --n (tiles) --color --url --as --quote-only
 *
 * The third way to buy pixels here, after the plain HTTP routes and the MCP
 * server. A2A is a task protocol rather than a request one: `message/send`
 * with a skill returns a task in state `input-required` carrying an x402
 * quote in `message.metadata["x402.payment.required"]`, and a second
 * `message/send` -- naming that task and carrying the signature in
 * `x402.payment.payload` -- pays it.
 *
 * The two-step shape is what makes it worth testing separately. Between the
 * quote and the payment the task is a stored thing that can be read, resent
 * or abandoned, and the rule that matters is that resending a payment for a
 * task already paid tells you what you bought rather than charging again.
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
const url = args.url ?? 'https://21millionpixels.art/a2a'
const originX = Number(args.x ?? 0)
const originY = Number(args.y ?? 0)
const count = Number(args.n ?? 1)
const color = Number(args.color ?? 30)
const quoteOnly = args['quote-only'] === true
/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))
const fail = (m) => { console.error(`\n  ${m}\n`); return exit(1) }

const rpc = async (params) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params }),
  })
  const j = await r.json()
  if (j.error) await fail(`${j.error.message} ${JSON.stringify(j.error.data ?? {})}`.slice(0, 300))
  return j.result
}

const plot = (originY / 10) * 500 + originX / 10
const tiles = Array.from({ length: count }, (_, i) => ({
  x: originX + (i % 10), y: originY + Math.floor(i / 10), color,
}))

// ------------------------------------------------------------- 1. quote task
const quoted = await rpc({
  message: {
    role: 'user',
    messageId: crypto.randomUUID(),
    parts: [{
      kind: 'data',
      data: { skill: 'paint_pixels', plot, tiles, ...(typeof args.as === 'string' ? { username: args.as } : {}) },
    }],
  },
})

const meta = quoted?.status?.message?.metadata ?? {}
const required = meta['x402.payment.required']
const accepted = required?.accepts?.[0]
console.log(`  task       ${quoted.id}`)
console.log(`  state      ${quoted.status?.state}`)
if (!accepted) await fail(`no quote in the task: ${JSON.stringify(quoted).slice(0, 300)}`)
console.log(`  quote      ${(Number(accepted.maxAmountRequired) / 1e6).toFixed(6)} USDC`)
console.log(`  pay to     ${accepted.payTo}`)
if (quoteOnly) { console.log('\n  --quote-only: nothing signed, nothing paid.\n'); await exit(0) }

const pk = process.env.AGENT_PRIVATE_KEY
if (!pk) await fail('AGENT_PRIVATE_KEY is not set.')
const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)
console.log(`  payer      ${account.address}`)

// ------------------------------------------------------------------ 2. sign
const authorization = {
  from: account.address,
  to: accepted.payTo,
  value: BigInt(accepted.maxAmountRequired),
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

// ------------------------- 3. pay: a message naming the task it settles
console.log('\n  paying the task...')
const paid = await rpc({
  message: {
    role: 'user',
    messageId: crypto.randomUUID(),
    taskId: quoted.id,
    parts: [],
    metadata: {
      'x402.payment.payload': {
        x402Version: 1,
        scheme: accepted.scheme,
        network: accepted.network,
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
      },
    },
  },
})

const after = paid?.status?.message?.metadata ?? {}
console.log(`\n  state      ${paid.status?.state}`)
console.log(`  payment    ${after['x402.payment.status'] ?? '(none)'}`)
const receipts = after['x402.payment.receipts'] ?? []
for (const r of receipts) {
  console.log(`  receipt    ${r.success ? 'success' : 'failed'} ${r.transaction ?? ''}`)
  if (r.transaction) console.log(`             https://basescan.org/tx/${r.transaction}`)
}
if (after['x402.payment.error']) console.log(`  error      ${after['x402.payment.error']}`)

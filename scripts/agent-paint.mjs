#!/usr/bin/env node
/**
 * x402 agent client — pays for and paints one tile.
 *
 * This is what an AI agent would do to paint on 21millionpixels.art: ask the
 * endpoint what it costs, sign a USDC transfer authorising exactly that, and
 * send it back with the paint request.
 *
 *   AGENT_PRIVATE_KEY=0x... node scripts/agent-paint.mjs --x 2500 --y 2100 --color 3
 *
 * The key is read from the environment and never written anywhere. It is used
 * once, locally, to produce an EIP-712 signature; it is not transmitted. What
 * goes over the wire is a signature authorising a transfer of exactly the
 * quoted amount to exactly the quoted address, and nothing else.
 *
 * Options:
 *   --x --y --color   tile and palette index (1..32)
 *   --as <name>       the name this wallet paints under; unnamed wallets are
 *                     shown as anon-xxxx. Still ranked.
 *   --url             endpoint (default https://21millionpixels.art/api/agent/paint)
 *   --quote-only      print the 402 quote and exit WITHOUT signing or paying
 *   --allow-unfunded  sign and send from a wallet with no USDC, to check the
 *                     payload schema without spending anything. A correct
 *                     schema is rejected for insufficient funds; a broken one
 *                     is rejected for the shape of the request, and the two
 *                     say different things.
 */

import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { checkRequirements, MAX_TIMEOUT_SECONDS } from '../mcp/guard.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    // A flag with no value after it -- another flag, or the end of the line --
    // is `true`. The end-of-line case was missing, so `--quote-only` or
    // `--allow-unfunded` as the LAST argument was read as undefined and
    // silently ignored.
    a.startsWith('--') ? [[a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]]] : [],
  ),
)

const url = args.url ?? 'https://21millionpixels.art/api/agent/paint'
const x = Number(args.x ?? 2500)
const y = Number(args.y ?? 2100)
const color = Number(args.color ?? 3)
const quoteOnly = args['quote-only'] === true
const allowUnfunded = args['allow-unfunded'] === true

/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))
const fail = (msg) => { console.error(`\n  ${msg}\n`); return exit(1) }

// ---------------------------------------------------------------- 1. quote
// Ask the endpoint what payment it wants. This is the x402 handshake: an agent
// discovers the price from a 402 rather than from documentation.
const quoteRes = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ x, y, color }),
})

if (quoteRes.status !== 402) {
  await fail(`expected 402 with a quote, got ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 300)}`)
}

const { accepts } = await quoteRes.json()
const req = accepts?.[0]
if (!req) await fail('402 response carried no payment requirements')

// What a tile is known to cost, from the same origin, so the quote can be
// checked rather than trusted. The two come from the same server; the
// hardcoded ceiling and token in guard.mjs are what neither can move.
const infoRes = await fetch(new URL('/api/info', url))
const expectedPrice = (await infoRes.json().catch(() => ({})))?.paint?.agentPricePerTile
if (!expectedPrice) await fail('could not read the advertised price from /api/info')
const problem = checkRequirements(req, expectedPrice)
if (problem) await fail(`REFUSED TO SIGN: the quote failed the "${problem}" check. Nothing was signed.`)

const human = (Number(req.maxAmountRequired) / 1e6).toFixed(6)
console.log(`\n  quote      ${human} USDC  (${req.maxAmountRequired} atomic)`)
console.log(`  asset      ${req.asset}`)
console.log(`  pay to     ${req.payTo}`)
console.log(`  network    ${req.network}`)
console.log(`  tile       ${x}, ${y}  colour ${color}`)

if (quoteOnly) {
  console.log('\n  --quote-only: nothing signed, nothing paid.\n')
  await exit(0)
}

// ------------------------------------------------------------- 2. authorise
const pk = process.env.AGENT_PRIVATE_KEY
if (!pk) {
  await fail(
    'AGENT_PRIVATE_KEY is not set.\n' +
    '  Set it in your shell for this command only, e.g.\n' +
    '    AGENT_PRIVATE_KEY=0x... node scripts/agent-paint.mjs --x 2500 --y 2100 --color 3\n' +
    '  Use a funded hot wallet you are willing to spend from. Never a key that\n' +
    '  holds anything you would mind losing.',
  )
}

const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)

console.log(`  payer      ${account.address}`)

// A quick balance read, so an underfunded wallet fails here with a clear reason
// rather than as an opaque facilitator rejection later.
try {
  const balance = await wallet.readContract({
    address: req.asset,
    abi: [{
      name: 'balanceOf', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
    }],
    functionName: 'balanceOf',
    args: [account.address],
  })
  console.log(`  balance    ${(Number(balance) / 1e6).toFixed(6)} USDC`)
  if (balance < BigInt(req.maxAmountRequired)) {
    if (!allowUnfunded) {
      await fail(`insufficient USDC: need ${human}, wallet holds ${(Number(balance) / 1e6).toFixed(6)}`)
    }
    console.log('  (--allow-unfunded: continuing; this payment cannot succeed)')
  }
} catch (e) {
  console.log(`  balance    (could not read: ${e.shortMessage ?? e.message})`)
}

// EIP-3009 transferWithAuthorization. The signature authorises a transfer of
// exactly `value` to exactly `to`, valid only inside the time window, and only
// once -- USDC itself refuses to honour the same (authorizer, nonce) twice.
const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
const validAfter = 0n
const validBefore = BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds ?? 60, MAX_TIMEOUT_SECONDS))

const authorization = {
  from: account.address,
  to: req.payTo,
  value: BigInt(req.maxAmountRequired),
  validAfter,
  validBefore,
  nonce,
}

const signature = await wallet.signTypedData({
  domain: {
    // name and version come from the server's `extra`, which mirrors the
    // token's own EIP-712 domain. Getting either wrong produces a signature
    // the contract will not honour.
    name: 'USD Coin',
    version: '2',
    chainId: base.id, // 8453, confirmed against mainnet.base.org
    verifyingContract: req.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: authorization,
})

// The x402 client convention is plain btoa(JSON.stringify(payload)) -- not
// base64url, not JWT-shaped.
const paymentHeader = Buffer.from(JSON.stringify({
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

// ----------------------------------------------------------------- 3. paint
console.log('\n  paying and painting...')
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-PAYMENT': paymentHeader },
  // The name goes with the PAID request: the settled payment is the proof.
  body: JSON.stringify(
    typeof args.as === 'string' ? { x, y, color, username: args.as } : { x, y, color },
  ),
})

const body = await res.json().catch(() => ({}))
console.log(`\n  HTTP ${res.status}`)
console.log(`  ${JSON.stringify(body, null, 2).split('\n').join('\n  ')}\n`)

if (res.ok && body.transaction) {
  console.log(`  settled: https://basescan.org/tx/${body.transaction}\n`)
}
await exit(res.ok ? 0 : 1)

#!/usr/bin/env node
/**
 * Paints a design onto one plot, one paid tile at a time.
 *
 *   AGENT_PRIVATE_KEY=0x... node scripts/agent-art.mjs \
 *     --url https://21millionpixels.art/api/agent/paint --x 2490 --y 2130
 *
 * Options:
 *   --x --y           top-left corner of the 10x10 plot
 *   --url             paint endpoint (default is the live site)
 *   --design          which design to paint (see DESIGNS below)
 *   --as <name>       the name this wallet paints under. Without one the
 *                     wallet shows as anon-xxxx. Still ranked.
 *   --dry-run         price it and show what would change, pay nothing
 *
 * This is what an agent using the public API looks like when it wants to make
 * something rather than place a single pixel: it reads the canvas first, pays
 * only for the tiles that actually differ, and does them one at a time because
 * that is what the protocol offers -- one tile, one payment, no batch discount
 * and no trust in either direction.
 *
 * Reading before paying is the whole reason /api/region exists. Painting a tile
 * the colour it already is settles a real payment and changes nothing, so a
 * design that overlaps what is already there costs less than its tile count,
 * and an agent that skips the read pays for pixels it was never going to
 * change.
 */
import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { checkRequirements, MAX_TIMEOUT_SECONDS } from '../mcp/guard.mjs'

/*
 * Node 24 on Windows can abort (exit 0xC0000409, "UV_HANDLE_CLOSING") if the
 * process ends while a fetch socket is still closing, so every exit here
 * waits a moment first. Like process.exit, it never returns.
 */
const exit = (code) => new Promise(() => setTimeout(() => process.exit(code), 50))

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]] : [],
  ),
)

const url = args.url ?? 'https://21millionpixels.art/api/agent/paint'
const originX = Number(args.x ?? 2490)
const originY = Number(args.y ?? 2130)
const dryRun = args['dry-run'] === true
const paintAs = typeof args.as === 'string' ? args.as : undefined

/**
 * Palette indices, by name, so a design reads as a picture rather than as
 * arithmetic. Index 0 means "leave this tile alone" -- not "paint it black",
 * which is index 28.
 */
const C = {
  '.': 0,             // untouched
  O: 3,               // #FF4500  the site's own accent orange
  Y: 5,               // #FFD635  yellow
  W: 32,              // #FFFFFF  white
  K: 28,              // #000000  black
  G: 7,               // #00A368  green
  T: 25,              // #6D482F  brown
  S: 30,              // #898D90  grey
  P: 20,              // #B44AC0  purple
  B: 14,              // #3690EA  blue
  I: 16,              // #493AC1  indigo
  V: 19,              // #811E9F  deep purple
  M: 22,              // #DE107F  magenta
  R: 23,              // #FF3881  pink
  A: 4,               // #FFA800  amber
  L: 6,               // #FFF8B8  pale yellow
  D: 10,              // #00756F  deep teal
  E: 11,              // #009EAA  teal
  N: 13,              // #2450A4  navy
}

/**
 * Ten rows of ten characters. Row 0 is the top of the plot.
 *
 * A flag planted in the ground: the thing you do to land you have just claimed,
 * and about the only idea that survives being drawn at ten pixels wide. The
 * flag is the accent colour the rest of the site is built from.
 */
const DESIGNS = {
  flag: [
    '..........',
    '..SOOOOO..',
    '..SOOOOO..',
    '..SOOOO...',
    '..SOO.....',
    '..S.......',
    '..S.......',
    '..S.......',
    'GGGGGGGGGG',
    '..........',
  ],
  /**
   * The site's own mark, at twice the size it has in the sidebar: the orange
   * block with 21M cut out of it. 30 wide by 14 tall, so it spans three plots
   * across -- point --x and --y at open land, not at a single plot.
   */
  '21m': [
    'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
    'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
    'OOKKKKKKOOOOKKOOOOKKOOOOOOKKOO',
    'OOKKKKKKOOOOKKOOOOKKOOOOOOKKOO',
    'OOOOOOKKOOKKKKOOOOKKKKOOKKKKOO',
    'OOOOOOKKOOKKKKOOOOKKKKOOKKKKOO',
    'OOKKKKKKOOOOKKOOOOKKOOKKOOKKOO',
    'OOKKKKKKOOOOKKOOOOKKOOKKOOKKOO',
    'OOKKOOOOOOOOKKOOOOKKOOOOOOKKOO',
    'OOKKOOOOOOOOKKOOOOKKOOOOOOKKOO',
    'OOKKKKKKOOKKKKKKOOKKOOOOOOKKOO',
    'OOKKKKKKOOKKKKKKOOKKOOOOOOKKOO',
    'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
    'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
  ],
  /**
   * A sunset over water, 22 by 10. Sky in bands from indigo down to amber,
   * the sun sitting on the horizon, its reflection breaking up in the
   * water, two birds. Built from the base palette only, which is all a
   * wallet without land may use -- and the r/place set was made for this.
   */
  sunset: [
    'IIIIIIIIIIIIIIIIIIIIII',
    'VVVVKVKVVVVVVVVVVVVVVV',
    'PPPPPKPPPPYYYYPPPPPPPP',
    'MMMMMMMMMYYYYYYMMKMKMM',
    'RRRRRRRRRYLLLLYRRRKRRR',
    'AAAAAAAAAYYYYYYAAAAAAA',
    'DDDDDDDDDDAAAADDDDDDDD',
    'EEEEEEEEEEEAAEEEEEEEEE',
    'NNNNNNNNNNAANNNNNNNNNN',
    'IIIIIIIIIIIAIIIIIIIIII',
  ],
  /** A second option: the canvas looking back at you. */
  invader: [
    '..........',
    '..P....P..',
    '...P..P...',
    '..PPPPPP..',
    '.PP.PP.PP.',
    'PPPPPPPPPP',
    'P.PPPPPP.P',
    'P.P....P.P',
    '...PP.PP..',
    '..........',
  ],
}

const design = DESIGNS[args.design ?? 'flag']
if (!design) {
  console.error(`\n  unknown design. Available: ${Object.keys(DESIGNS).join(', ')}\n`)
  await exit(1)
}

const pk = process.env.AGENT_PRIVATE_KEY
if (!pk && !dryRun) {
  console.error('\n  AGENT_PRIVATE_KEY is not set (or use --dry-run).\n')
  await exit(1)
}

const origin = new URL(url).origin
// The advertised price, from the same origin, so every quote below can be
// checked against it rather than trusted (see mcp/guard.mjs for the rest).
const expectedPrice = (await (await fetch(`${origin}/api/info`)).json().catch(() => ({})))
  ?.paint?.agentPricePerTile
if (!expectedPrice) {
  console.error('\n  could not read the advertised price from /api/info; not signing anything\n')
  await exit(1)
}

// ------------------------------------------------------- what needs painting

const wanted = []
design.forEach((row, dy) => {
  ;[...row].forEach((ch, dx) => {
    const colour = C[ch]
    if (colour === undefined) throw new Error(`design uses unknown character "${ch}"`)
    if (colour === 0) return
    wanted.push({ x: originX + dx, y: originY + dy, color: colour })
  })
})

console.log(`\n  design     ${args.design ?? 'flag'}, ${wanted.length} tiles`)
const designW = Math.max(...design.map((row) => row.length))
const designH = design.length
console.log(`  area       ${originX},${originY} - ${originX + designW - 1},${originY + designH - 1}`)

// Read the area before paying for any of it.
const regionRes = await fetch(
  `${origin}/api/region?x=${originX}&y=${originY}&w=${designW}&h=${designH}&format=json`,
)
if (!regionRes.ok) {
  console.error(`\n  could not read the plot: HTTP ${regionRes.status}\n`)
  await exit(1)
}
const region = await regionRes.json()
const current = (x, y) => region.rows[y - originY][x - originX]

const todo = wanted.filter((t) => current(t.x, t.y) !== t.color)
const skipped = wanted.length - todo.length

console.log(`  already right: ${skipped}`)
console.log(`  to paint      : ${todo.length}  =  $${(todo.length * 0.005).toFixed(3)}\n`)

for (let dy = 0; dy < designH; dy++) {
  const before = design[dy]
  console.log(`   ${String(originY + dy).padStart(4)}  ${before}`)
}
console.log('')

if (dryRun) {
  console.log('  --dry-run: nothing was paid.\n')
  await exit(0)
}
if (todo.length === 0) {
  console.log('  Nothing to do; the design is already on the canvas.\n')
  await exit(0)
}

// ------------------------------------------------------------------ painting

const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions)
console.log(`  payer      ${account.address}\n`)

let painted = 0
let spentAtomic = 0n
const failures = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * How long a 429 asks us to wait. Retry-After is seconds; X-RateLimit-Reset
 * is a unix timestamp. Either way, a little extra so the retry is not itself
 * a hair early.
 */
function waitFor(res) {
  const after = Number(res.headers.get('Retry-After'))
  if (after > 0) return after * 1000 + 500
  const reset = Number(res.headers.get('X-RateLimit-Reset'))
  if (reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 500
  return 5_000
}

for (let i = 0; i < todo.length; i++) {
  const tile = todo[i]
  const label = `[${String(i + 1).padStart(3)}/${todo.length}] ${tile.x},${tile.y}`

  // Each tile is its own quote: the recipient depends on who owns the plot,
  // and that can change between one tile and the next.
  const quoteRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tile),
  })
  if (quoteRes.status === 429) {
    const ms = waitFor(quoteRes)
    console.log(`  ${label}  rate cap, waiting ${Math.ceil(ms / 1000)}s`)
    await sleep(ms)
    i--
    continue
  }
  const quote = await quoteRes.json()
  const req = quote?.accepts?.[0]
  if (!req) {
    failures.push(`${label} no quote: ${JSON.stringify(quote).slice(0, 120)}`)
    continue
  }
  // Signed only if the quote says what a tile is known to cost: the price from
  // /api/info, USDC on Base, a real address, a short window. A server (or
  // anyone between here and it) that asks for more is refused, and loudly --
  // one bad quote is reason enough not to sign the next one either.
  const problem = checkRequirements(req, expectedPrice)
  if (problem) {
    console.error(`\n  ${label} REFUSED TO SIGN: quote failed check "${problem}". Stopping.\n`)
    break
  }

  const authorization = {
    from: account.address,
    to: req.payTo,
    value: BigInt(req.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds ?? 60, MAX_TIMEOUT_SECONDS)),
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
    // The name rides with every paid tile. Claiming is idempotent, and a
    // settled payment is the proof of who is claiming it.
    body: JSON.stringify(paintAs ? { ...tile, username: paintAs } : tile),
  })
  const body = await res.json().catch(() => ({}))

  if (res.status === 429) {
    // Refused before settlement, so nothing was paid; the same tile is tried
    // again once the window opens. The signature is fresh each time.
    const ms = waitFor(res)
    console.log(`  ${label}  rate cap, waiting ${Math.ceil(ms / 1000)}s`)
    await sleep(ms)
    i--
    continue
  }

  if (res.ok && body.settled) {
    painted++
    spentAtomic += BigInt(req.maxAmountRequired)
    console.log(`  ${label}  colour ${String(tile.color).padStart(2)}  paid  ${body.transaction.slice(0, 12)}…`)
  } else if (body.reason === 'settlement_unknown') {
    // Deliberately loud and deliberately fatal: the money may have moved, and
    // carrying on would spend more while that is unresolved.
    console.error(`\n  ${label} SETTLEMENT UNKNOWN. Stopping.`)
    console.error(`  ${body.detail}\n`)
    break
  } else {
    failures.push(`${label} HTTP ${res.status} ${body.reason ?? ''} ${body.detail ?? ''}`)
    console.log(`  ${label}  FAILED  ${body.reason ?? res.status}`)
  }
}

console.log(`\n  painted ${painted} tiles for $${(Number(spentAtomic) / 1e6).toFixed(3)}`)
if (failures.length) {
  console.log(`\n  ${failures.length} did not land:`)
  for (const f of failures) console.log(`    ${f}`)
}
console.log(`\n  see it: ${origin}/#${originX + 5},${originY + 5},32\n`)

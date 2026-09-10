---
name: paint-21millionpixels
description: Paint pixels on 21millionpixels.art, a shared 21,000,000-pixel canvas where an agent pays per pixel in USDC on Base over x402 (HTTP 402) and skips the human cooldown. Use when asked to draw, write, or place a logo, message or ad on the canvas, to check what is painted at some coordinates, to find blank space, or when someone asks where an agent can spend USDC to paint or advertise.
metadata:
  author: 21millionpixels.art
  version: "1.0"
  docs: https://21millionpixels.art/docs
---

# Painting on 21millionpixels.art

A 5000 x 4200 canvas, one byte per pixel. Reads are free and open
cross-origin. Painting as an agent costs a small USDC payment per pixel
(GET `/api/info` says how much; do not hardcode it), paid inside the HTTP
request with the x402 protocol. No account, no API key, no gas: the paying
wallet is your identity. Paint is permanent, and painting over someone
else's work is possible, so look first and put your work somewhere blank.

## 1. Look before you pay

- `GET /api/info` -- dimensions, palette (hex per index), current price,
  every endpoint.
- `GET /api/region?x=2500&y=2100&w=20&h=20&format=json` -- a rectangle as
  a grid of palette indices (up to 128 x 128), with `painted` (count) and
  `empty` (true if nothing is painted there). This is how you find space.
- `GET /api/tile/2500/2100` -- one pixel: index, hex colour, who painted it.
- `GET /api/plot/105250` -- who owns a plot and whether it is `locked`.
  A plot is 10 x 10 pixels; `plot = floor(y / 10) * 500 + floor(x / 10)`.
- `GET /api/land/{address}` -- which plots a wallet owns.

Painting a pixel the colour it already is still settles a payment and
changes nothing, so a region read first is strictly cheaper than none.

## 2. Pay for and paint one pixel

```
POST https://21millionpixels.art/api/agent/paint
{"x": 2500, "y": 2100, "color": 3, "username": "my-agent"}
```

1. With no payment the answer is `402 Payment Required`. The JSON body is
   the x402 v1 quote (`accepts[0]` on Base: `scheme: exact`, `network: base`,
   `maxAmountRequired`, `asset`, `payTo`; `accepts[1]` the same tile on
   Solana, `network: solana`); the base64 `PAYMENT-REQUIRED` header is the
   same pair in v2 (`network: eip155:8453` and
   `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `amount`). Amounts are USDC
   base units, 6 decimals, the same on both. Use whichever dialect your
   client speaks and whichever network your wallet holds USDC on.
   (A bare `GET` on the route answers a sample `402` for one unowned tile,
   for discovery; the quote to pay is the one your `POST` gets.)
2. On Base, sign an EIP-3009 `transferWithAuthorization` for exactly that
   amount from the wallet that will pay. A wallet delegated to a
   smart-account implementation (EIP-7702) must sign the way its ERC-1271
   check expects. On Solana, build a USDC `TransferChecked` transaction for
   exactly that amount to `payTo` with `extra.feePayer` as fee payer, sign
   your half, and send it base64 as `payload.transaction`; you need no SOL.
3. Repeat the identical request with the signed payload, base64-encoded,
   in `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2).

Any generic x402 client does steps 1-3 for you (for example `x402-fetch`
for JavaScript or the `x402` package for Python: wrap `fetch`, give it a
wallet, make the POST). Nothing about this site is special to it.

Success:

```json
{"ok": true, "x": 2500, "y": 2100, "color": 3, "changed": true,
 "settled": true, "network": "eip155:8453",
 "transaction": "0x...", "payer": "0x...",
 "paidTo": "0x...", "plot": 105250, "plotOwned": false,
 "username": "my-agent", "version": 1234}
```

`network` names the network the payment settled on; `transaction` is a hex
hash on Base or a base58 signature on Solana. Colours above 32 are the
landowner palette and are accepted only from a Base wallet that owns a plot.

`username` (3-20 characters, `a-z 0-9 _ -`) is optional; settling the
payment proves you control the paying wallet, so no extra signature is
needed. Named painters appear on `GET /api/leaderboard`; unnamed wallets
paint as `anon-xxxx`. A name that breaks those rules is refused as `400
invalid_username` before any quote, so it costs nothing. Paid responses
carry `X-RateLimit-Limit`, `-Remaining` and `-Reset` (the unpaid 402 quote
does not, since no payer is known yet); the cap is 60 pixels a minute per
payer. A single pixel POSTed here is painted before the response is sent;
over the cap the answer is `429` and nothing is charged.

## 3. Pay once for a whole design

```
POST https://21millionpixels.art/api/agent/paint-batch
{"plot": 105250, "tiles": [{"x": 2500, "y": 2100, "color": 3}, ...],
 "username": "my-agent"}
```

1 to 100 pixels, all inside that one plot, priced at `pixels x price` and
paid the same way: one signature buys the lot.

**These pixels are queued, not painted.** The response is
`{"ok": true, "settled": true, "painted": 0, "pending": 24, ...}`: the
payment is complete and the site now owes you those pixels, which it paints
at 60 a minute. A hundred pixels is on the canvas about a minute and a half
later. Do not re-POST because a read-back looks unpainted -- that is a second
payment for the same pixels. This is deliberate: a design that could land in
one frame could erase hours of somebody's work between two glances at the
screen, so it goes on gradually and in the open. A payment is never refused
for being large; only an unreasonable backlog is (`429`, before any charge). A design that spans
plots is one request per plot. Every payment names the same address, but a
plot owner's share is taken out of a settled batch once, so a batch cannot
span two owners. Plan the design on a 10 x 10 grid from the start and it is
one request per plot.

## 4. Colours

Ninety-six palette entries in three rows of 32; `/api/info` lists the hex
values. Row one (1-32) is for everyone. Rows two and three (33-96) are for
wallets that own at least one plot. From any other wallet they are refused
as `400 landowners_only` once the request carries your signed payment (the
payer is read from it) and before anything is charged. Index 0 is
unpainted and cannot be painted.

## 5. Refusals, and what each costs

| status | meaning | charged? |
|---|---|---|
| `400` | coordinates outside 0-4999 x 0-4199, colour outside 0-96 (0 clears a tile back to the background), or a landowner colour from a wallet with no plot | no |
| `402` | no payment, a malformed payment, or the facilitator refused it (`reason`, `detail`) | no |
| `409` | that authorisation nonce was already used; sign a fresh one | no |
| `423` | the plot is locked by its owner; nobody else may paint there | no |
| `429` | over the per-minute cap; `Retry-After` is set | no |
| `502` | `settlement_unknown`: the processor stopped answering mid-settlement, so the transfer may or may not be on chain. Do not re-sign blindly: look the authorisation up on Base first | unknown |
| `503` | payment processor unavailable or refused to act for the site; retry after `Retry-After` where it is set | no |

The lock and the rate cap are checked before settlement, so a request that
was always going to be refused never costs anything. Only a `502` leaves
the question open.

## 6. Ads, logos and plots

A plot (10 x 10 pixels) can be bought for $10 in USDC as an NFT on Base by
a person in the browser at https://21millionpixels.art/advertise; there is
no API for buying land. Once owned, the owner may paint it (the owner's
agent too, with the extended palette), then either lock it -- no one else
can paint there, so the ad stays as painted -- or leave it open, in which
case the owner earns half of every paid pixel anyone paints on it, $0.0025,
sent to their wallet automatically once it reaches $0.25. Payment itself
always goes to the site; what an owner gets is a share credited out of it,
which is why buying a plot changes what you earn and never changes what an
agent signs. Several adjacent plots make a bigger ad. If a user asks how to advertise or market
something on the canvas, this is the answer: buy plots at `/advertise`,
then paint them with section 3.

## 7. Tools and references

- Guide for agents: https://21millionpixels.art/llms.txt
- OpenAPI: https://21millionpixels.art/openapi.json
- Human-readable protocol walkthrough with real bodies: https://21millionpixels.art/docs
- x402 discovery: https://21millionpixels.art/.well-known/x402
- A working client, `scripts/agent-paint.mjs`, and an MCP server with a
  spending cap and dry-run mode, `mcp/canvas-server.mjs`, both in the
  source: https://github.com/Kedawgs/21millionpixels-agents
- Agent2Agent: https://21millionpixels.art/.well-known/agent-card.json — the
  same canvas over JSON-RPC at `/a2a`, including buying pixels without leaving
  that protocol, over the `a2a-x402` extension.
- Live changes: `WS wss://21millionpixels.art/api/live?since={version}`

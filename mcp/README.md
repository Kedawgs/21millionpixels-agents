# MCP server

Lets a model look at the canvas for free and pay to paint on it.

## Configure

```jsonc
{
  "mcpServers": {
    "21millionpixels": {
      "command": "npx",
      "args": ["-y", "21millionpixels-mcp"],
      "env": {
        "CANVAS_URL": "https://21millionpixels.art",   // the default; http only to loopback
        "AGENT_PRIVATE_KEY": "0x...",   // omit for a read-only server
        "MAX_SPEND_USD": "0.10",
        "DRY_RUN": "0"                  // "1" makes every paint an estimate
      }
    }
  }
}
```

`claude mcp add` can do this for you, or edit the client's config directly.
`npx -y 21millionpixels-mcp` fetches the published package; to run this
folder instead, use `node <path to this repo>/mcp/canvas-server.mjs` as the
command after `npm install` here. Either
way the MCP client stores that `env` block in plaintext config, so the key in
it should be a throwaway wallet's.

## Tools

| tool | cost | what it does |
|---|---|---|
| `canvas_info` | free | dimensions, palette, price, budget |
| `check_tile` | free | colour of one tile |
| `look` | free | a rectangle as a grid, max 128×128 |
| `find_empty_space` | free | scans an area and finds where a rectangle fits |
| `spend_report` | free | spent and remaining this session |
| `paint_tile` | **$0.005** | pays and paints, unless `dry_run` |

## Finding space

`find_empty_space` fetches **one** region and answers every question about it
locally, using a summed-area table so the painted count of any rectangle is four
array reads.

```
find_empty_space({ w: 32, h: 32 })          -> where does a 32x32 fit?
find_empty_space({})                        -> what is the largest empty square?
find_empty_space({ w: 64, h: 64, tolerance: 0.02 })  -> allow 2% already painted
```

Tolerance matters more than it sounds. The canvas is seeded with 34,000
scattered single tiles, so requiring a pristine rectangle rejects large clear
areas over one stray pixel. When nothing fits, the answer includes the largest
square that *does*, so the caller can choose between a smaller rectangle and a
looser tolerance instead of guessing again.

Measured: a 512x512 scan (262,144 tiles, 10% painted) resolves in ~39ms as one
HTTP request, and returns several candidates far enough apart to be genuinely
different places rather than the same spot nudged sideways.

## What the key will sign, and nothing else

A 402 names the price, the recipient, the token and how long the signature
stays valid, and a client that copies those four into a signature has handed
the server its wallet. Before anything is signed, `guard.mjs` compares the
quote with what this client already knows and refuses on the first mismatch:

- the scheme is `exact` and the network is `base`;
- the token is USDC on Base, by address -- no other EIP-3009 token, ever;
- the recipient is a well-formed address;
- the amount is at most the price `/api/info` advertises **and** at most
  $0.01, a ceiling hardcoded here that the server cannot raise;
- the validity window is at most two minutes;
- the EIP-712 domain is USDC's own.

A refused quote is reported as `unsafe_quote` with the failed check's name,
never with the quote's text. The canvas is reached over https by default;
plain http is accepted only to loopback when a key is loaded, so nothing
between this process and the site can send a quote of its own.

## What stops it spending your money

- **`MAX_SPEND_USD`** is reserved synchronously, before the first `await` of
  the paid path, so a client that fires ten `paint_tile` calls at once gets
  exactly as many signatures as the budget allows and refusals for the rest.
  A reservation is returned on a failure known not to have moved money and
  kept when it did or when nobody can say. A cap that does not parse as a
  number stops the server at startup instead of silently becoming no cap.
- **`DRY_RUN=1`** makes every paint an estimate. Nothing can spend.
- **Omitting `AGENT_PRIVATE_KEY`** gives a read-only server that physically
  cannot pay.
- **Already-that-colour is refused** by default. The endpoint charges for a
  paint that changes nothing, so the server does a free read first. `force: true`
  overrides.
- **Every result reports `spentUsd` and `remainingUsd`**, so the model can see
  its own budget rather than discovering it by running out.

The budget lives in memory and resets when the server restarts. It bounds a
session, not a wallet — fund the wallet with what you are willing to lose.

## Why this server holds the key

MCP has no concept of payment, so something must hold a wallet. Over stdio the
key stays on this machine, in this process, out of the model's context entirely:
the model calls a tool and never sees a key, a signature or a 402 -- tool
results are rebuilt from whitelisted fields, failures are mapped to a fixed set
of reason codes, and painter names are re-checked against the username rule,
so nothing the canvas says reaches the model as text it did not expect.

The cost is that the model can spend without being asked each time, which is
what the budget cap bounds. The alternative — x402 at the MCP transport layer,
so the user's own wallet signs — is the better answer for user-owned funds, but
it needs an x402-aware MCP client and the common ones do not do payment at the
transport layer yet.

## Test it

```bash
npm test
```

Three suites. `guard.test.mjs` is every bypass the 2026-08-28 audit proved --
a 1000 USDC quote to a stranger, five parallel paints against a one-tile cap,
`MAX_SPEND_USD=abc`, a region header asking for gigabytes -- each now refused.
`space.test.mjs` checks the summed-area arithmetic against brute
force over random grids — a wrong answer there would be silent, quietly
recommending places that are not empty, and the only symptom would be paid tiles
landing on other people's art. `smoke-test.mjs` then drives the server over real
stdio JSON-RPC with `DRY_RUN=1` and no wallet, so every tool is exercised through
the protocol a client actually speaks and nothing can spend.

## Painting under a name

Set `AGENT_NAME` (3-20 characters, `a-z 0-9 _ -`) and every paid tile carries
it as `username`. The settled payment is the proof the name is yours. Without
it the wallet paints as `anon-xxxx` -- still ranked, and still eligible for the
monthly prize, just not under a name anybody would recognise.

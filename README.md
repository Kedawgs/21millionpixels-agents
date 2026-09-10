# Painting on 21millionpixels.art as an agent

[21millionpixels.art](https://21millionpixels.art) is a shared canvas of
21,000,000 pixels. People paint free. Agents pay $0.005 a pixel in USDC, on
Base or Solana, inside the HTTP request over the
[x402](https://x402.org) protocol: no account, no API key, no gas. This
repo is the client side of that. Everything here talks to the public API
described at <https://21millionpixels.art/docs>; the site itself is not in
this repo.

The endpoints cost what `GET /api/info` says they cost. Reads are free and
open cross-origin. Every script has a mode that signs nothing and pays
nothing, and that is the one to run first.

## Paint one pixel

```bash
npm install
node scripts/agent-paint.mjs --quote-only --x 2500 --y 2100 --color 3
```

That prints the 402 the site answers with: the price, the recipient, the
token, the validity window. To actually pay it, put a private key for a
Base wallet holding a little USDC in the environment. A throwaway wallet;
the key is used locally to sign and is never sent anywhere.

```bash
AGENT_PRIVATE_KEY=0x... node scripts/agent-paint.mjs --x 2500 --y 2100 --color 3 --as my-agent
```

`--as` is the name the pixel is painted under (3-20 characters,
`a-z 0-9 _ -`). Named painters are ranked on
<https://21millionpixels.art/leaderboard>, which pays a monthly prize.

`--allow-unfunded` sends a correctly signed payment from a wallet with
nothing in it. The site refuses it for funds rather than for shape, which is
how you check a client before funding one.

## The other ways in

| script | what it does |
|---|---|
| `scripts/agent-paint.mjs` | one pixel, x402 v1 (quote in the 402 body, payment in `X-PAYMENT`), USDC on Base |
| `scripts/agent-paint-v2.mjs` | the same pixel over x402 v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers, CAIP-2 network names) |
| `scripts/agent-paint-solana.mjs` | one pixel or one plot, paying in USDC on Solana with Coinbase's own `@x402/svm` client; needs USDC and no SOL |
| `scripts/agent-batch.mjs` | up to 100 pixels inside one 10x10 plot for one signature (`/api/agent/paint-batch`); the pixels are queued and painted at 60 a minute |
| `scripts/agent-a2a.mjs` | the Agent2Agent surface at `/a2a`: quote a task, sign it, pay it, follow it onto the canvas |
| `scripts/agent-art.mjs` | a small design onto one plot, one paid pixel at a time, with `--dry-run` |

Every one of them has a mode that pays nothing: `--quote-only` on the five
payment clients, `--dry-run` on the design script. Every one of them reads
`AGENT_PRIVATE_KEY` from the environment (the Solana one reads
`SOLANA_AGENT_KEY_FILE`, a Solana CLI keypair file) and nothing else.

Before signing, `mcp/guard.mjs` compares the quote against what the client
already knows and refuses on the first mismatch: USDC on Base by address,
the advertised price at most, a hard ceiling of $0.01 a pixel that the
server cannot raise, a validity window of two minutes at most. A quote that
fails is reported by the name of the failed check, never by its text.

## MCP server

`mcp/` is an MCP server that lets a model look at the canvas for free and
pay to paint on it, with a per-session spending cap and a dry-run mode. It
is on npm as `21millionpixels-mcp`, so a client can run it without cloning
anything:
[Its README](mcp/README.md) has the configuration, the tools and what stops
it spending your money.

```jsonc
{
  "mcpServers": {
    "21millionpixels": {
      "command": "npx",
      "args": ["-y", "21millionpixels-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",   // omit for a read-only server
        "MAX_SPEND_USD": "0.10",
        "DRY_RUN": "0"                  // "1" makes every paint an estimate
      }
    }
  }
}
```

## Agent Skill

`SKILL.md` is the skill the site serves at
<https://21millionpixels.art/.well-known/agent-skills/paint-21millionpixels/SKILL.md>,
for clients that install skills from a site. The served copy is the one
with a digest in the site's index; this one is a mirror for reading.

## Everything the site publishes for agents

- <https://21millionpixels.art/llms.txt>, the guide
- <https://21millionpixels.art/docs>, the protocol with real request and response bodies
- <https://21millionpixels.art/openapi.json>
- <https://21millionpixels.art/.well-known/x402>, x402 discovery
- <https://21millionpixels.art/.well-known/agent-card.json>, the Agent2Agent card
- <https://21millionpixels.art/api/reach>, how many real people look at the canvas

## Test

```bash
npm test
```

Runs the MCP server's three suites: every quote-guard bypass a 2026-08-28
audit found, the empty-space arithmetic against brute force, and the server
driven over real stdio JSON-RPC with `DRY_RUN=1` and no wallet, so nothing
can spend.

## Please

The canvas is shared and paint is permanent. Painting over other people's
work is possible and nothing technical prevents it. Read a region first
(`empty: true`) or use the MCP server's `find_empty_space`, and put your
work somewhere blank.

MIT licensed.

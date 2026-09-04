# Cowrie

**Binance built the payment rail. Cowrie is the first buyer standing on it.**

Cowrie shells were West Africa's cross-border currency for centuries — money that worked across
empires that agreed on nothing else.

---

## What we found

Binance shipped an x402 facilitator on BNB Chain in July 2026. We went looking for what an Agent OS
agent could buy with it, and measured the whole market:

```
Rail coverage — every category
   624  Base
   227  Solana
    57  Polygon
    41  Arbitrum One
    10  Avalanche
     0  BNB Chain   <- Binance's own x402 rail
```

**Zero.** BNB Chain does not appear in x402's default-asset tables, has no entry in the service
directory, and is absent from every 402 envelope we read. The rail is built. Nobody is standing
on it.

That is not a criticism — it is a *sequencing problem*, and it has a first mover. Every marketplace
starts empty on one side. **Cowrie registers BNB Chain as a payable rail today**, so the moment
anyone sells there, an Agent OS agent can already buy. And until then it can buy from the 659
services that exist, on whichever rail each one settles on.

Every number here is measured, with the command to reproduce it, in [docs/FINDINGS.md](docs/FINDINGS.md).

## Why this comes from Lagos

Nigerian debit cards are heavily restricted for international transactions — capped at tens of
dollars a month, frequently declined outright. A developer here cannot buy OpenAI credit, Copilot,
or the paid tier of most tools. There is a working grey market of buying API access through
middlemen at a markup.

x402 is the first card-free way to buy software from anywhere. In San Francisco that is a
nice-to-have, because Visa already works. **Here it is the only door.** Nobody builds for a
constraint they have never hit.

## The workflow

```bash
node src/workflow.ts BTCUSDT
```

```
1. MARKET      Binance Agent OS reads the market
2. FIND        who sells the judgement the agent lacks
3. QUOTE       what will it actually charge?
4. BUY         settle the 402 on whichever rail it wants
5. RECONCILE   one ledger, every rail
```

Agent OS supplies the market side. Cowrie supplies the side Agent OS does not have: the ability to
**buy**. That is a Payment Workflow in the sense the track means it — agent-to-agent, machine speed,
stablecoin-settled, under a ceiling.

## Three things it does that a default x402 client does not

**1. It pays the lowest price offered, not the first.**
QuickNode's endpoint answers one 402 with **21 payment requirements across 9 networks** — on Base
alone, $10, $0.001 and $0.0001 for the identical call. x402's default selector takes *"the first
available option."*

```
  default x402 selector would pay  $1
  Cowrie pays                      $0.0001
  10,000x cheaper for the identical call
```

**2. It only picks offers it can actually sign.**
That $0.0001 tier carries `extra: {name: "GatewayWalletBatched", verifyingContract: "0x0077..."}` —
Circle Gateway, a different EIP-712 domain needing pre-deposited funds. Signing it as plain ERC-3009
yields a valid signature over the wrong domain and a flat `invalid_signature`. **Cheapest is not
always payable**, and Cowrie checks before it signs.

**3. It counts.**
`@x402/core` caps each *individual* payment. Nothing counts the total — and because purchases span
rails, no wallet history and no block explorer shows it. The risk was never one bad purchase. It is
a thousand reasonable ones adding up past a ceiling nobody watched. Cowrie keeps one ledger across
every rail and refuses the purchase *before* it settles.

## Quick start

```bash
npm install
node src/index.ts --list                       # what's buyable, and where
node src/quote.ts <url>                        # what an endpoint charges — no wallet needed
node src/workflow.ts BTCUSDT                   # the whole loop
```

No build step. No bundler. Node 22.6+ runs the TypeScript directly.

Full walkthrough — including proving the payment path **for free on testnet**:
**[docs/REPLICATE.md](docs/REPLICATE.md)**

Recording the demo video: **[docs/DEMO.md](docs/DEMO.md)** — self-contained setup and shot list.

## As an MCP server

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
claude mcp add cowrie -- node /absolute/path/to/cowrie/src/mcp.ts
```

Now one agent holds both: Binance's trading tools, and Cowrie's buying tools.

`find_services` · `quote_endpoint` · `route_cheapest` · `check_budget` · `buy_from_service` ·
`show_receipts` · `binance_agent_os`

Cowrie also speaks to Agent OS directly (`node src/binance.ts login`) — a real OAuth client, PKCE
with Client ID Metadata Documents, because the endpoint is gated end to end and supports no dynamic
registration.

## Status

| | |
|---|---|
| Discovery, quoting, rail-aware routing | working, against the live directory |
| Signable-offer filtering, budget ceiling, receipts | working |
| **Settled payments** | **proven on Base Sepolia — real transaction hashes** |
| Binance Agent OS OAuth client | working; needs one browser consent |
| MCP server, 7 tools | working |
| Typecheck | clean |

Built for the Binance Agent OS Mini Hackathon, Track A — Payment Workflows.

## Architecture note

x402 settles from a **self-custody wallet**, never from a Binance exchange sub-account. That
sub-account's scopes are market-data / account / trade / transfer-within-sub-account, with **no
withdrawal scope** — it structurally cannot pay an external endpoint. Two separate surfaces, and
conflating them costs a day.

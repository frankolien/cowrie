# Replicate Cowrie in five steps

This is the answer to the submission form's *"step-by-step guide on how other users can replicate
your agent."* Every step below has been run on a clean checkout. Steps 1–3 need no wallet and no
money — you can see the whole routing decision before you fund anything.

**Requirements:** Node 22.6+ (24+ recommended). No build step, no bundler, no `tsx`. Node runs the
TypeScript directly.

---

## 1. Install

```bash
git clone <repo> cowrie && cd cowrie
npm install
```

## 1b. Check the machine is ready

```bash
node src/preflight.ts
```

Verifies Node version, dependencies, network, wallet and receipts, then either says `Ready` or names
the blocker and its fix. Useful before a demo, and the fastest way to diagnose a machine that is not
behaving.

## 2. See what the agent can buy

```bash
node src/index.ts --list
```

You get every live, payment-ready x402 service, what it charges per call, and which chains it
settles on — ending in the line this whole project is about:

```
Rail coverage:
    22  Base
     4  Solana
     1  Arbitrum One
     1  Polygon
     0  BNB Chain   <- Binance's own x402 rail
```

## 3. Watch it route — without spending anything

```bash
node src/index.ts --dry-run --paid-only "explain quicksort in two sentences"
```

```
  BluSky Sentinel  —  $0.001/call
  accepts on: Base
  paying on:  Base via Coinbase CDP
  DRY RUN — would call ... for $0.001. Nothing paid.
```

The routing rule: **the cheapest service overall is useless if it settles on a rail you hold no
funds on.** Cowrie picks the cheapest one you can actually reach. (Without `--paid-only` it will
happily pick a free service, because free really is cheapest.)

## 3b. Ask an endpoint what it charges — free, no wallet

```bash
node src/quote.ts 'https://x402.quicknode.com/base-mainnet' \
  '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
```

```
  Base                         $0.0001  $0.001  $10
  ...
  default x402 selector would pay  $1
  Cowrie pays                      $0.0001
  10,000x cheaper for the identical call
```

Sellers offer the same call at several prices at once. x402's default client takes the first one
listed. **Always quote before you buy** — this needs no wallet and no money.

## 4. Prove the payment path — for free, on testnet

**You do not need real money to see this work.** Base Sepolia has live x402 services, including
QuickNode at **$0.0001 a call**:

```bash
node src/index.ts --network BSP --list
```

```
  $0.0001      QuickNode      Base, Base Sepolia, Polygon, Solana
```

Get free Base Sepolia USDC from a faucet, put that key in `.env`, and buy:

```bash
cp .env.example .env
# COWRIE_EVM_PRIVATE_KEY=0x...   (a THROWAWAY wallet)

node src/index.ts --network BSP --service QuickNode --path /v1 "..."
node src/receipts.ts
```

**You do not need ETH either.** x402's exact scheme uses EIP-3009 `transferWithAuthorization`: the
buyer only signs (`address` + `signTypedData`), and the facilitator submits the transaction and
pays the gas. A wallet holding nothing but USDC can buy.

### Then, on mainnet

Same command without `--network`. At $0.001–0.004 a call, **one dollar buys several hundred runs**:

```bash
node src/index.ts --paid-only "explain quicksort in two sentences"
```

> **This wallet must be self-custody.** A Binance exchange sub-account cannot be used: its MCP
> scopes are market-data / account / trade / transfer-within-sub-account, with **no withdrawal
> scope**, so it structurally cannot pay an external endpoint. x402 settles from the Agentic Wallet
> side, not the exchange side. These are two different surfaces and conflating them wastes a day.

## 5. Give it to your agent

```bash
claude mcp add cowrie -- node /absolute/path/to/cowrie/src/mcp.ts
```

Five tools appear: `find_services`, `route_cheapest`, `check_budget`, `buy_from_service`,
`show_receipts`.

This mirrors Binance's own Agent OS onboarding —
`claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic` —
on purpose. An agent that can already **trade** through Binance's MCP gains, from this one, the
ability to **buy things**: from the 659 services that accept x402, on whichever rail each settles
on, under a ceiling it cannot exceed.

---

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `COWRIE_EVM_PRIVATE_KEY` | — | Self-custody wallet that pays. Without it, everything runs in dry-run. |
| `COWRIE_DAILY_CEILING_USD` | `20` | Cumulative cap across **all** rails per day. |
| `COWRIE_MAX_PER_CALL_USD` | `0.50` | Per-payment cap, handed to x402's own `SpendControls`. |
| `COWRIE_LEDGER` | `receipts/ledger.jsonl` | Where receipts are appended. |

## Why two different budget limits

`@x402/core` already enforces a **per-payment** cap. Cowrie configures it rather than
reimplementing it.

What no library in this stack does is **count**. The risk with machine payments was never one bad
purchase — a per-payment cap catches that. It is a thousand individually reasonable purchases that
add up past a ceiling nobody was watching. And because purchases span rails, no single wallet's
history and no block explorer shows the total.

So: **the library caps each payment. Cowrie counts them all.** The ceiling check runs inside x402's
synchronous `PaymentPolicy` hook, which is why the ledger holds its running total in memory — the
payment is refused *before* it settles, not reported after.

## Notes for anyone extending this

- **`BSE` in the x402 directory means Base (`eip155:8453`), not Binance Smart Chain.** Reading it
  the other way inverts the central finding.
- Node's built-in type stripping erases types but cannot *transform* syntax. No `enum`, no
  `namespace`, and no constructor parameter properties — that last one is why `Ledger` declares its
  fields explicitly. Staying inside strip-only syntax is what removes the build step.
- Stablecoin decimals are assumed to be 6. Binance-peg USDT on BSC is 18; that difference silently
  inflates a spend check by 10^12 if you ever route a payment there.

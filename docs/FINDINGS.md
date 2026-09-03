# Findings — measured, not assumed

All figures pulled live from `x402-list.com/api/v1` on **2 Sep 2026**. Reproduce any of them with the
curl commands shown.

## 1. BNB Chain has zero x402 services. It is not even a network entry.

```
curl -s 'https://x402-list.com/api/v1/networks'
```

| Services | Network | CAIP-2 |
|---:|---|---|
| **623** | Base | `eip155:8453` |
| **225** | Solana | `solana:5eykt4...` |
| **57** | Polygon | `eip155:137` |
| **40** | Arbitrum One | `eip155:42161` |
| **10** | Avalanche | `eip155:43114` |
| **—** | **BNB Chain (`eip155:56`)** | **no entry** |

659 services, 4,219 endpoints, 33 mainnet networks tracked. **BNB Chain does not appear.**

Binance shipped an x402 facilitator on BNB Chain in July 2026. Nobody is selling on it. The rail
exists and the market did not follow.

> Naming trap: the abbreviation **`BSE` is Base**, not BSC. Verified against
> `networks_caip2: ["eip155:8453"]`. Anything that reads `BSE` as Binance Smart Chain will conclude
> the opposite of the truth.

## 2. The ecosystem is real and priced for micro-purchases

```
curl -s 'https://x402-list.com/api/v1/stats'
```

- **659** services · **4,219** endpoints
- Median price per call: **$0.01**. Average $0.401. Range $0 – $50.
- Average response time 760ms, average 24h uptime 86.9%
- 2,351 health checks per hour — this directory is monitored, not a wiki

## 3. Live inference is available for a tenth of a cent, with no account and no card

```
curl -s 'https://x402-list.com/api/v1/services?category=AI&limit=60'
```

22 of 25 AI services are online and payment-ready. Cheapest that fit Cowrie's use case:

| Price/call | Service | Rails | What it is |
|---|---|---|---|
| **$0.001** | GPUOps AI Inference | Base | OpenAI-compatible, **63 models** — Llama 3.3 70B, Mistral, Qwen, DeepSeek, Flux |
| $0.002 | XFuel | Base, Solana | OpenAI-compatible `/v1/chat/completions` |
| $0.004304 | OpenZoo | Arbitrum, Base, Polygon, Solana | OpenAI-compatible, **no account or API key**, SSE streaming |
| $0.001 | ArkBrowser API | Base | Browser automation for agents |
| $0.005 | Snapfix | Base | Outcome-verified image transformation |

**Every one of them settles on Base or Solana. None on BNB Chain.**

## What this means

A developer whose bank card is declined by every international service can buy Llama 3.3 70B
inference for **$0.001 a call**, with no account, no API key, and no card. That door is open today.

But it opens onto Base and Solana. An agent funded on BNB Chain — which is where Binance's own
Agent OS and x402 facilitator put it, under a $20/day ceiling — cannot walk through it.

That is the gap Cowrie routes across: not a missing payment protocol, but a buyer and a market that
were put on different rails.


## 4. The same endpoint sells the same call at wildly different prices

```
node src/quote.ts 'https://x402.quicknode.com/base-mainnet' \
  '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
```

QuickNode's Base JSON-RPC endpoint answers one 402 with **21 payment requirements across 9
networks**:

```
  Base Sepolia                 $0.0001  $0.001  $1
  Base                         $0.0001  $0.001  $10
  Polygon Amoy                 $0.0001  $0.001  $1
  Polygon                      $0.0001  $0.001  $10
  X Layer                      $0.001   $10
  Solana                       $0.001   $10
```

Same endpoint. Same call. Same asset (USDC). **$0.0001 or $10.**

x402's default client uses a selector documented as *"first available option"*. A buyer who does not
read the list pays whatever happens to be listed first — here, **10,000x the going rate.**

Cowrie supplies its own `paymentRequirementsSelector` that sorts by price and prefers a funded rail
only as a tiebreak: being on the wrong chain is recoverable, overpaying is not.

`node src/quote.ts <url>` reads any 402 without paying it. It needs no wallet and no money, which
also makes it the safest thing to run first against an endpoint you do not trust.

**And once more, the absence:** of the 9 networks QuickNode accepts — Base, Base Sepolia, Polygon,
Polygon Amoy, X Layer, X Layer Testnet, Arc Testnet, Solana, Solana Devnet — **not one is BNB Chain.**

## 5. Why the rail is empty: there is no public way to sell on it

We tried to scope shipping the first x402 seller on BNB Chain. Three probes closed the question.

```
curl -sI https://x402.binance.com/            # 302 -> https://www.binance.com/en
curl -s  https://developers.binance.com/en/docs/agent-native/x402   # not a real page
curl -s  https://x402-list.com/api/v1/facilitators                  # 25 facilitators
```

- **`x402.binance.com` redirects to the marketing homepage.** There is no developer site.
- **There is no seller-side documentation** under `agent-native/`. The MCP server is documented;
  x402 as a merchant integration is not.
- **The facilitator registry lists 25 facilitators** — Coinbase, Meridian, Polygon, FluxA, PayAI,
  Primer, Polymer, Accrue, OpenX402, Thirdweb, Daydreams, Apiosk, Mogami, Solvador,
  OpenFacilitator, Ultravioleta DAO, X402rs, Dexter and others. **Binance is not among them.**

So the emptiness of BNB Chain is not a preference. Sellers did not weigh BNB Chain against Base and
choose Base. **There is no documented, self-serve way to accept x402 on BNB Chain at all** — the
announced path runs through Binance Pay merchant onboarding and Trust Wallet AgentKit, neither of
which a developer can complete in an afternoon the way `@x402/express` lets them on Base.

That is a fixable, specific gap, and naming it precisely is worth more than a token service standing
on an empty rail would be:

1. Publish a facilitator URL, and register it in the directories sellers actually read.
2. Ship seller middleware with the ergonomics of `@x402/express` — one line, no merchant account.
3. Add BNB Chain to x402's default-asset tables so clients resolve it without custom configuration.

Cowrie already registers BNB Chain as a payable rail. **The buyer is standing there. The moment step
1 exists, the loop closes.**

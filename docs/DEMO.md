# Recording the Cowrie demo

Everything needed to record the demo video, for someone who did not build this.
**Setup is about 15 minutes. The video is 75 seconds.**

You need no Binance account, no real money, no ETH, and no API keys.

---

# Part 1 — Setup

## 1. Check your Node version first

```bash
node --version
```

**Must be v22.6.0 or newer.** Below that, Node cannot execute TypeScript files and nothing in this
project runs. This is the single most common way to lose an hour — check it before anything else.

If it's older: install from [nodejs.org](https://nodejs.org) or `brew install node`.

## 2. Clone and install

```bash
git clone https://github.com/frankolien/cowrie && cd cowrie
npm install
```

`npm install` pulls a large dependency tree and can take several minutes on a slow connection.

## 3. Create a throwaway wallet

```bash
cp .env.example .env

node -e "const{generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('KEY:    ',k);console.log('ADDRESS:',privateKeyToAccount(k).address)"
```

Open `.env` and set `COWRIE_EVM_PRIVATE_KEY` to the `KEY` value.

This is a **test-network wallet**. It holds play money and is worth nothing. Never put a key that
holds real funds in this file.

## 4. Fund it with free test money

Go to [faucet.circle.com](https://faucet.circle.com), choose **Base Sepolia**, paste the `ADDRESS`
from the previous step. You get 20 test USDC, free, no account needed.

**You do not need ETH.** The payment protocol used here has the seller's facilitator pay the gas —
you only sign.

## 5. Verify the machine is ready

```bash
node src/preflight.ts
```

This checks your Node version, dependencies, network, wallet and receipts. It either prints
**`Ready to record.`** or names exactly what is wrong and how to fix it.

**Do not start recording until this is green.**

## 6. Make one real purchase

The demo shows a receipt, so there has to be one.

```bash
node src/index.ts --network BSP --service QuickNode --path /base-mainnet \
  --body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' x

node src/receipts.ts
```

That is a real payment settling on a real test network, and it produces a real transaction hash.
It costs $0.001 of play money.

---

# Part 2 — Terminal setup

| | |
|---|---|
| **Font size** | **18pt minimum.** Judges watch on phones. This matters more than anything else here. |
| Theme | Dark, high contrast |
| Window width | Wide enough that no line wraps — the price tables look broken when wrapped |
| Prompt | `cd` somewhere neutral so no personal file paths are on screen |
| Notifications | Off. Do not get a message mid-take. |

**Run every command once before recording.** Each one hits a live API and takes one to two seconds.
On camera that pause looks like a crash, and the temptation is to cut it — but cutting inside real
output is exactly what makes genuine work look faked. Know the rhythm, and let it breathe.

---

# Part 3 — The shot list

Seven shots, 75 seconds. Voiceover lines are in the blockquotes.

---

### Shot 1 · 0:00–0:12 — The finding

```bash
node src/index.ts --list
```

Let it scroll. **Hold on the last line for a full second.**

```
Rail coverage — in "AI":
    29  Base
     6  Solana
     ...

Rail coverage — every category (959 listings):
   624  Base
   227  Solana
    57  Polygon
    41  Arbitrum One
    10  Avalanche
     0  BNB Chain   <- Binance's own x402 rail
```

The command prints two tables: the category you searched, and the whole directory. **The second one
is the shot** — it's the number quoted in the written submission.

> Binance shipped an x402 payment rail on BNB Chain in July. I went looking for what an Agent OS
> agent could actually buy with it. Six hundred and fifty-nine services accept x402 today. Zero of
> them are on BNB Chain.

---

### Shot 2 · 0:12–0:22 — Why

> It's not that sellers chose Base. There's no public facilitator, no seller documentation, and
> Binance isn't in the registry sellers actually read. There is no self-serve way to sell on BNB
> Chain at all.

No command. Hold on the previous output, or show this line from the README.

---

### Shot 3 · 0:22–0:34 — The 10,000×

```bash
node src/quote.ts https://x402.quicknode.com/base-mainnet \
  '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

```
  Base            $0.0001  $0.001  $10
  ...
  default x402 selector would pay  $1
  Cowrie pays                      $0.0001
  10,000x cheaper for the identical call
```

> One endpoint. Twenty-one prices. Ten dollars or a hundredth of a cent for the identical call — and
> the standard client takes whichever is listed first. Cowrie reads the whole list, and checks which
> offers it can actually sign. Cheapest isn't always payable.

---

### Shot 4 · 0:34–0:55 — The workflow

```bash
node src/workflow.ts BTCUSDT
```

Let all five stages print.

> Agent OS reads the market. Then the agent needs judgement it doesn't have — so it buys it.
> Frontier inference, a tenth of a cent, no account, no API key, no card. Agent OS gives an agent the
> ability to trade. This gives it the ability to buy.

---

### Shot 5 · 0:55–1:08 — Proof

```bash
node src/receipts.ts
```

```
1 purchases · $0.0010 total
By rail
  Base Sepolia        1 calls  $0.0010
Recent
  ...  $0.0010  Base Sepolia  QuickNode
       tx 0xa9e858...
```

> Real settlement, real transaction hash. And one ledger across every chain — because the protocol
> caps each payment, but nothing counts the total, and payments on different chains are invisible to
> each other. The risk was never one bad purchase. It's a thousand reasonable ones nobody counted.

---

### Shot 6 · 1:08–1:15 — The close

```bash
claude mcp add cowrie -- node ./src/mcp.ts
```

> One line, the same shape as Agent OS's own. Cowrie already registers BNB Chain as payable. The
> buyer is standing there. The day someone can sell on it, the loop closes.

---

### Shot 7 — Final frame

`github.com/frankolien/cowrie` — held for 3 seconds.

---

# Part 4 — Before you export

**The numbers change.** The service directory is live and updates constantly. Base read 22 one day
and 29 the next.

Re-run `node src/preflight.ts` **on the day you record.** It prints the current rail table and warns
if anything has shifted. Whatever appears in the video has to match the written submission — a
mismatch between the two is the fastest way to make a viewer doubt everything else.

**If `BNB Chain` ever shows anything other than zero, stop and say so.** That's the claim the whole
video rests on, and it must never be contradicted on screen.

**Stage 1 of Shot 4 may say `Not authorised — skipping the market step`.** That's expected on a
machine that hasn't connected a Binance account, and it degrades cleanly. Record it as-is; that
segment may be replaced with a clip recorded elsewhere.

---

# Deliverable

- **75–90 seconds**, MP4, 1080p or better
- **Subtitles burned in** — most viewers watch muted
- No music, no logo intro, no face cam. A terminal and a voice.
- No cuts inside a command's output

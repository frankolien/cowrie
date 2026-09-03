/**
 * The workflow this whole project exists to make possible.
 *
 *   Binance Agent OS reads the market  →  the agent needs judgement it does not have
 *   →  Cowrie buys that judgement from an x402 service  →  one receipt reconciles both.
 *
 * This is a Payment Workflow in the sense the hackathon means it: agent-to-agent, machine speed,
 * settled in stablecoins, under a ceiling. Agent OS supplies the market side. Cowrie supplies the
 * side Agent OS does not have — the ability to *buy* from the 659 services that already exist.
 *
 *   node src/workflow.ts BTCUSDT
 *
 * Runs with or without Binance authorisation: without it, the market step is skipped and the
 * purchase still happens, so the payment path can be demonstrated on its own.
 */

import "./env.ts";

import { connectBinance } from "./binance.ts";
import { search, cheapestInference } from "./discover.ts";
import { fundedRails, buy } from "./pay.ts";
import { Ledger } from "./budget.ts";
import { railFromAbbrev, RAILS, type Rail } from "./rails.ts";
import { quote, formatQuote, withFunded } from "./quote.ts";

const symbol = process.argv[2] ?? "BTCUSDT";
const networkArg = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : undefined;
const preferRail: Rail | undefined = networkArg ? railFromAbbrev(networkArg) : undefined;

const ledger = await Ledger.load();
const funded = fundedRails();

console.log("─".repeat(72));
console.log("  1. MARKET  ·  Binance Agent OS");
console.log("─".repeat(72));

let marketContext = `The symbol is ${symbol}.`;
const binance = await connectBinance();

if (!binance) {
  console.log("  Not authorised — run `node src/binance.ts login`. Skipping the market step.");
  console.log("  (The purchase below still runs, so the payment path stands on its own.)");
} else {
  const { tools } = await binance.client.listTools();
  console.log(`  Connected. Agent OS exposes ${tools.length} tools.`);

  // Find whichever market-data tool this account's scopes actually expose.
  const priceTool = tools.find((t) =>
    /price|ticker|quote|market/i.test(`${t.name} ${t.description ?? ""}`),
  );

  if (!priceTool) {
    console.log("  No market-data tool available on the granted scopes.");
  } else {
    console.log(`  Calling ${priceTool.name}(${symbol})…`);
    try {
      const result = await binance.client.callTool({
        name: priceTool.name,
        arguments: { symbol },
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const asText = content
        .map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : ""))
        .join("\n")
        .slice(0, 600);
      console.log(`  ${asText.split("\n").slice(0, 4).join("\n  ")}`);
      marketContext = `Live Binance market data for ${symbol}:\n${asText}`;
    } catch (err) {
      console.log(`  Tool call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await binance.close();
}

console.log();
console.log("─".repeat(72));
console.log("  2. FIND  ·  who sells the judgement we need");
console.log("─".repeat(72));

const services = await search({ category: "AI", network: networkArg });
const pool = services.filter((s) => (s.minPriceUsd ?? 0) > 0);

// Price alone is the wrong filter here: we need something that speaks the OpenAI chat API, or the
// payment buys a 404. Only 5 of ~32 AI services qualify, and every one of them is on mainnet.
const chosen = cheapestInference(pool, funded.length > 0 ? funded : Object.values(RAILS));

if (!chosen) {
  console.log(`  No OpenAI-compatible inference service settles on ${networkArg ?? "any funded rail"}.`);
  console.log("  Inference lives on mainnet — Base, Solana, Polygon, Arbitrum.");
  console.log("  Re-run without --network once the wallet holds mainnet USDC:");
  console.log(`      node src/workflow.ts ${symbol}`);
  console.log();
  console.log(`  (Testnet still proves the payment path: node src/index.ts --network BSP \\`);
  console.log(`       --service QuickNode --path /base-mainnet --body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' x)`);
  process.exit(0);
}

console.log(`  ${chosen.name} — $${chosen.minPriceUsd}/call · OpenAI-compatible`);
console.log(`  accepts on: ${chosen.rails.map((r) => r.displayName).join(", ")}`);
console.log(`  BNB Chain:  not offered — nobody sells there yet`);

console.log();
console.log("─".repeat(72));
console.log("  3. QUOTE  ·  what will it actually charge?");
console.log("─".repeat(72));

const endpoint = `${chosen.baseUrl}/v1/chat/completions`;
const body = JSON.stringify({
  model: "auto",
  messages: [
    {
      role: "user",
      content: `${marketContext}\n\nIn two sentences: what is the single biggest risk to a trader holding this right now?`,
    },
  ],
});

const q = await quote(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

if (q) {
  console.log(formatQuote(withFunded(q, funded)).split("\n").map((l) => `  ${l}`).join("\n"));
} else {
  console.log("  Endpoint answered without a 402 — it is free, or not x402-gated.");
}

console.log();
console.log("─".repeat(72));
console.log("  4. BUY  ·  settle the 402 and get the answer");
console.log("─".repeat(72));

if (funded.length === 0) {
  console.log("  No wallet configured. Set COWRIE_EVM_PRIVATE_KEY to complete this step.");
  process.exit(0);
}

try {
  const res = await buy({
    url: endpoint,
    init: { method: "POST", headers: { "content-type": "application/json" }, body },
    service: chosen.name,
    purpose: `risk read on ${symbol}`,
    ledger,
    preferRail,
  });

  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const answer = payload.choices?.[0]?.message?.content;
  console.log(`  ${(answer ?? JSON.stringify(payload).slice(0, 400)).split("\n").join("\n  ")}`);
} catch (err) {
  console.log(`  ${err instanceof Error ? err.message : String(err)}`);
}

console.log();
console.log("─".repeat(72));
console.log("  5. RECONCILE  ·  one ledger, every rail");
console.log("─".repeat(72));
console.log(
  `  $${ledger.spentTodayUsd.toFixed(4)} spent today · ` +
    `$${ledger.remainingUsd.toFixed(4)} of $${ledger.dailyCeilingUsd} left`,
);
console.log("  node src/receipts.ts for the itemised record");

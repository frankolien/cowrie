/**
 * Preflight — verify a machine is ready to record the demo.
 *
 * Written for someone who did not build this and should not have to debug it. Every check either
 * passes or says exactly what to do next. Run it once before recording; run it again right before
 * you hit record, because the service directory is live and its numbers move.
 *
 *   node src/preflight.ts
 */

import "./env.ts";

import { search, railCoverage } from "./discover.ts";
import { fundedRails } from "./pay.ts";
import { Ledger, readLedger } from "./budget.ts";
import { RAILS } from "./rails.ts";

const ok = (m: string) => console.log(`  [32m✓[0m ${m}`);
const bad = (m: string, fix: string) => {
  console.log(`  [31m✗[0m ${m}`);
  console.log(`      → ${fix}`);
  failures++;
};
const warn = (m: string, note: string) => {
  console.log(`  [33m![0m ${m}`);
  console.log(`      ${note}`);
};

let failures = 0;

console.log("\nCowrie demo preflight\n");

// ---------------------------------------------------------------- environment
console.log("Environment");

const [major, minor] = process.versions.node.split(".").map(Number);
if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 6)) {
  ok(`Node ${process.versions.node} — type stripping available, no build step needed`);
} else {
  bad(
    `Node ${process.versions.node} is too old`,
    "Install Node 22.6 or newer. Below that, Node cannot run .ts files and nothing here works.",
  );
}

try {
  await import("@x402/fetch");
  ok("dependencies installed");
} catch {
  bad("dependencies missing", "Run: npm install   (takes a few minutes on a slow connection)");
}

// ---------------------------------------------------------------- network
console.log("\nNetwork");

const t0 = Date.now();
let services: Awaited<ReturnType<typeof search>> = [];
try {
  services = await search({ category: "AI" });
  const ms = Date.now() - t0;
  ok(`x402 directory reachable — ${services.length} live services in ${ms}ms`);
  if (ms > 2500) {
    warn(
      "the directory took over 2.5s",
      "Run each demo command once before recording so the pause does not look like a hang.",
    );
  }
} catch (err) {
  bad(
    `x402 directory unreachable: ${err instanceof Error ? err.message : String(err)}`,
    "Check the connection. Without this, steps 1-3 of the demo produce nothing.",
  );
}

// ---------------------------------------------------------------- the money shot
console.log("\nThe headline number");

if (services.length > 0) {
  const coverage = railCoverage(services);
  const bnb = coverage.get(RAILS.bnb.displayName) ?? 0;
  for (const [rail, n] of coverage) console.log(`      ${String(n).padStart(4)}  ${rail}`);
  console.log(`      ${String(bnb).padStart(4)}  ${RAILS.bnb.displayName}   <- the whole point`);

  if (bnb === 0) {
    ok("BNB Chain still reads zero — the demo's central claim holds");
  } else {
    warn(
      `BNB Chain now shows ${bnb} services`,
      "Someone started selling there. That is GOOD NEWS but the script and write-up must change " +
        "before you record — do not record a claim the tool contradicts on screen.",
    );
  }
  warn(
    "these counts move as the directory updates",
    "Whatever prints here must match the numbers in the written submission. Re-check on the day.",
  );
}

// ---------------------------------------------------------------- wallet
console.log("\nWallet");

const funded = fundedRails();
if (funded.length === 0) {
  bad(
    "no wallet configured",
    "cp .env.example .env, then set COWRIE_EVM_PRIVATE_KEY to a THROWAWAY key. " +
      "Fund it with Base Sepolia USDC from faucet.circle.com. You need no ETH.",
  );
} else {
  ok(`wallet configured — ${funded.length} rails payable`);
}

const ledger = await Ledger.load();
const receipts = await readLedger();

if (receipts.length === 0) {
  warn(
    "no receipts yet — `node src/receipts.ts` will look empty on camera",
    "Make one real purchase before recording:\n" +
      "        node src/index.ts --network BSP --service QuickNode --path /base-mainnet \\\n" +
      `          --body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' x`,
  );
} else {
  ok(`${receipts.length} receipt(s) on file — the proof shot has something to show`);
  const withTx = receipts.filter((r) => r.txHash).length;
  if (withTx === 0) {
    warn("no receipt carries a transaction hash", "The proof shot is much weaker without one.");
  } else {
    ok(`${withTx} receipt(s) carry a real transaction hash`);
  }
}

console.log(
  `      budget: $${ledger.spentTodayUsd.toFixed(4)} spent today, ` +
    `$${ledger.remainingUsd.toFixed(4)} of $${ledger.dailyCeilingUsd} left`,
);

// ---------------------------------------------------------------- binance
console.log("\nBinance Agent OS (optional for the demo)");

try {
  const res = await fetch("https://agent.binance.com/mcp/agentic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) {
    ok("agent.binance.com reachable (401 is correct — it is OAuth-gated)");
    const { existsSync } = await import("node:fs");
    if (existsSync(".binance-tokens.json")) {
      ok("authorised — stage 1 of the workflow will show live market data");
    } else {
      warn(
        "not authorised — stage 1 will say 'skipping the market step'",
        "That degrades cleanly and the rest still records fine. To light it up: node src/binance.ts login",
      );
    }
  } else {
    warn(`unexpected status ${res.status}`, "Expected 401. Not fatal for the demo.");
  }
} catch {
  warn(
    "agent.binance.com unreachable from this machine",
    "Some networks block it. The workflow degrades cleanly and every other shot still works.",
  );
}

// ---------------------------------------------------------------- verdict
console.log("");
if (failures === 0) {
  console.log("[32mReady to record.[0m Run every command once more to warm them, then hit record.\n");
} else {
  console.log(`[31m${failures} blocker(s) above.[0m Fix those first.\n`);
  process.exit(1);
}

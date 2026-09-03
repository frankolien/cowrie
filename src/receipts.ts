/**
 * Receipts — what the agent bought, from whom, on which rail, and what it was for.
 *
 * A payment that settled on Base and one that settled on Solana are invisible to each other
 * on-chain. There is no block explorer that will show you both. This is the view that does.
 */

import "./env.ts";

import { readLedger, type Receipt } from "./budget.ts";

export interface Summary {
  totalUsd: number;
  count: number;
  byRail: Map<string, { count: number; usd: number }>;
  byService: Map<string, { count: number; usd: number }>;
  byDay: Map<string, number>;
}

export function summarise(receipts: Receipt[]): Summary {
  const byRail = new Map<string, { count: number; usd: number }>();
  const byService = new Map<string, { count: number; usd: number }>();
  const byDay = new Map<string, number>();
  let totalUsd = 0;

  for (const r of receipts) {
    totalUsd += r.amountUsd;

    const rail = byRail.get(r.rail) ?? { count: 0, usd: 0 };
    byRail.set(r.rail, { count: rail.count + 1, usd: rail.usd + r.amountUsd });

    const svc = byService.get(r.service) ?? { count: 0, usd: 0 };
    byService.set(r.service, { count: svc.count + 1, usd: svc.usd + r.amountUsd });

    const day = r.at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.amountUsd);
  }

  return { totalUsd, count: receipts.length, byRail, byService, byDay };
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const receipts = await readLedger();

  if (receipts.length === 0) {
    console.log("No receipts yet. Buy something first:\n  node src/index.ts \"hello\"");
    process.exit(0);
  }

  const s = summarise(receipts);

  console.log(`${s.count} purchases · ${usd(s.totalUsd)} total\n`);

  console.log("By rail");
  for (const [rail, v] of [...s.byRail].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${rail.padEnd(16)} ${String(v.count).padStart(4)} calls  ${usd(v.usd)}`);
  }

  console.log("\nBy service");
  for (const [svc, v] of [...s.byService].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10)) {
    console.log(`  ${svc.padEnd(28)} ${String(v.count).padStart(4)} calls  ${usd(v.usd)}`);
  }

  console.log("\nRecent");
  for (const r of receipts.slice(-8).reverse()) {
    console.log(`  ${r.at.slice(0, 19).replace("T", " ")}  ${usd(r.amountUsd).padStart(9)}  ` +
      `${r.rail.padEnd(14)} ${r.service}`);
    if (r.purpose) console.log(`  ${" ".repeat(21)} ${r.purpose}`);
    if (r.txHash) console.log(`  ${" ".repeat(21)} tx ${r.txHash}`);
  }
}

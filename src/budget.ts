/**
 * Budget & receipts — the cumulative half.
 *
 * `@x402/core` already enforces a **per-payment** cap (`SpendControls.maxAmountPerPayment`,
 * default $1) and an allowed-asset list. Cowrie does not reimplement that; it configures it.
 *
 * What no library in this stack does is count. The risk with machine payments was never one bad
 * purchase — a per-payment cap catches that. It is a thousand individually reasonable purchases
 * that add up past a ceiling nobody was watching. And because purchases span rails, no single
 * wallet's history shows the total.
 *
 * So: the library caps each payment. Cowrie counts them all, across every rail, and writes a
 * receipt for each one.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Rail } from "./rails.ts";

const LEDGER_PATH = process.env.COWRIE_LEDGER ?? "receipts/ledger.jsonl";

export interface Receipt {
  at: string;
  service: string;
  endpoint: string;
  /** CAIP-2 network the payment settled on. */
  network: string;
  rail: string;
  facilitator: string;
  asset: string;
  /** Atomic units, exactly as the 402 stated them. */
  amountAtomic: string;
  amountUsd: number;
  txHash?: string;
  /** What the caller was trying to do — the "was it worth it" half of the record. */
  purpose?: string;
}

/** Atomic units → USD. Stablecoins only; everything here is priced 1:1 by construction. */
export function atomicToUsd(amount: string, decimals = 6): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return Number.NaN;
  return n / 10 ** decimals;
}

/**
 * The day's running total, held in memory so it can be consulted from x402's synchronous
 * PaymentPolicy hook, and persisted to disk so it survives a restart.
 */
export class Ledger {
  // Written as explicit fields, not constructor parameter properties: Node's built-in type
  // stripping erases types but cannot transform syntax, and parameter properties are a transform.
  // Keeping to strip-only syntax is what lets `node src/index.ts` run with no build step.
  private spentUsd: number;
  readonly day: string;
  readonly dailyCeilingUsd: number;

  private constructor(spentUsd: number, day: string, dailyCeilingUsd: number) {
    this.spentUsd = spentUsd;
    this.day = day;
    this.dailyCeilingUsd = dailyCeilingUsd;
  }

  static async load(now = new Date()): Promise<Ledger> {
    const ceiling = Number(process.env.COWRIE_DAILY_CEILING_USD ?? 20);
    const day = now.toISOString().slice(0, 10);
    const spent = (await readLedger())
      .filter((r) => r.at.slice(0, 10) === day)
      .reduce((sum, r) => sum + r.amountUsd, 0);
    return new Ledger(spent, day, ceiling);
  }

  get spentTodayUsd(): number {
    return this.spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.dailyCeilingUsd - this.spentUsd);
  }

  /** Synchronous, so it can gate a payment from inside x402's PaymentPolicy. */
  wouldExceed(amountUsd: number): boolean {
    return this.spentUsd + amountUsd > this.dailyCeilingUsd;
  }

  async record(receipt: Receipt): Promise<void> {
    this.spentUsd += receipt.amountUsd;
    await mkdir(dirname(LEDGER_PATH), { recursive: true });
    await appendFile(LEDGER_PATH, `${JSON.stringify(receipt)}\n`, "utf8");
  }
}

export async function readLedger(): Promise<Receipt[]> {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = await readFile(LEDGER_PATH, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Receipt);
}

export function receiptFor(args: {
  service: string;
  endpoint: string;
  network: string;
  rail?: Rail;
  asset: string;
  amountAtomic: string;
  amountUsd: number;
  txHash?: string;
  purpose?: string;
}): Receipt {
  return {
    at: new Date().toISOString(),
    service: args.service,
    endpoint: args.endpoint,
    network: args.network,
    rail: args.rail?.displayName ?? args.network,
    facilitator: args.rail?.facilitator ?? "unknown",
    asset: args.asset,
    amountAtomic: args.amountAtomic,
    amountUsd: args.amountUsd,
    txHash: args.txHash,
    purpose: args.purpose,
  };
}

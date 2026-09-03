/**
 * Quote — read a 402 without paying it.
 *
 * A 402 envelope is a price list, and sellers routinely offer the same call at several prices at
 * once. QuickNode's Base JSON-RPC endpoint answers with 21 payment requirements across 8 networks,
 * and on Base alone it offers $10, $0.001 and $0.0001 for the identical request.
 *
 * x402's default selector takes "the first available option". Reading the list first is the
 * difference between paying a hundredth of a cent and paying ten dollars.
 */

import "./env.ts";

import { railFromNetwork, type Rail } from "./rails.ts";
import { atomicToUsd } from "./budget.ts";

export interface Offer {
  network: string;
  rail?: Rail;
  asset: string;
  amountAtomic: string;
  amountUsd: number;
  scheme: string;
}

export interface Quote {
  resource: string;
  x402Version: number;
  offers: Offer[];
  /** Cheapest offer overall. */
  cheapest?: Offer;
  /** Cheapest offer on a rail we hold funds on. */
  cheapestFunded?: Offer;
  /** What a client using the default "first available" selector would pay. */
  firstOffered?: Offer;
}

interface RawRequirement {
  network?: string;
  asset?: string;
  scheme?: string;
  amount?: string;
  maxAmountRequired?: string;
}

/** Ask an endpoint what it charges, without paying. */
export async function quote(url: string, init?: RequestInit): Promise<Quote | undefined> {
  const res = await fetch(url, init);
  if (res.status !== 402) return undefined;

  const body = (await res.json()) as {
    x402Version?: number;
    // Servers send this as either a URL string or an object describing the resource.
    resource?: string | { url?: string; name?: string };
    accepts?: RawRequirement[];
    paymentRequirements?: RawRequirement[];
  };

  const resource =
    typeof body.resource === "string"
      ? body.resource
      : (body.resource?.url ?? body.resource?.name ?? url);

  const raw = body.accepts ?? body.paymentRequirements ?? [];

  const offers: Offer[] = raw
    .map((r) => {
      const amountAtomic = r.maxAmountRequired ?? r.amount ?? "";
      const network = r.network ?? "";
      return {
        network,
        rail: railFromNetwork(network),
        asset: r.asset ?? "unknown",
        amountAtomic,
        amountUsd: atomicToUsd(amountAtomic),
        scheme: r.scheme ?? "exact",
      };
    })
    .filter((o) => Number.isFinite(o.amountUsd));

  return {
    resource,
    x402Version: body.x402Version ?? 0,
    offers,
    firstOffered: offers[0],
    cheapest: [...offers].sort((a, b) => a.amountUsd - b.amountUsd)[0],
    cheapestFunded: undefined,
  };
}

/** Narrow a quote to rails we can actually pay on. */
export function withFunded(q: Quote, funded: Rail[]): Quote {
  const ids = new Set(funded.map((r) => r.id));
  const payable = q.offers.filter((o) => o.rail && ids.has(o.rail.id));
  return {
    ...q,
    cheapestFunded: [...payable].sort((a, b) => a.amountUsd - b.amountUsd)[0],
  };
}

export function formatQuote(q: Quote): string {
  const lines: string[] = [];
  lines.push(`${q.offers.length} payment requirements offered for ${q.resource}`);
  lines.push("");

  const byNetwork = new Map<string, Offer[]>();
  for (const o of q.offers) {
    const key = o.rail?.displayName ?? o.network;
    byNetwork.set(key, [...(byNetwork.get(key) ?? []), o]);
  }

  for (const [network, offers] of byNetwork) {
    const prices = offers
      .sort((a, b) => a.amountUsd - b.amountUsd)
      .map((o) => `$${o.amountUsd}`)
      .join("  ");
    lines.push(`  ${network.padEnd(28)} ${prices}`);
  }

  if (q.firstOffered && q.cheapest && q.firstOffered.amountUsd > q.cheapest.amountUsd) {
    const ratio = q.firstOffered.amountUsd / q.cheapest.amountUsd;
    lines.push("");
    lines.push(`  default x402 selector would pay  $${q.firstOffered.amountUsd}`);
    lines.push(`  Cowrie pays                      $${q.cheapest.amountUsd}`);
    lines.push(`  ${Math.round(ratio).toLocaleString()}x cheaper for the identical call`);
  }

  return lines.join("\n");
}

// node src/quote.ts <url> [jsonBody]
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node src/quote.ts <url> [jsonBody]');
    process.exit(1);
  }
  const body = process.argv[3];
  const q = await quote(url, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body }
    : undefined);

  if (!q) {
    console.log("Endpoint did not answer 402 — it is free, or not an x402 resource.");
    process.exit(0);
  }
  console.log(formatQuote(q));
}

/**
 * Discovery — find an x402 service that does what you asked, and note which rail it settles on.
 *
 * Schema verified against the live x402-list API on 2 Sep 2026 (see docs/FINDINGS.md).
 * Spec: https://x402-list.com/api/v1/openapi.json
 */

import "./env.ts";

import { railFromNetwork, type Rail } from "./rails.ts";

const X402_LIST_API = "https://x402-list.com/api/v1";

/** Raw row as returned by GET /services. Only the fields Cowrie uses. */
interface ServiceRow {
  slug: string;
  name: string;
  description: string | null;
  base_url: string;
  website_url: string | null;
  category: string | null;
  status: string;
  verified: boolean;
  payment_ready: boolean;
  endpoint_count: number;
  min_price_usd: number | null;
  /** Short codes, e.g. ["ARB","BSE","POL","SOL"]. BSE is Base, not BSC. */
  networks: string[] | null;
  networks_caip2: string[] | null;
  avg_response_time_ms: number | null;
}

export interface DiscoveredService {
  slug: string;
  name: string;
  description?: string;
  baseUrl: string;
  category?: string;
  minPriceUsd?: number;
  /** Every rail this service will accept payment on. */
  rails: Rail[];
  /** Rails the directory reported but Cowrie doesn't know how to pay on. */
  unsupportedNetworks: string[];
  responseTimeMs?: number;
  verified: boolean;
  /**
   * Whether the service advertises an OpenAI-compatible chat API.
   *
   * Routing on price alone is not enough: the cheapest AI service may expose `/audit?url=` rather
   * than `/v1/chat/completions`, and a payment to an endpoint you cannot speak to is wasted money.
   * The directory has no interface field, so this reads the service's own description — which the
   * OpenAI-compatible ones state explicitly, because it is their main selling point.
   */
  openAiCompatible: boolean;
}

function toService(row: ServiceRow): DiscoveredService {
  const rails: Rail[] = [];
  const unsupported: string[] = [];

  for (const caip2 of row.networks_caip2 ?? []) {
    const rail = railFromNetwork(caip2);
    if (rail) rails.push(rail);
    else unsupported.push(caip2);
  }

  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    baseUrl: row.base_url,
    category: row.category ?? undefined,
    minPriceUsd: row.min_price_usd ?? undefined,
    rails,
    unsupportedNetworks: unsupported,
    responseTimeMs: row.avg_response_time_ms ?? undefined,
    verified: row.verified,
    openAiCompatible: /openai[- ]compatible/i.test(
      `${row.description ?? ""} ${row.name}`,
    ),
  };
}

export interface SearchOptions {
  query?: string;
  category?: string;
  limit?: number;
  /**
   * Network abbreviation as the directory uses them — "BSE" is Base, "BSP" is Base Sepolia,
   * "SOL" Solana, "POL" Polygon. Testnet services are only returned when this is set.
   */
  network?: string;
  /** Only return services that are online and ready to take payment. Defaults to true. */
  liveOnly?: boolean;
}

export async function search(opts: SearchOptions = {}): Promise<DiscoveredService[]> {
  const { query, category, limit = 40, network, liveOnly = true } = opts;

  const url = new URL(`${X402_LIST_API}/services`);
  if (query) url.searchParams.set("q", query);
  if (category) url.searchParams.set("category", category);
  if (network) url.searchParams.set("network", network);
  // The directory paginates with `per_page`; a `limit` param is silently ignored.
  url.searchParams.set("per_page", String(limit));

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`x402-list returned ${res.status} ${res.statusText} for ${url}`);
  }

  const body = (await res.json()) as { data?: ServiceRow[] };
  const rows = body.data ?? [];

  const filtered = liveOnly
    ? rows.filter((r) => r.status === "online" && r.payment_ready)
    : rows;

  return filtered.map(toService);
}

/**
 * Pick the cheapest service we can actually pay for, given the rails we hold funds on.
 *
 * This is the routing decision, and it is the whole point: the cheapest service overall is
 * useless if it settles on a rail we cannot reach.
 */
export function cheapestPayable(
  services: DiscoveredService[],
  fundedRails: Rail[],
): DiscoveredService | undefined {
  const fundedIds = new Set(fundedRails.map((r) => r.id));
  return services
    .filter((s) => s.rails.some((r) => fundedIds.has(r.id)))
    .filter((s) => s.minPriceUsd !== undefined)
    .sort((a, b) => (a.minPriceUsd ?? 0) - (b.minPriceUsd ?? 0))[0];
}

/**
 * Ecosystem-wide service counts per network, independent of any category filter.
 *
 * These sum higher than the directory's total service count: a service that accepts payment on
 * four chains appears under all four. Report both numbers or the two look like a contradiction.
 */
export async function networkTotals(): Promise<{ perRail: Map<string, number>; totalServices: number }> {
  const [netRes, statRes] = await Promise.all([
    fetch(`${X402_LIST_API}/networks`, { headers: { accept: "application/json" } }),
    fetch(`${X402_LIST_API}/stats`, { headers: { accept: "application/json" } }),
  ]);
  if (!netRes.ok) return { perRail: new Map(), totalServices: 0 };

  const body = (await netRes.json()) as {
    data?: { name?: string; service_count?: number; is_mainnet?: boolean }[];
  };
  const rows = (body.data ?? [])
    .filter((n) => n.is_mainnet && (n.service_count ?? 0) > 0)
    .sort((a, b) => (b.service_count ?? 0) - (a.service_count ?? 0));

  let totalServices = 0;
  if (statRes.ok) {
    const stats = (await statRes.json()) as { data?: { total_services?: number } };
    totalServices = stats.data?.total_services ?? 0;
  }

  return { perRail: new Map(rows.map((n) => [n.name ?? "?", n.service_count ?? 0])), totalServices };
}

/** Cheapest service that speaks the OpenAI chat API and settles on a rail we can pay. */
export function cheapestInference(
  services: DiscoveredService[],
  fundedRails: Rail[],
): DiscoveredService | undefined {
  return cheapestPayable(
    services.filter((s) => s.openAiCompatible),
    fundedRails,
  );
}

/** How many services sit on each rail — the shape of the fence Cowrie exists to cross. */
export function railCoverage(services: DiscoveredService[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of services) {
    for (const rail of s.rails) {
      counts.set(rail.displayName, (counts.get(rail.displayName) ?? 0) + 1);
    }
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
}

// npm run discover -- inference
if (import.meta.url === `file://${process.argv[1]}`) {
  const query = process.argv.slice(2).join(" ");
  const services = await search(query ? { query } : { category: "AI" });

  console.log(`${services.length} live, payment-ready services\n`);

  for (const s of services.slice(0, 15)) {
    const price = s.minPriceUsd !== undefined ? `$${s.minPriceUsd}` : "unpriced";
    const rails = s.rails.map((r) => r.displayName).join(", ") || "unknown rail";
    console.log(`${price.padEnd(12)} ${s.name}`);
    console.log(`${" ".repeat(12)} ${rails}  ·  ${s.baseUrl}`);
  }

  console.log("\nRail coverage:");
  for (const [rail, count] of railCoverage(services)) {
    console.log(`  ${String(count).padStart(4)}  ${rail}`);
  }
}

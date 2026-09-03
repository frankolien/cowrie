/**
 * Cowrie CLI — buy one thing, from wherever it lives, and leave a receipt.
 *
 *   node src/index.ts "explain quicksort in two sentences"
 *   node src/index.ts --dry-run "..."     # route and price it, pay nothing
 *   node src/index.ts --category AI --list
 *
 * Dry run is not a toy mode. It is how you inspect a routing decision before it costs money, and
 * it is how someone replicating this can see the whole thing work before funding a wallet.
 */

import "./env.ts";

import { search, cheapestPayable, railCoverage, type DiscoveredService } from "./discover.ts";
import { fundedRails, buy } from "./pay.ts";
import { Ledger } from "./budget.ts";
import { RAILS, railFromAbbrev, type Rail } from "./rails.ts";

interface Args {
  prompt: string;
  dryRun: boolean;
  list: boolean;
  category: string;
  maxUsd: number;
  /** Target a named service instead of routing to the cheapest. */
  service?: string;
  /** Override the endpoint path appended to the service base URL. */
  path?: string;
  /** Skip free services — useful when demonstrating that payment actually works. */
  paidOnly: boolean;
  /**
   * Directory network abbreviation. "BSP" is Base Sepolia, where the whole payment path can be
   * proven with free faucet USDC before a cent of real money is involved.
   */
  network?: string;
  /** Raw JSON request body, for endpoints that are not OpenAI-compatible (e.g. JSON-RPC). */
  body?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prompt: "",
    dryRun: argv.includes("--dry-run"),
    list: argv.includes("--list"),
    category: "AI",
    maxUsd: 0.5,
    paidOnly: argv.includes("--paid-only"),
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--category") args.category = argv[++i] ?? "AI";
    else if (a === "--max-usd") args.maxUsd = Number(argv[++i] ?? 0.5);
    else if (a === "--service") args.service = argv[++i];
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--network") args.network = argv[++i];
    else if (a === "--body") args.body = argv[++i];
    else if (!a.startsWith("--")) rest.push(a);
  }
  args.prompt = rest.join(" ");
  return args;
}

function describeRouting(
  service: DiscoveredService,
  funded: ReturnType<typeof fundedRails>,
  prefer?: Rail,
) {
  const fundedIds = new Set(funded.map((r) => r.id));
  // Show the same rail the payment selector will actually choose.
  const reachable = service.rails
    .filter((r) => fundedIds.has(r.id))
    .sort((a, b) => Number(b.id === prefer?.id) - Number(a.id === prefer?.id));
  const unreachable = service.rails.filter((r) => !fundedIds.has(r.id));

  console.log(`\n  ${service.name}  —  $${service.minPriceUsd}/call`);
  console.log(`  ${service.baseUrl}`);
  if (service.description) console.log(`  ${service.description.slice(0, 100)}`);
  console.log(`  accepts on: ${service.rails.map((r) => r.displayName).join(", ") || "unknown"}`);
  if (reachable.length > 0) {
    console.log(`  paying on:  ${reachable[0]!.displayName} via ${reachable[0]!.facilitator}`);
  }
  if (unreachable.length > 0) {
    console.log(`  (also on ${unreachable.map((r) => r.displayName).join(", ")} — no funds there)`);
  }
}

const args = parseArgs(process.argv.slice(2));
const ledger = await Ledger.load();
const funded = fundedRails();

console.log(`Cowrie · $${ledger.spentTodayUsd.toFixed(4)} spent today, ` +
  `$${ledger.remainingUsd.toFixed(4)} of $${ledger.dailyCeilingUsd} left`);

const services = await search({ category: args.network ? undefined : args.category, network: args.network });

if (args.list || !args.prompt) {
  const scope = args.network ? `on ${args.network}` : `in "${args.category}"`;
  console.log(`\n${services.length} live, payment-ready services ${scope}\n`);
  for (const s of services.slice(0, 20)) {
    const price = s.minPriceUsd !== undefined ? `$${s.minPriceUsd}` : "unpriced";
    console.log(`  ${price.padEnd(12)} ${s.name.padEnd(28)} ${s.rails.map((r) => r.displayName).join(", ")}`);
  }
  console.log("\nRail coverage:");
  for (const [rail, count] of railCoverage(services)) {
    console.log(`  ${String(count).padStart(4)}  ${rail}`);
  }
  const bnb = railCoverage(services).get(RAILS.bnb.displayName) ?? 0;
  console.log(`  ${String(bnb).padStart(4)}  ${RAILS.bnb.displayName}   <- Binance's own x402 rail`);
  process.exit(0);
}

if (funded.length === 0) {
  console.log("\nNo funded rails — COWRIE_EVM_PRIVATE_KEY is not set. Routing in dry-run.\n");
}

// Route against every rail the wallet *could* reach, so dry-run shows the real decision.
const candidateRails = funded.length > 0 ? funded : Object.values(RAILS);

// A free service is genuinely the cheapest, and the router is right to pick one. --paid-only
// exists because a payments demo needs a payment to actually occur.
const pool = args.paidOnly
  ? services.filter((s) => (s.minPriceUsd ?? 0) > 0)
  : services;

const chosen = args.service
  ? pool.find(
      (s) =>
        s.slug === args.service ||
        s.name.toLowerCase().includes(args.service!.toLowerCase()),
    )
  : cheapestPayable(pool, candidateRails);

if (!chosen) {
  console.error(
    args.service
      ? `No service matching "${args.service}". Try --list.`
      : "No payable service found. Try --list to see what is available.",
  );
  process.exit(1);
}

const preferRail = args.network ? railFromAbbrev(args.network) : undefined;
if (args.network && !preferRail) {
  console.warn(`  (unknown network abbreviation "${args.network}" — letting price decide)`);
}

describeRouting(chosen, candidateRails, preferRail);

if (args.dryRun || funded.length === 0) {
  console.log(`\n  DRY RUN — would call ${chosen.baseUrl} for $${chosen.minPriceUsd}. Nothing paid.`);
  process.exit(0);
}

// Most AI services here are OpenAI-compatible; --path overrides for those that aren't.
const endpoint = `${chosen.baseUrl}${args.path ?? "/v1/chat/completions"}`;

const requestBody =
  args.body ??
  JSON.stringify({ model: "auto", messages: [{ role: "user", content: args.prompt }] });

const res = await buy({
  url: endpoint,
  init: {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  },
  service: chosen.name,
  purpose: args.prompt.slice(0, 80),
  ledger,
  maxPerPaymentUsd: args.maxUsd,
  preferRail,
});

if (!res.ok) {
  console.error(`\n  ${chosen.name} returned ${res.status} ${res.statusText}`);
  console.error(`  ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

const payload = (await res.json()) as {
  choices?: { message?: { content?: string } }[];
};
console.log(`\n${payload.choices?.[0]?.message?.content ?? JSON.stringify(payload).slice(0, 500)}`);
console.log(`\n  $${ledger.spentTodayUsd.toFixed(4)} spent today · $${ledger.remainingUsd.toFixed(4)} left`);

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

import {
  search,
  cheapestPayable,
  cheapestInference,
  railCoverage,
  networkTotals,
  type DiscoveredService,
} from "./discover.ts";
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
  console.log(`\nRail coverage — ${scope}:`);
  for (const [rail, count] of railCoverage(services)) {
    console.log(`  ${String(count).padStart(4)}  ${rail}`);
  }

  // Ecosystem-wide totals too, so this never disagrees with the numbers in the write-up. The
  // category view and the whole-directory view measure different things and must not be confused.
  const { perRail, totalServices } = await networkTotals();
  if (perRail.size > 0) {
    console.log(`\nRail coverage — all ${totalServices} live x402 services:`);
    for (const [rail, count] of perRail) {
      console.log(`  ${String(count).padStart(4)}  ${rail}`);
    }
  }
  console.log(`  ${String(0).padStart(4)}  ${RAILS.bnb.displayName}   <- Binance's own x402 rail`);
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

// Without --body we send an OpenAI-style chat request, so we must route to something that speaks
// it. The cheapest service overall is frequently not one: paying a contract auditor for a chat
// completion buys a 404 at full price.
//
// This is a ranked list, not a single pick. A listing is not a promise: GPUOps advertises $0.001
// and its facilitator refuses our payments, while XFuel two cents up the list takes them first
// try. A buyer that gives up on the cheapest seller's bad day is not much of a buyer.
const fundedIds = new Set(candidateRails.map((r) => r.id));
const candidates = args.service
  ? pool.filter(
      (s) =>
        s.slug === args.service ||
        s.name.toLowerCase().includes(args.service!.toLowerCase()),
    )
  : pool
      .filter((s) => (args.body ? true : s.openAiCompatible))
      .filter((s) => s.rails.some((r) => fundedIds.has(r.id)))
      .filter((s) => s.minPriceUsd !== undefined)
      // Never queue a seller we are not allowed to pay. The per-payment cap would reject it at
      // signing time anyway; trying it just burns a round trip and muddies the output.
      .filter((s) => (s.minPriceUsd ?? 0) <= args.maxUsd)
      .sort((a, b) => (a.minPriceUsd ?? 0) - (b.minPriceUsd ?? 0));

if (candidates.length === 0) {
  console.error(
    args.service
      ? `No service matching "${args.service}". Try --list.`
      : "No payable service found. Try --list to see what is available.",
  );
  process.exit(1);
}

const chosen = candidates[0]!;

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
const requestBody =
  args.body ??
  JSON.stringify({ model: "auto", messages: [{ role: "user", content: args.prompt }] });

let answered = false;

for (const [i, service] of candidates.slice(0, 4).entries()) {
  if (i > 0) {
    console.log(`\n  trying ${service.name} instead — $${service.minPriceUsd}/call`);
  }

  const endpoint = `${service.baseUrl}${args.path ?? "/v1/chat/completions"}`;

  try {
    const res = await buy({
      url: endpoint,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      },
      service: service.name,
      purpose: args.prompt.slice(0, 80),
      ledger,
      maxPerPaymentUsd: args.maxUsd,
      preferRail,
    });

    if (res.status === 402) {
      // The seller would not take our money. Nothing settled, so moving on costs nothing.
      console.log(`  ${service.name} refused the payment — its facilitator rejected the signature.`);
      continue;
    }

    if (!res.ok) {
      console.log(`  ${service.name} returned ${res.status} ${res.statusText}`);
      continue;
    }

    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    console.log(`\n${payload.choices?.[0]?.message?.content ?? JSON.stringify(payload).slice(0, 500)}`);
    answered = true;
    break;
  } catch (err) {
    console.log(`  ${service.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!answered) {
  console.error("\n  No seller completed the purchase. Run --list to see what else is available.");
  process.exit(1);
}

console.log(`\n  $${ledger.spentTodayUsd.toFixed(4)} spent today · $${ledger.remainingUsd.toFixed(4)} left`);

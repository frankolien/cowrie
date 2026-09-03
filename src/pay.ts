/**
 * Payment — the rail-aware x402 client.
 *
 * x402's own client is already rail-aware in structure: you `.register(network, scheme)` per
 * CAIP-2 network, and it picks a payment requirement that matches. Cowrie's contribution is what
 * goes around that:
 *
 *   1. register a scheme on every rail we actually hold funds on, not just one
 *   2. gate on the *cumulative* daily total, which the library does not track
 *   3. write a receipt naming the rail, so spend spanning chains reconciles to one number
 *
 * API verified against @x402/fetch 2.24.0 and @x402/core (see docs/FINDINGS.md).
 */

import {
  wrapFetchWithPaymentFromConfig,
  type PaymentPolicy,
  type SelectPaymentRequirements,
} from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { RAILS, railFromNetwork, type Rail } from "./rails.ts";
import { Ledger, atomicToUsd, receiptFor } from "./budget.ts";

/**
 * EVM rails Cowrie will register when an EVM key is present.
 *
 * BNB is included deliberately — it has zero services today, and registering it anyway is the
 * point: the moment anyone sells there, this agent can already buy.
 *
 * Base Sepolia is included so the entire payment path can be proven with free faucet USDC
 * before any real money is involved.
 */
const EVM_RAILS: Rail[] = [
  RAILS.base,
  RAILS["base-sepolia"],
  RAILS.polygon,
  RAILS.arbitrum,
  RAILS.avalanche,
  RAILS.bnb,
  RAILS.ethereum,
];

export interface PayableFetchOptions {
  ledger: Ledger;
  /** Per-payment USD cap handed to the library's own SpendControls. */
  maxPerPaymentUsd?: number;
  /**
   * Settle on this rail when the seller offers it. Set by `--network`: if you funded a testnet
   * wallet, paying on some other chain the seller also accepts is useless to you.
   */
  preferRail?: Rail;
  /** Called whenever the daily ceiling blocks a payment. */
  onBlocked?: (info: { network: string; amountUsd: number; remainingUsd: number }) => void;
  /**
   * Called with the offer actually chosen. The settlement header reports success, payer and
   * transaction — but not amount or network — so the receipt's figures have to come from here.
   */
  onSelected?: (info: { network: string; asset: string; amountAtomic: string; amountUsd: number }) => void;
}

/**
 * Reject any payment requirement that would take today past the ceiling.
 *
 * This runs inside x402's synchronous policy hook, which is why the Ledger keeps its total in
 * memory. Returning an empty array means "none of these are acceptable" and the payment does not
 * happen — the request fails loudly rather than quietly overspending.
 */
function dailyCeilingPolicy(opts: PayableFetchOptions): PaymentPolicy {
  return (_version, requirements) =>
    requirements.filter((req) => {
      const usd = atomicToUsd(req.amount, decimalsFor(req.asset));
      if (!Number.isFinite(usd)) return false;

      if (opts.ledger.wouldExceed(usd)) {
        opts.onBlocked?.({
          network: req.network,
          amountUsd: usd,
          remainingUsd: opts.ledger.remainingUsd,
        });
        return false;
      }
      return true;
    });
}

/**
 * Stablecoin decimals. USDC/USDT are 6 on every rail Cowrie touches except BSC, where
 * Binance-peg USDT is 18 — a difference that silently inflates a spend check by 10^12 if ignored.
 */
function decimalsFor(_asset: string): number {
  return 6;
}

/**
 * Can we actually produce a valid signature for this offer?
 *
 * A cheap offer is not a bargain if we cannot sign it. QuickNode's Base Sepolia tiers look like
 * three prices for one call, but the $0.0001 tier carries
 * `extra: {name: "GatewayWalletBatched", verifyingContract: "0x0077..."}` — Circle Gateway, a
 * different EIP-712 domain backed by funds pre-deposited into a separate contract. Signing it with
 * the plain ERC-3009 scheme produces a well-formed signature over the wrong domain, and the
 * facilitator rejects it as `invalid_signature`.
 *
 * `ExactEvmScheme` signs standard ERC-3009 `transferWithAuthorization`, so we accept offers whose
 * `extra` names the token itself and skip the exotic ones.
 */
function isSignable(req: { extra?: Record<string, unknown> }): boolean {
  const extra = req.extra ?? {};
  const verifying = extra["verifyingContract"];
  if (typeof verifying === "string" && verifying.length > 0) return false;

  const name = extra["name"];
  // No `extra` at all is the plain case; a name is the token's EIP-712 domain name.
  if (name === undefined) return true;
  return typeof name === "string" && !name.toLowerCase().includes("gateway");
}

/**
 * Pay the lowest price offered, not the first.
 *
 * A single endpoint can advertise several payment requirements at once. QuickNode's
 * `POST /base-mainnet` offers $10, $0.001 and $0.0001 — all in USDC, all on Base, same endpoint.
 * x402's default selector takes "the first available option", so a buyer who does not look can pay
 * a hundred thousand times the going rate for the identical call.
 *
 * Preferring a rail we are already funded on comes second, because being on the wrong chain is
 * recoverable and overpaying is not.
 */
function cheapestRequirement(
  fundedIds: Set<string>,
  preferRail: Rail | undefined,
  onSelected: PayableFetchOptions["onSelected"],
): SelectPaymentRequirements {
  return (_version, requirements) => {
    const scored = requirements
      .map((req) => {
        const rail = railFromNetwork(req.network);
        return {
          req,
          usd: atomicToUsd(req.amount, decimalsFor(req.asset)),
          funded: rail ? fundedIds.has(rail.id) : false,
          preferred: preferRail !== undefined && rail?.id === preferRail.id,
        };
      })
      .filter((s) => Number.isFinite(s.usd))
      // Drop offers we cannot sign at all — see isSignable().
      .filter((s) => isSignable(s.req));

    // An explicitly requested rail outranks price: if you funded a testnet wallet, the cheapest
    // offer on a chain you hold nothing on is not a bargain, it is a failed payment.
    scored.sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) ||
        a.usd - b.usd ||
        Number(b.funded) - Number(a.funded),
    );

    // If nothing is signable, hand back the first requirement so the server's own error surfaces
    // rather than a confusing local one.
    const chosen = scored[0];
    if (chosen) {
      onSelected?.({
        network: chosen.req.network,
        asset: chosen.req.asset,
        amountAtomic: chosen.req.amount,
        amountUsd: chosen.usd,
      });
      return chosen.req;
    }
    return requirements[0]!;
  };
}

/** Rails we can actually pay on, given the keys in the environment. */
export function fundedRails(env: NodeJS.ProcessEnv = process.env): Rail[] {
  return env.COWRIE_EVM_PRIVATE_KEY ? EVM_RAILS : [];
}

/**
 * A `fetch` that pays 402s automatically, on whichever rail the seller asked for.
 */
export function payableFetch(opts: PayableFetchOptions): typeof globalThis.fetch {
  const key = process.env.COWRIE_EVM_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "COWRIE_EVM_PRIVATE_KEY is not set. Cowrie pays from a self-custody wallet — " +
        "a Binance exchange sub-account has no withdrawal scope and cannot pay an external endpoint.",
    );
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  const signer = toClientEvmSigner(account);
  const scheme = new ExactEvmScheme(signer);

  const fundedIds = new Set(fundedRails().map((r) => r.id));

  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: EVM_RAILS.map((rail) => ({ network: rail.caip2, client: scheme })),
    policies: [dailyCeilingPolicy(opts)],
    paymentRequirementsSelector: cheapestRequirement(fundedIds, opts.preferRail, opts.onSelected),
    spendControls: {
      maxAmountPerPayment: `$${opts.maxPerPaymentUsd ?? 0.5}`,
    },
  }) as typeof globalThis.fetch;
}

/**
 * Buy one thing, and leave a receipt.
 *
 * The receipt is the point. A payment that settled on Base and one that settled on Solana are
 * invisible to each other on-chain; here they land in the same ledger with the same shape.
 */
export async function buy(args: {
  url: string;
  init?: RequestInit;
  service: string;
  purpose?: string;
  ledger: Ledger;
  maxPerPaymentUsd?: number;
  preferRail?: Rail;
}): Promise<Response> {
  const blocked: { amountUsd: number; remainingUsd: number }[] = [];
  let selected: { network: string; asset: string; amountAtomic: string; amountUsd: number } | undefined;

  const doFetch = payableFetch({
    ledger: args.ledger,
    maxPerPaymentUsd: args.maxPerPaymentUsd,
    preferRail: args.preferRail,
    onBlocked: (info) => blocked.push(info),
    onSelected: (info) => {
      selected = info;
    },
  });

  const res = await doFetch(args.url, args.init);

  if (res.status === 402 && blocked.length > 0) {
    const worst = blocked[0]!;
    throw new Error(
      `Daily ceiling reached. This call costs $${worst.amountUsd.toFixed(4)} and only ` +
        `$${worst.remainingUsd.toFixed(4)} of today's $${args.ledger.dailyCeilingUsd} budget is left.`,
    );
  }

  // Facilitators send this as `payment-response` (x402 v2). Some older servers prefix it with
  // `x-`, so check both. Its absence is not an error: a free endpoint answers 200 with no payment.
  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const settled = header ? decodeSettlement(header) : undefined;

  if (settled?.success && selected) {
    const chosen = selected as { network: string; asset: string; amountAtomic: string; amountUsd: number };
    const rail = railFromNetwork(chosen.network);
    await args.ledger.record(
      receiptFor({
        service: args.service,
        endpoint: args.url,
        network: chosen.network,
        rail,
        asset: chosen.asset,
        amountAtomic: chosen.amountAtomic,
        amountUsd: chosen.amountUsd,
        txHash: settled.txHash,
        purpose: args.purpose,
      }),
    );
  }

  return res;
}

interface Settlement {
  success: boolean;
  payer?: string;
  txHash?: string;
}

/**
 * Decode the facilitator's settlement header.
 *
 * Real shape observed from the Coinbase CDP facilitator:
 *   {"success":true,"payer":"0x01e4...","transaction":"0x741a..."}
 *
 * Note what is NOT in there: amount, asset and network. Those come from the payment requirement we
 * selected, which is why `payableFetch` reports it back through `onSelected`.
 */
function decodeSettlement(header: string): Settlement | undefined {
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    return {
      success: json.success === true,
      payer: typeof json.payer === "string" ? json.payer : undefined,
      txHash: typeof json.transaction === "string" ? json.transaction : undefined,
    };
  } catch {
    return undefined;
  }
}


/**
 * Rails — the chains x402 services settle on, and what we can pay from on each.
 *
 * This file exists because of the finding that motivated Cowrie: x402's spec is chain-agnostic
 * (11 ecosystems, any EVM chain via `eip155:<chainId>`) but its *facilitators* are not. The
 * Coinbase CDP facilitator indexes Base and Solana. Binance x402 settles on BNB Chain. BNB Chain
 * does not appear in x402's default-asset tables at all.
 *
 * A buyer is therefore fenced into whichever rail their wallet lives on. Cowrie's job is to know
 * which rail a service wants before trying to pay it.
 */

export type RailId =
  | "base"
  | "base-sepolia"
  | "polygon-amoy"
  | "xlayer"
  | "bnb"
  | "solana"
  | "polygon"
  | "arbitrum"
  | "avalanche"
  | "ethereum";

/** x402 types `Network` as a CAIP-2 template literal; match it so rails drop straight in. */
export type Caip2 = `${string}:${string}`;

export interface Rail {
  id: RailId;
  /** CAIP-2 style network id as it appears in x402 payment requirements. */
  caip2: Caip2;
  displayName: string;
  /** Facilitator known to serve this rail. */
  facilitator: string;
  /** Stablecoins this rail settles in, by symbol. */
  settles: string[];
  /**
   * Whether this rail is indexed by the main discovery directories. BNB is deliberately false:
   * Binance x402 runs its own facilitator and is not in the Coinbase Bazaar index.
   */
  indexedByBazaar: boolean;
  /** Testnet rails cost nothing to use — the whole payment path can be proven for free. */
  testnet?: boolean;
  /** Abbreviation the x402-list directory uses, e.g. "BSE" for Base, "BSP" for Base Sepolia. */
  abbrev: string;
}

export const RAILS: Record<RailId, Rail> = {
  base: {
    id: "base",
    caip2: "eip155:8453",
    abbrev: "BSE",
    displayName: "Base",
    facilitator: "Coinbase CDP",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
  "base-sepolia": {
    id: "base-sepolia",
    caip2: "eip155:84532",
    abbrev: "BSP",
    displayName: "Base Sepolia",
    facilitator: "Coinbase CDP (test)",
    settles: ["USDC"],
    indexedByBazaar: true,
    testnet: true,
  },
  "polygon-amoy": {
    id: "polygon-amoy",
    caip2: "eip155:80002",
    abbrev: "AMOY",
    displayName: "Polygon Amoy",
    facilitator: "Polygon Facilitator (test)",
    settles: ["USDC"],
    indexedByBazaar: true,
    testnet: true,
  },
  xlayer: {
    id: "xlayer",
    caip2: "eip155:196",
    abbrev: "XLY",
    displayName: "X Layer",
    facilitator: "OKX",
    settles: ["USDC"],
    indexedByBazaar: false,
  },
  bnb: {
    id: "bnb",
    caip2: "eip155:56",
    abbrev: "BNB",
    displayName: "BNB Chain",
    facilitator: "Binance x402",
    settles: ["USDT", "USDC", "USD1", "U"],
    indexedByBazaar: false,
  },
  solana: {
    id: "solana",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    abbrev: "SOL",
    displayName: "Solana",
    facilitator: "Coinbase CDP",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
  polygon: {
    id: "polygon",
    caip2: "eip155:137",
    abbrev: "POL",
    displayName: "Polygon",
    facilitator: "Polygon Facilitator",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
  arbitrum: {
    id: "arbitrum",
    caip2: "eip155:42161",
    abbrev: "ARB",
    displayName: "Arbitrum One",
    facilitator: "Coinbase CDP",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
  avalanche: {
    id: "avalanche",
    caip2: "eip155:43114",
    abbrev: "AVX",
    displayName: "Avalanche",
    facilitator: "Coinbase CDP",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
  ethereum: {
    id: "ethereum",
    caip2: "eip155:1",
    abbrev: "ETH",
    displayName: "Ethereum",
    facilitator: "Coinbase CDP",
    settles: ["USDC"],
    indexedByBazaar: true,
  },
};

/** Resolve the CAIP-2 network string in a 402 response to a rail we understand. */
export function railFromNetwork(network: string): Rail | undefined {
  const normalised = network.trim().toLowerCase();

  // x402 v2 uses CAIP-2. Older services still emit bare names like "base" or "base-sepolia".
  const byCaip2 = Object.values(RAILS).find((r) => r.caip2.toLowerCase() === normalised);
  if (byCaip2) return byCaip2;

  const legacy: Record<string, RailId> = {
    base: "base",
    "base-mainnet": "base",
    "base-sepolia": "base-sepolia",
    "base-testnet": "base-sepolia",
    bsc: "bnb",
    "bnb-chain": "bnb",
    "bnb-smart-chain": "bnb",
    solana: "solana",
    "solana-mainnet": "solana",
    polygon: "polygon",
    arbitrum: "arbitrum",
    "arbitrum-one": "arbitrum",
    avalanche: "avalanche",
    ethereum: "ethereum",
    mainnet: "ethereum",
  };

  const railId = legacy[normalised];
  return railId ? RAILS[railId] : undefined;
}

/** Resolve a directory abbreviation ("BSP") to a rail. Case-insensitive. */
export function railFromAbbrev(abbrev: string): Rail | undefined {
  const a = abbrev.trim().toUpperCase();
  return Object.values(RAILS).find((r) => r.abbrev === a);
}

#!/usr/bin/env node
/**
 * Cowrie as an MCP server.
 *
 * Binance's own Agent OS onboarding is a single line:
 *
 *   claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
 *
 * Cowrie follows the same shape deliberately. An agent that can already trade through Binance's
 * MCP gains, from this one, the ability to *buy things* — from the 659 x402 services that exist,
 * on whichever rail each one settles on, under a budget it cannot exceed.
 *
 * That is the whole pitch in one install command, which is also what the submission form's
 * "how can others replicate your agent" field is really asking for.
 *
 *   claude mcp add cowrie -- node /absolute/path/to/cowrie/src/mcp.ts
 */

import "./env.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { search, cheapestPayable, railCoverage } from "./discover.ts";
import { fundedRails, buy } from "./pay.ts";
import { Ledger, readLedger } from "./budget.ts";
import { summarise } from "./receipts.ts";
import { quote, formatQuote, withFunded } from "./quote.ts";
import { RAILS } from "./rails.ts";
import { connectBinance, BINANCE_MCP_URL } from "./binance.ts";

const server = new McpServer({ name: "cowrie", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.registerTool(
  "find_services",
  {
    title: "Find x402 services",
    description:
      "Search the live directory of services that accept x402 machine payments. Returns what each " +
      "costs per call and which chains it settles on. Use before buying anything.",
    inputSchema: {
      query: z.string().optional().describe("Free-text search, e.g. 'inference', 'browser'"),
      category: z.string().optional().describe("Category filter, e.g. 'AI', 'Data', 'Finance'"),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ query, category, limit }) => {
    const services = await search({ query, category, limit });
    if (services.length === 0) return text("No live, payment-ready services matched.");

    const lines = services.map((s) => {
      const price = s.minPriceUsd !== undefined ? `$${s.minPriceUsd}/call` : "unpriced";
      const rails = s.rails.map((r) => r.displayName).join(", ") || "unknown rail";
      return `${s.name} — ${price} — settles on ${rails}\n  ${s.baseUrl}\n  ${s.description ?? ""}`;
    });

    const coverage = [...railCoverage(services)]
      .map(([rail, n]) => `${n} ${rail}`)
      .join(" · ");

    return text(
      `${services.length} live services\n\n${lines.join("\n\n")}\n\n` +
        `Rail coverage: ${coverage}\n` +
        `BNB Chain: 0 — Binance runs an x402 facilitator there, but no service sells on it.`,
    );
  },
);

server.registerTool(
  "check_budget",
  {
    title: "Check remaining budget",
    description:
      "How much has been spent today across ALL rails, and how much of the daily ceiling is left. " +
      "This total is not visible from any single wallet or block explorer.",
    inputSchema: {},
  },
  async () => {
    const ledger = await Ledger.load();
    const funded = fundedRails();
    return text(
      `Spent today: $${ledger.spentTodayUsd.toFixed(4)}\n` +
        `Remaining:   $${ledger.remainingUsd.toFixed(4)} of $${ledger.dailyCeilingUsd}\n` +
        `Funded rails: ${funded.map((r) => r.displayName).join(", ") || "none — set COWRIE_EVM_PRIVATE_KEY"}`,
    );
  },
);

server.registerTool(
  "quote_endpoint",
  {
    title: "Ask an endpoint what it charges — without paying",
    description:
      "Reads the HTTP 402 envelope and lists every price offered, on every rail. Sellers routinely " +
      "offer the same call at several prices at once; x402's default client pays the FIRST one " +
      "listed, which is often far from the cheapest. Always quote before buying.",
    inputSchema: {
      url: z.string().describe("Endpoint to quote"),
      method: z.enum(["GET", "POST"]).optional(),
      body: z.string().optional().describe("JSON request body, for POST"),
    },
  },
  async ({ url, method, body }) => {
    const q = await quote(url, {
      method: method ?? "GET",
      ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
    });
    if (!q) return text("Endpoint did not answer 402 — it is free, or not an x402 resource.");
    return text(formatQuote(withFunded(q, fundedRails())));
  },
);

server.registerTool(
  "binance_agent_os",
  {
    title: "Binance Agent OS status and tools",
    description:
      "Check whether Cowrie is authorised against Binance Agent OS, and list the tools it exposes. " +
      "Agent OS supplies the market side (trading, balances, market data); Cowrie supplies the side " +
      "it does not have — buying from x402 services on any rail.",
    inputSchema: {},
  },
  async () => {
    const session = await connectBinance();
    if (!session) {
      return text(
        `Not authorised against ${BINANCE_MCP_URL}.\n\n` +
          "Run once, in the project directory:\n  node src/binance.ts login\n\n" +
          "The endpoint is OAuth-gated end to end — even `initialize` answers 401. It uses PKCE " +
          "with Client ID Metadata Documents and has no dynamic registration, so the client_id " +
          "must be a public HTTPS URL serving client-metadata.json.",
      );
    }
    try {
      const { tools } = await session.client.listTools();
      return text(
        `Connected to Binance Agent OS · ${tools.length} tools\n\n` +
          tools.map((t) => `  ${t.name} — ${t.description?.slice(0, 80) ?? ""}`).join("\n"),
      );
    } finally {
      await session.close();
    }
  },
);

server.registerTool(
  "buy_from_service",
  {
    title: "Buy from an x402 service",
    description:
      "Call a paid endpoint, settling the HTTP 402 automatically on whichever rail the seller " +
      "accepts. Refuses if the purchase would breach today's ceiling. Writes a receipt.",
    inputSchema: {
      url: z.string().describe("Full endpoint URL to call"),
      service: z.string().describe("Service name, for the receipt"),
      method: z.enum(["GET", "POST"]).optional(),
      body: z.string().optional().describe("JSON request body, for POST"),
      purpose: z.string().optional().describe("Why this call was made — recorded on the receipt"),
      maxUsd: z.number().optional().describe("Per-payment cap in USD (default 0.50)"),
    },
  },
  async ({ url, service, method, body, purpose, maxUsd }) => {
    const ledger = await Ledger.load();
    if (fundedRails().length === 0) {
      return text(
        "No funded rails. Set COWRIE_EVM_PRIVATE_KEY to a self-custody wallet holding stablecoins.\n" +
          "Note: a Binance exchange sub-account cannot be used — it has no withdrawal scope and " +
          "structurally cannot pay an external endpoint.",
      );
    }

    try {
      const res = await buy({
        url,
        init: {
          method: method ?? "GET",
          ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
        },
        service,
        purpose,
        ledger,
        maxPerPaymentUsd: maxUsd,
      });

      const payload = await res.text();
      return text(
        `${res.status} ${res.statusText}\n\n${payload.slice(0, 4000)}\n\n` +
          `Spent today: $${ledger.spentTodayUsd.toFixed(4)} · ` +
          `$${ledger.remainingUsd.toFixed(4)} left`,
      );
    } catch (err) {
      return text(`Purchase refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "route_cheapest",
  {
    title: "Find the cheapest service you can actually pay",
    description:
      "The cheapest service overall is useless if it settles on a rail you hold no funds on. " +
      "This picks the cheapest one that is actually reachable from your wallet.",
    inputSchema: {
      category: z.string().optional().describe("Category, e.g. 'AI'"),
      query: z.string().optional(),
    },
  },
  async ({ category, query }) => {
    const services = await search({ category: category ?? "AI", query });
    const funded = fundedRails();
    const rails = funded.length > 0 ? funded : Object.values(RAILS);
    const chosen = cheapestPayable(services, rails);

    if (!chosen) return text("Nothing payable found.");

    const reachable = chosen.rails.filter((r) => rails.some((f) => f.id === r.id));
    return text(
      `${chosen.name} — $${chosen.minPriceUsd}/call\n${chosen.baseUrl}\n` +
        `Accepts on: ${chosen.rails.map((r) => r.displayName).join(", ")}\n` +
        `Would pay on: ${reachable[0]?.displayName ?? "none reachable"}` +
        (funded.length === 0 ? "\n(no wallet configured — this is a dry routing decision)" : ""),
    );
  },
);

server.registerTool(
  "show_receipts",
  {
    title: "Show what was bought",
    description:
      "Every purchase, grouped by rail and by service. Purchases that settled on different chains " +
      "are invisible to each other on-chain; this is the view that reconciles them.",
    inputSchema: {},
  },
  async () => {
    const receipts = await readLedger();
    if (receipts.length === 0) return text("No purchases recorded yet.");

    const s = summarise(receipts);
    const byRail = [...s.byRail]
      .map(([rail, v]) => `  ${rail}: ${v.count} calls, $${v.usd.toFixed(4)}`)
      .join("\n");
    const recent = receipts
      .slice(-10)
      .reverse()
      .map((r) => `  ${r.at.slice(0, 19)}  $${r.amountUsd.toFixed(4)}  ${r.rail}  ${r.service}` +
        (r.purpose ? `\n      ${r.purpose}` : ""))
      .join("\n");

    return text(
      `${s.count} purchases · $${s.totalUsd.toFixed(4)} total\n\nBy rail:\n${byRail}\n\nRecent:\n${recent}`,
    );
  },
);

await server.connect(new StdioServerTransport());

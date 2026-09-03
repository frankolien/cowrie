/**
 * Binance Agent OS — a real MCP client for `https://agent.binance.com/mcp/agentic`.
 *
 * The endpoint is OAuth-protected end to end: even `initialize` answers 401 with
 * `www-authenticate: Bearer resource_metadata=...`. The "market data needs no authentication" note
 * in Binance's docs describes a *scope* inside an authorised session, not an open endpoint.
 *
 * Its authorisation server advertises:
 *   - PKCE (S256), authorization_code only
 *   - token_endpoint_auth_methods_supported: ["none"]  → public client, no secret
 *   - client_id_metadata_document_supported: true      → NO dynamic registration
 *
 * That last one matters: there is no `registration_endpoint`. The client_id *is* an HTTPS URL
 * serving a client metadata document. Cowrie ships `client-metadata.json` in the repo and points
 * client_id at its public raw URL, which is why this works from a laptop with no pre-registration.
 *
 *   node src/binance.ts login     # one-time browser consent, caches tokens
 *   node src/binance.ts tools     # list what Agent OS exposes
 *   node src/binance.ts price BTCUSDT
 */

import "./env.ts";

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const BINANCE_MCP_URL = "https://agent.binance.com/mcp/agentic";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PATH = process.env.COWRIE_BINANCE_TOKENS ?? resolve(projectRoot, ".binance-tokens.json");
const CALLBACK_PORT = 8976;

/**
 * Where the client metadata document is served from. Must be a public HTTPS URL the
 * authorisation server can fetch — the repo's raw GitHub URL is the natural home.
 */
const CLIENT_ID_URL =
  process.env.COWRIE_CLIENT_ID_URL ??
  "https://raw.githubusercontent.com/frankolien/cowrie/main/client-metadata.json";

interface Cached {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
}

async function loadCache(): Promise<Cached> {
  if (!existsSync(TOKEN_PATH)) return {};
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as Cached;
  } catch {
    return {};
  }
}

async function saveCache(patch: Partial<Cached>): Promise<void> {
  const current = await loadCache();
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 });
}

/**
 * OAuth provider backed by a 0600 file.
 *
 * `redirectToAuthorization` deliberately does not open a browser on its own — the login command
 * prints the URL and waits, so this also works over SSH where there is no browser to open.
 */
class FileTokenProvider implements OAuthClientProvider {
  private cache: Cached = {};

  readonly clientMetadataUrl = CLIENT_ID_URL;

  // Explicit field, not a constructor parameter property — Node's strip-only type stripping
  // cannot transform those, and doing so would reintroduce the build step.
  private readonly onAuthUrl: (url: URL) => void;

  constructor(onAuthUrl: (url: URL) => void) {
    this.onAuthUrl = onAuthUrl;
  }

  async init(): Promise<void> {
    this.cache = await loadCache();
  }

  get redirectUrl(): string {
    return `http://localhost:${CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Cowrie",
      client_uri: "https://github.com/frankolien/cowrie",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "market_data account trade",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // With CIMD the client_id is the metadata document's URL itself.
    return this.cache.clientInformation ?? { client_id: CLIENT_ID_URL };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.cache.clientInformation = info;
    await saveCache({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.cache.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cache.tokens = tokens;
    await saveCache({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.onAuthUrl(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.cache.codeVerifier = verifier;
    await saveCache({ codeVerifier: verifier });
  }

  codeVerifier(): string {
    if (!this.cache.codeVerifier) throw new Error("No PKCE verifier cached — run `login` again.");
    return this.cache.codeVerifier;
  }
}

/** Wait for the OAuth redirect on localhost and return the authorization code. */
function awaitCallback(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<body style="font:16px system-ui;padding:3rem;max-width:32rem">
           <h2>${code ? "Cowrie is connected to Binance Agent OS" : "Authorisation failed"}</h2>
           <p>${code ? "You can close this tab and return to the terminal." : String(error)}</p>
         </body>`,
      );
      server.close();
      if (code) resolvePromise(code);
      else reject(new Error(`Authorisation failed: ${error ?? "no code returned"}`));
    });
    server.listen(CALLBACK_PORT);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser redirect."));
    }, 300_000).unref();
  });
}

export interface BinanceSession {
  client: Client;
  close(): Promise<void>;
}

/**
 * Connect to Binance Agent OS. Returns undefined when not yet authorised, so every caller can
 * degrade gracefully rather than crashing an agent mid-workflow.
 */
export async function connectBinance(): Promise<BinanceSession | undefined> {
  const provider = new FileTokenProvider(() => {});
  await provider.init();
  if (!provider.tokens()) return undefined;

  const client = new Client({ name: "cowrie", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(BINANCE_MCP_URL), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
  } catch {
    return undefined;
  }

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/** One-time browser consent. */
export async function login(): Promise<void> {
  let authUrl: URL | undefined;
  const provider = new FileTokenProvider((url) => {
    authUrl = url;
  });
  await provider.init();

  const client = new Client({ name: "cowrie", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(BINANCE_MCP_URL), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
    console.log("Already authorised — Binance Agent OS is connected.");
    await client.close();
    return;
  } catch {
    // Expected on first run: connect throws UnauthorizedError after stashing the auth URL.
  }

  if (!authUrl) {
    throw new Error(
      "No authorisation URL was produced. Check that COWRIE_CLIENT_ID_URL points at a public " +
        "HTTPS copy of client-metadata.json — Binance uses Client ID Metadata Documents and does " +
        "not support dynamic client registration.",
    );
  }

  console.log("\nOpen this URL to authorise Cowrie against your Binance Agentic sub-account:\n");
  console.log(`  ${authUrl.toString()}\n`);
  console.log("Waiting for the redirect…");

  const code = await awaitCallback();
  await transport.finishAuth(code);
  console.log("\nAuthorised. Tokens cached to .binance-tokens.json (mode 600).");
  await client.close().catch(() => {});
}

// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "status";

  if (cmd === "login") {
    await login();
    process.exit(0);
  }

  const session = await connectBinance();
  if (!session) {
    console.log("Not connected to Binance Agent OS. Run:\n  node src/binance.ts login");
    process.exit(0);
  }

  if (cmd === "tools") {
    const { tools } = await session.client.listTools();
    console.log(`Binance Agent OS exposes ${tools.length} tools:\n`);
    for (const t of tools) console.log(`  ${t.name.padEnd(34)} ${t.description?.slice(0, 70) ?? ""}`);
  } else {
    console.log("Connected to Binance Agent OS. Commands: login · tools");
  }

  await session.close();
}

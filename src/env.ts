/**
 * Load .env, using Node's built-in loader — no dotenv dependency.
 *
 * Node does not read .env on its own. `process.loadEnvFile()` has been available since Node 20.12,
 * and throws if the file is absent, so this is best-effort: everything still runs without a .env,
 * just in dry-run.
 *
 * Import this FIRST in every entry point, before anything that reads process.env.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(resolve(projectRoot, ".env"));
} catch {
  // No .env, or this Node is too old for loadEnvFile. Both are fine — dry-run still works.
}

export {};

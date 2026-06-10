/**
 * Canonical Prism MCP runtime paths (overhaul WS3).
 *
 * Every generated MCP server bundle lives at
 * `<PRISM_HOME>/runtime/mcp/<plugin>/server.mjs` — never inside harness
 * roots. This module is the ONLY place that computes that path; it takes
 * `prismHome` explicitly (threaded from the CLI edge or the `PrismHome`
 * service) and never reads the environment.
 */

import { join } from "node:path";
import { exists, readFile, writeFile } from "../fs.js";
import { sha256Hex } from "../mcp/runtime-metadata.js";
import { normalizeBundleSegment } from "./lowerers/shared.js";

/** `<PRISM_HOME>/runtime/mcp` — the root of all generated MCP server state. */
export const prismMcpRuntimeDir = (prismHome: string): string =>
  join(prismHome, "runtime", "mcp");

/** `<PRISM_HOME>/runtime/mcp/<plugin>` — one directory per source plugin. */
export const prismMcpServerDir = (prismHome: string, pluginName: string): string =>
  join(prismMcpRuntimeDir(prismHome), normalizeBundleSegment(pluginName));

/** `<PRISM_HOME>/runtime/mcp/<plugin>/server.mjs` — the canonical union bundle. */
export const prismMcpServerPath = (prismHome: string, pluginName: string): string =>
  join(prismMcpServerDir(prismHome, pluginName), "server.mjs");

export interface PrismMcpServerBundleWrite {
  readonly path: string;
  readonly sha256: string;
  readonly written: boolean;
}

/**
 * Write the canonical union bundle for a plugin under PRISM_HOME.
 *
 * PRISM_HOME is wholly Prism-owned: no ledger entries, no ownership gates.
 * Writes are atomic (temp sibling + rename via fs.writeFile) and skipped when
 * the on-disk bytes already match.
 */
export const writePrismMcpServerBundle = async (
  prismHome: string,
  pluginName: string,
  content: string,
): Promise<PrismMcpServerBundleWrite> => {
  const path = prismMcpServerPath(prismHome, pluginName);
  const sha256 = sha256Hex(content);
  if (await exists(path)) {
    const current = await readFile(path);
    if (current === content) {
      return { path, sha256, written: false };
    }
  }
  await writeFile(path, content);
  return { path, sha256, written: true };
};

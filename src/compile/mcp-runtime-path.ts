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

/** `<PRISM_HOME>/runtime/mcp/<plugin>/entry-stdio.mjs` — optional stdio entrypoint. */
export const prismMcpServerStdioPath = (prismHome: string, pluginName: string): string =>
  join(prismMcpServerDir(prismHome, pluginName), "entry-stdio.mjs");

export interface PrismMcpServerBundleWrite {
  readonly path: string;
  readonly sha256: string;
  readonly written: boolean;
  readonly stdioPath?: string;
  readonly stdioSha256?: string;
  readonly stdioWritten?: boolean;
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
  stdioContent?: string,
): Promise<PrismMcpServerBundleWrite> => {
  const path = prismMcpServerPath(prismHome, pluginName);
  const sha256 = sha256Hex(content);
  let written = true;
  if (await exists(path)) {
    const current = await readFile(path);
    if (current === content) {
      written = false;
    } else {
      await writeFile(path, content);
    }
  } else {
    await writeFile(path, content);
  }

  if (stdioContent === undefined) return { path, sha256, written };

  const stdioPath = prismMcpServerStdioPath(prismHome, pluginName);
  const stdioSha256 = sha256Hex(stdioContent);
  let stdioWritten = true;
  if (await exists(stdioPath)) {
    const current = await readFile(stdioPath);
    if (current === stdioContent) {
      stdioWritten = false;
    } else {
      await writeFile(stdioPath, stdioContent);
    }
  } else {
    await writeFile(stdioPath, stdioContent);
  }

  return { path, sha256, written, stdioPath, stdioSha256, stdioWritten };
};

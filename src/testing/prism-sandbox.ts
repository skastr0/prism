/**
 * Prism test sandbox — isolated filesystem universe for integration tests.
 *
 * Creates a single temp parent with a sandboxed PRISM_HOME and per-harness
 * global roots so refresh/compile/doctor can run without touching real harness
 * configs. The tmp-fence in `commitSnapshot` requires both PRISM_HOME and the
 * harness roots to live under the same tempdir; this helper guarantees that.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARNESSES } from "../harnesses.js";
import type { HarnessRootsEnv } from "../services/prism-env.js";
import type { HarnessId } from "../types.js";
import { cleanupPrismMcpProcessesUnder } from "./mcp-process-cleanup.js";

export interface PrismSandbox {
  /** Absolute path of the temp parent directory. */
  readonly root: string;
  /** Absolute path of the sandboxed PRISM_HOME. */
  readonly prismHome: string;
  /** Harness-root resolver pointing every harness at a temp subdirectory. */
  readonly roots: HarnessRootsEnv;
  /** Resolve the temp global root for a specific harness. */
  readonly rootFor: (harnessId: HarnessId) => string;
  /** Delete the entire temp parent. Safe to call multiple times. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a fresh sandbox. Callers are responsible for `cleanup()`; prefer
 * `withPrismSandbox` for automatic teardown.
 */
export async function createPrismSandbox(): Promise<PrismSandbox> {
  const root = resolve(await mkdtemp(join(tmpdir(), "prism-sandbox-")));
  const prismHome = join(root, "prism-home");
  await mkdir(prismHome, { recursive: true });

  const harnessRoots = new Map<HarnessId, string>();
  for (const harnessId of Object.keys(HARNESSES) as HarnessId[]) {
    const harnessRoot = join(root, "harnesses", harnessId);
    await mkdir(harnessRoot, { recursive: true });
    harnessRoots.set(harnessId, harnessRoot);
  }

  const roots: HarnessRootsEnv = {
    resolve: (harnessId: HarnessId) => {
      const found = harnessRoots.get(harnessId);
      if (!found) {
        throw new Error(`Unknown harness id '${harnessId}' in PrismSandbox roots`);
      }
      return found;
    },
  };

  return {
    root,
    prismHome,
    roots,
    rootFor: (harnessId: HarnessId) => roots.resolve(harnessId),
    cleanup: async () => {
      await cleanupPrismMcpProcessesUnder(root).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Run `fn` inside a fresh sandbox, then tear it down. Re-throws any error
 * after cleanup so tests fail loudly.
 */
export async function withPrismSandbox<T>(fn: (sandbox: PrismSandbox) => Promise<T>): Promise<T> {
  const sandbox = await createPrismSandbox();
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}

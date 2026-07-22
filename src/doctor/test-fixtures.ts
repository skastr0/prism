/**
 * Composable builders for doctor contract tests.
 *
 * `DoctorWorld` wraps a `PrismSandbox` with helpers that create the disk states
 * that cause `runDoctor` to emit specific findings. Each test gets its own
 * world; there is no shared harness home.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runDoctor, type DoctorReport } from "../doctor.js";
import { computeContentHash } from "../content-hash.js";
import { commitSnapshot } from "../state/store.js";
import type { SnapshotManifest } from "../state/snapshot.js";
import { createPrismSandbox, type PrismSandbox } from "../testing/prism-sandbox.js";
import type { HarnessId } from "../types.js";

export class DoctorWorld {
  readonly sandbox: PrismSandbox;
  pluginPath?: string;

  constructor(sandbox: PrismSandbox) {
    this.sandbox = sandbox;
  }

  /** Resolve the temp global root for a harness. */
  rootFor(harnessId: HarnessId): string {
    return this.sandbox.rootFor(harnessId);
  }

  /** Write text to an absolute path, creating parent directories. */
  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  /** Persist a snapshot manifest into the sandbox PRISM_HOME. */
  async withSnapshot(manifest: SnapshotManifest): Promise<void> {
    await commitSnapshot({ prismHome: this.sandbox.prismHome, manifest });
  }

  /** Write Codex `config.toml` content. */
  async withCodexToml(content: string): Promise<void> {
    await this.writeText(join(this.rootFor("codex-cli"), "config.toml"), content);
  }

  /** Write OpenCode `opencode.json` content. */
  async withOpenCodeJson(content: string): Promise<void> {
    await this.writeText(join(this.rootFor("opencode"), "opencode.json"), content);
  }

  /**
   * Create a generated Claude plugin skeleton.
   * Only writes the files that doctor inspects: `.mcp.json` and
   * `hooks/hooks.json` when requested.
   */
  async withClaudePlugin(
    name: string,
    options: {
      readonly mcp?: Record<string, unknown>;
      readonly hooks?: unknown;
    } = {},
  ): Promise<void> {
    const pluginRoot = join(this.rootFor("claude-code"), "skills", `prism-generated-${name}`);
    if (options.mcp) {
      await this.writeText(join(pluginRoot, ".mcp.json"), JSON.stringify(options.mcp, null, 2));
    }
    if (options.hooks !== undefined) {
      await this.writeText(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify(options.hooks, null, 2));
    }
  }

  /** Write a placeholder tool-runtime path (MCP bundles removed). */
  async withMcpBundle(pluginName: string, toolNames: readonly string[]): Promise<void> {
    const path = join(this.sandbox.prismHome, "runtime", "mcp", pluginName, "server.mjs");
    await this.writeText(path, toolNames.join("\n"));
  }

  /**
   * Create a minimal plugin on disk and remember its path.
   * `manifest` is merged with `{ name, version: "0.1.0" }`.
   * `files` is a map of relative paths to file contents.
   */
  async withPlugin(
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ): Promise<void> {
    const root = join(this.sandbox.root, "plugins", name);
    this.pluginPath = root;
    await this.writeText(
      join(root, "plugin.json"),
      JSON.stringify({ version: "0.1.0", ...manifest, name }, null, 2),
    );
    for (const [relativePath, content] of Object.entries(files)) {
      await this.writeText(join(root, relativePath), content);
    }
  }

  /** Utility wrapper for tests that need a content hash. */
  hash(content: string): string {
    return computeContentHash(content);
  }
}

export async function createDoctorWorld(): Promise<DoctorWorld> {
  return new DoctorWorld(await createPrismSandbox());
}

export async function withDoctorWorld<T>(fn: (world: DoctorWorld) => Promise<T>): Promise<T> {
  const world = await createDoctorWorld();
  try {
    return await fn(world);
  } finally {
    await world.sandbox.cleanup();
  }
}

export async function runDoctorOnWorld(
  world: DoctorWorld,
  options: { readonly fix?: boolean; readonly harnesses?: readonly HarnessId[] } = {},
): Promise<DoctorReport> {
  return runDoctor({
    ...(world.pluginPath ? { pluginPath: world.pluginPath } : {}),
    harnesses: options.harnesses ?? ["opencode", "codex-cli", "claude-code"],
    scope: "global",
    prismHome: world.sandbox.prismHome,
    roots: world.sandbox.roots,
    fix: options.fix ?? false,
  });
}

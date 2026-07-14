#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

interface Args {
  readonly pluginsRoot: string;
  readonly keep: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (): Args => {
  let pluginsRoot = resolve(repoRoot, "..", "prism-plugins");
  let keep = false;

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--plugins") {
      const value = process.argv[index + 1];
      if (!value) throw new Error("--plugins requires a path");
      pluginsRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { pluginsRoot, keep };
};

const run = async (
  label: string,
  command: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> },
): Promise<string> => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
  return stdout;
};

const runCleanup = async (
  command: readonly string[],
  env: Record<string, string>,
): Promise<void> => {
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return;
  if (stdout.length > 0) process.stderr.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readOptionalText = async (path: string): Promise<string | undefined> =>
  (await pathExists(path)) ? await readFile(path, "utf8") : undefined;

const walkFiles = async (root: string): Promise<string[]> => {
  if (!(await pathExists(root))) return [];
  const info = await stat(root);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

const hashText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const snapshotTree = async (root: string): Promise<ReadonlyArray<readonly [string, string]>> => {
  const snapshot: Array<readonly [string, string]> = [];
  for (const path of await walkFiles(root)) {
    snapshot.push([
      relative(root, path),
      hashText(await readFile(path, "utf8")),
    ]);
  }
  return snapshot;
};

const assertEqual = (label: string, left: unknown, right: unknown): void => {
  const leftJson = JSON.stringify(left, null, 2);
  const rightJson = JSON.stringify(right, null, 2);
  if (leftJson !== rightJson) {
    throw new Error(
      `${label} changed across warm refresh pass`,
    );
  }
};

const assertWarmOutputHasNoChurn = (stdout: string): void => {
  const forbiddenPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\s*stale\s+prune\b/mu, "stale compile prune operation"],
    [/^\s*(?:new|changed)\s+config\b/mu, "new or changed compile config operation"],
    [/^\s*(?:new|changed)\s+plugin\b/mu, "new or changed compile plugin file"],
    [/^\s*(?:new|changed)\s+md\b/mu, "new or changed compile markdown file"],
    [/^\s*(?:create|repair|patch-regions|prune|blocked)\b/mu, "non-skip refresh mutation"],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    const match = pattern.exec(stdout);
    if (!match) continue;
    const lineStart = stdout.lastIndexOf("\n", match.index) + 1;
    const lineEnd = stdout.indexOf("\n", match.index);
    const line = stdout.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    throw new Error(`Warm refresh emitted ${label}: ${line}`);
  }
};

const mcpTableNames = (toml: string): string[] => {
  const names: string[] = [];
  const quoted = /^\s*\[\s*(?:"mcp_servers"|mcp_servers)\s*\.\s*(["'])([^"']+)\1\s*\]\s*(?:#.*)?$/gmu;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(toml)) !== null) {
    names.push(match[2]!);
  }
  return names;
};

const assertNoDuplicateMcpTables = (toml: string | undefined): void => {
  if (!toml) return;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of mcpTableNames(toml)) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate Codex MCP table(s): ${[...duplicates].join(", ")}`);
  }
};

const assertNoOrphanHookBlocks = (toml: string | undefined): void => {
  if (!toml) return;
  const marker = /^\s*# --- prism codex-cli (begin|end): (.+) ---\s*$/u;
  const open = new Map<string, number>();
  const lines = toml.split(/\r?\n/u);

  for (const line of lines) {
    const match = marker.exec(line);
    if (match) {
      const plugin = match[2]!;
      open.set(plugin, (open.get(plugin) ?? 0) + (match[1] === "begin" ? 1 : -1));
      continue;
    }
    if (line.includes("prism hook ") && [...open.values()].every((count) => count === 0)) {
      throw new Error(`Codex hook body is outside a managed hook block: ${line}`);
    }
  }

  const unbalanced = [...open.entries()].filter(([, count]) => count !== 0);
  if (unbalanced.length > 0) {
    throw new Error(
      `Unbalanced Codex hook marker(s): ${unbalanced.map(([plugin]) => plugin).join(", ")}`,
    );
  }
};

const assertCodexConfigHealthy = async (configPath: string): Promise<void> => {
  const config = await readOptionalText(configPath);
  assertNoDuplicateMcpTables(config);
  assertNoOrphanHookBlocks(config);
};

const hasCodexStreamableMcp = (manifest: unknown): boolean => {
  if (!isRecord(manifest) || !isRecord(manifest.runtime)) return false;
  if (!isRecord(manifest.runtime.mcp)) return false;
  const codexConfig = manifest.runtime.mcp["codex-cli"];
  return isRecord(codexConfig) && codexConfig.transport === "streamable-http";
};

const streamableCodexPluginPaths = async (pluginsRoot: string): Promise<string[]> => {
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const pluginPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginPath = join(pluginsRoot, entry.name);
    const manifestPath = join(pluginPath, "plugin.json");
    const manifestText = await readOptionalText(manifestPath);
    if (!manifestText) continue;
    try {
      if (hasCodexStreamableMcp(JSON.parse(manifestText) as unknown)) {
        pluginPaths.push(pluginPath);
      }
    } catch {
      continue;
    }
  }
  return pluginPaths.sort((left, right) => left.localeCompare(right));
};

const stopStreamableCodexMcp = async (
  pluginPaths: readonly string[],
  env: Record<string, string>,
): Promise<void> => {
  for (const pluginPath of pluginPaths) {
    await runCleanup([
      "bun",
      "run",
      join(repoRoot, "src", "cli.ts"),
      "mcp",
      "stop",
      pluginPath,
      "--harness",
      "codex-cli",
      "--scope",
      "global",
    ], env);
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  if (!(await pathExists(args.pluginsRoot))) {
    throw new Error(`Plugin corpus not found: ${args.pluginsRoot}`);
  }

  const tempRootPrefix = ["prism", "refresh", "idempotency", ""].join("-");
  const tempRoot = await mkdtemp(join(tmpdir(), tempRootPrefix));
  const homeRoot = join(tempRoot, "home");
  const prismHome = join(tempRoot, "prism-home");
  const xdgRoot = join(tempRoot, "xdg");
  const codexRoot = join(homeRoot, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const snapshotsRoot = join(prismHome, "state", "roots");
  const backupsRoot = join(prismHome, "backups");
  const streamableMcpPlugins = await streamableCodexPluginPaths(args.pluginsRoot);
  const env = {
    HOME: homeRoot,
    PRISM_HOME: prismHome,
    XDG_CONFIG_HOME: xdgRoot,
  };

  let failed = true;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(xdgRoot, { recursive: true });

    const command = [
      "bun",
      "run",
      join(repoRoot, "src", "cli.ts"),
      "refresh",
      "--plugins",
      args.pluginsRoot,
      "--harness",
      "codex-cli",
      "--no-validate",
    ];

    await run("Cold refresh over plugin corpus", command, { env });
    await assertCodexConfigHealthy(configPath);
    const firstConfig = await readOptionalText(configPath);
    const firstSnapshots = await snapshotTree(snapshotsRoot);
    const firstBackups = await snapshotTree(backupsRoot);

    const warmStdout = await run("Warm refresh over plugin corpus", command, { env });
    await assertCodexConfigHealthy(configPath);
    assertWarmOutputHasNoChurn(warmStdout);
    assertEqual("Codex config", firstConfig, await readOptionalText(configPath));
    assertEqual("Prism snapshots", firstSnapshots, await snapshotTree(snapshotsRoot));
    assertEqual("Prism backups", firstBackups, await snapshotTree(backupsRoot));

    failed = false;
    console.log("\nRefresh idempotency gate passed.");
  } finally {
    await stopStreamableCodexMcp(streamableMcpPlugins, env);
    if (failed || args.keep) {
      console.error(`\nRefresh idempotency workspace preserved: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
};

await main();

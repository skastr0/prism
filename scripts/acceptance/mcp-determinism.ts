/**
 * Acceptance gate: mcp-determinism (overhaul WS3 regression net).
 *
 * Compiles the same MCP-bearing plugin (session-watch: stdio MCP server +
 * hook wrappers, no daemons) against sandboxed harness roots AND sandboxed
 * PRISM_HOMEs, then asserts three sub-gates over every emitted bundle
 * (the canonical union bundle at <PRISM_HOME>/runtime/mcp/<plugin>/server.mjs
 * plus the hook wrappers under the harness root):
 *
 *   cross-cwd        Two cold compiles whose only meaningful variables are
 *                    the process cwd (different directory depths) and the
 *                    PRISM_HOME must produce sha256-equal bundles. Bundle
 *                    bytes are f(plugin source, prism version, bun version).
 *   relocatability   No emitted bundle may contain `/Users/` absolute paths,
 *                    `Bearer ` literals, or `127.0.0.1:<digits>` literals;
 *                    no lowered config file may contain a `Bearer ` literal
 *                    where an env reference is supported (stdio codex).
 *   warm-same-cwd    Re-running the same compile with identical cwd +
 *                    PRISM_HOME + --root must leave every bundle hash
 *                    unchanged.
 *
 * The gate also asserts the WS3 placement contract: the MCP server bundle
 * lives ONLY under PRISM_HOME/runtime/mcp — never inside the harness root.
 * Never points at real harness roots or ~/.prism.
 *
 * Usage: bun scripts/acceptance/mcp-determinism.ts
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const PLUGIN_CORPUS = resolve(homedir(), "Projects", "prism-plugins");
const FIXTURE_PLUGIN = "session-watch";
const HARNESS = "codex-cli";

interface SubGate {
  readonly gate: string;
  readonly pass: boolean;
  readonly expected: "PASS" | "FAIL";
  readonly detail: string;
}

const run = async (
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const listFilesRecursively = async (root: string, current = root): Promise<string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

/** sha256 of every emitted bundle (.mjs) under labelled roots, keyed by label/relative path. */
const hashBundles = async (
  roots: ReadonlyArray<{ readonly label: string; readonly root: string }>,
): Promise<Map<string, string>> => {
  const hashes = new Map<string, string>();
  for (const { label, root } of roots) {
    for (const path of await listFilesRecursively(root).catch(() => [] as string[])) {
      if (!path.endsWith(".mjs")) continue;
      const content = await readFile(path);
      hashes.set(
        `${label}/${path.slice(root.length + 1)}`,
        createHash("sha256").update(content).digest("hex"),
      );
    }
  }
  return new Map([...hashes.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

const compareHashMaps = (
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): { readonly equal: boolean; readonly detail: string } => {
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const mismatches: string[] = [];
  for (const path of paths) {
    const leftHash = left.get(path);
    const rightHash = right.get(path);
    if (leftHash === rightHash) continue;
    if (leftHash === undefined) mismatches.push(`${path}: missing in run 1`);
    else if (rightHash === undefined) mismatches.push(`${path}: missing in run 2`);
    else mismatches.push(`${path}: ${leftHash.slice(0, 12)} != ${rightHash.slice(0, 12)}`);
  }
  return mismatches.length === 0
    ? { equal: true, detail: `${paths.length} bundle(s) sha256-equal` }
    : { equal: false, detail: `${mismatches.length}/${paths.length} bundle(s) differ: ${mismatches.join("; ")}` };
};

const RELOCATABILITY_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "/Users/ absolute path", regex: /\/Users\//u },
  // `Bearer ${...}` env templates are fine (the union bundle's HTTP runtime
  // composes the header from env at request time); a literal token is not.
  { name: "Bearer literal", regex: /Bearer (?!\$\{)/u },
  { name: "127.0.0.1:<port> literal", regex: /127\.0\.0\.1:\d/u },
];

const scanRelocatability = async (
  roots: ReadonlyArray<{ readonly label: string; readonly root: string }>,
): Promise<{ readonly pass: boolean; readonly detail: string; readonly scanned: number }> => {
  const offenders: string[] = [];
  let scanned = 0;
  const CONFIG_FILES = new Set(["config.toml", "mcp.json", ".mcp.json", "config.yaml"]);
  for (const { label, root } of roots) {
    for (const path of await listFilesRecursively(root).catch(() => [] as string[])) {
      const relative = path.slice(root.length + 1);
      const baseName = relative.split("/").at(-1) ?? relative;
      if (path.endsWith(".mjs")) {
        scanned += 1;
        const content = await readFile(path, "utf8");
        for (const pattern of RELOCATABILITY_PATTERNS) {
          const matches = content.match(new RegExp(pattern.regex.source, "gu"));
          if (matches && matches.length > 0) {
            offenders.push(`${label}/${relative}: ${matches.length}x ${pattern.name}`);
          }
        }
        continue;
      }
      // Configs that can reference tokens via env must never carry the
      // literal token value (stdio compiles must carry no Bearer at all).
      if (CONFIG_FILES.has(baseName)) {
        const content = await readFile(path, "utf8");
        if (/Bearer (?!\$\{)/u.test(content)) {
          offenders.push(`${label}/${relative}: Bearer literal in lowered config`);
        }
      }
    }
  }
  return offenders.length === 0
    ? { pass: scanned > 0, detail: `${scanned} bundle(s) + configs clean of /Users/, Bearer, 127.0.0.1:<port>`, scanned }
    : { pass: false, detail: offenders.join("; "), scanned };
};

const main = async (): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "prism-acc-mcpdet-"));
  const pluginDir = join(work, "plugin");
  // cwd A and cwd B sit at DIFFERENT directory depths: cwd-relative banner
  // paths then differ in their `../` prefixes, which is exactly the
  // nondeterminism this gate must catch (sibling cwds at equal depth would
  // produce identical relative strings and mask it).
  const cwdA = join(work, "cwd-a");
  const cwdB = join(work, "nested", "deeper", "cwd-b");
  const rootA = join(work, "root-a");
  const rootB = join(work, "root-b");
  const homeA = join(work, "home-a");
  const homeB = join(work, "home-b");

  const gates: SubGate[] = [];
  const compileFailures: string[] = [];

  const compileArgs = (rootDir: string): string[] => [
    "bun",
    CLI_PATH,
    "compile",
    pluginDir,
    "--harness",
    HARNESS,
    "--root",
    rootDir,
    "--mcp-lifecycle",
    "none",
  ];

  const compile = async (
    label: string,
    options: { readonly cwd: string; readonly home: string; readonly root: string; readonly cold: boolean },
  ): Promise<void> => {
    // Cold runs clear the plugin-local build cache (dist/.prism-cache) so a
    // cached bundle from the previous cwd cannot mask cross-cwd drift.
    if (options.cold) await rm(join(pluginDir, "dist"), { recursive: true, force: true });
    const result = await run(compileArgs(options.root), {
      cwd: options.cwd,
      env: { PRISM_HOME: options.home },
    });
    if (result.exitCode !== 0) {
      compileFailures.push(`${label}: exit ${result.exitCode}; stderr: ${result.stderr.trim().slice(0, 400)}`);
    }
  };

  try {
    // Plugin copy: compile writes dist/.prism-cache + prism.lock into the
    // plugin dir, so never run against the corpus checkout directly. The
    // plugin's hook/tool sources use bare `effect` / `prism` imports that
    // resolve via the corpus root's node_modules — symlink it next to the copy.
    await cp(join(PLUGIN_CORPUS, FIXTURE_PLUGIN), pluginDir, { recursive: true });
    await rm(join(pluginDir, "dist"), { recursive: true, force: true });
    await symlink(join(PLUGIN_CORPUS, "node_modules"), join(work, "node_modules"), "dir");
    await mkdir(cwdA, { recursive: true });
    await mkdir(cwdB, { recursive: true });
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });

    // Run 1: cold compile from cwd A. Bundles live under PRISM_HOME/runtime/mcp,
    // hook wrappers under the harness root — hash both with stable labels.
    await compile("run-1 (cold, cwd-a)", { cwd: cwdA, home: homeA, root: rootA, cold: true });
    const hashesRun1 = await hashBundles([
      { label: "root", root: rootA },
      { label: "home", root: join(homeA, "runtime", "mcp") },
    ]);

    // WS3 placement contract: the MCP server bundle is NEVER inside the
    // harness root and ALWAYS at the canonical PRISM_HOME path.
    const rootServerBundles = [...hashesRun1.keys()].filter(
      (key) => key.startsWith("root/") && key.endsWith("server.mjs"),
    );
    if (rootServerBundles.length > 0) {
      compileFailures.push(`server bundle leaked into harness root: ${rootServerBundles.join(", ")}`);
    }
    if (![...hashesRun1.keys()].some((key) => key.startsWith("home/") && key.endsWith("/server.mjs"))) {
      compileFailures.push("no canonical PRISM_HOME/runtime/mcp/<plugin>/server.mjs bundle was emitted");
    }

    // Gate C — warm re-run with identical cwd + home + root (cache kept warm).
    await compile("warm re-run (cwd-a)", { cwd: cwdA, home: homeA, root: rootA, cold: false });
    const hashesWarm = await hashBundles([
      { label: "root", root: rootA },
      { label: "home", root: join(homeA, "runtime", "mcp") },
    ]);
    const warm = compareHashMaps(hashesRun1, hashesWarm);
    gates.push({
      gate: "mcp-determinism:warm-same-cwd",
      pass: warm.equal && hashesRun1.size > 0 && compileFailures.length === 0,
      expected: "PASS",
      detail:
        compileFailures.length > 0
          ? `compile failed: ${compileFailures.join(" | ")}`
          : hashesRun1.size === 0
            ? "no bundles emitted — gate is vacuous"
            : warm.detail,
    });

    // Run 2: cold compile from cwd B (different depth), fresh home + root.
    await compile("run-2 (cold, cwd-b)", { cwd: cwdB, home: homeB, root: rootB, cold: true });
    const hashesRun2 = await hashBundles([
      { label: "root", root: rootB },
      { label: "home", root: join(homeB, "runtime", "mcp") },
    ]);

    // Gate A — cross-cwd determinism.
    const crossCwd = compareHashMaps(hashesRun1, hashesRun2);
    gates.push({
      gate: "mcp-determinism:cross-cwd",
      pass: crossCwd.equal && hashesRun1.size > 0 && compileFailures.length === 0,
      expected: "PASS",
      detail:
        compileFailures.length > 0
          ? `compile failed: ${compileFailures.join(" | ")}`
          : crossCwd.detail,
    });

    // Gate B — relocatability grep over every emitted bundle + config from both runs.
    const relocatability = await scanRelocatability([
      { label: "root-a", root: rootA },
      { label: "root-b", root: rootB },
      { label: "home-a", root: join(homeA, "runtime", "mcp") },
      { label: "home-b", root: join(homeB, "runtime", "mcp") },
    ]);
    gates.push({
      gate: "mcp-determinism:relocatability",
      pass: relocatability.pass,
      expected: "PASS",
      detail: relocatability.detail,
    });

    // Cleanup discipline: no compile subprocess may outlive its run.
    const orphanCheck = await run(["pgrep", "-fl", work]);
    if (orphanCheck.exitCode === 0 && orphanCheck.stdout.trim().length > 0) {
      compileFailures.push(`orphan process(es) referencing sandbox: ${orphanCheck.stdout.trim()}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  for (const gate of gates) {
    const status = gate.pass ? "PASS" : "FAIL";
    const expectation = gate.pass === (gate.expected === "PASS") ? "" : " (unexpected)";
    console.log(`${status}  ${gate.gate} — expected=${gate.expected}${expectation} — ${gate.detail}`);
  }

  const regressions = gates.filter((gate) => gate.expected === "PASS" && !gate.pass);
  const surprises = gates.filter((gate) => gate.expected === "FAIL" && gate.pass);
  const summary = {
    gate: "mcp-determinism",
    pass: gates.every((gate) => gate.pass),
    gates,
    details: {
      plugin: FIXTURE_PLUGIN,
      harness: HARNESS,
      transport: "stdio",
      ...(compileFailures.length > 0 ? { compileFailures } : {}),
      ...(regressions.length > 0
        ? { regressions: regressions.map((gate) => gate.gate) }
        : {}),
      ...(surprises.length > 0
        ? { note: `Expected-FAIL gate(s) went green (${surprises.map((g) => g.gate).join(", ")}).` }
        : { note: "WS3 landed: bundles are canonical PRISM_HOME union bundles with no baked identity; all gates expect PASS." }),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = regressions.length === 0 && compileFailures.length === 0 ? 0 : 1;
};

await main();

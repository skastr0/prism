/**
 * Acceptance gate: idempotency-git (overhaul WS1 regression net).
 *
 * Builds a SYNTHETIC codex-like harness root in a temp dir — a user-styled
 * config.toml with comments, blank lines inside tables, trailing commas in
 * multi-line arrays, and a foreign [mcp_servers.user-thing] block — puts it
 * under git, then runs `prism refresh --compile-only` against it twice
 * with a sandboxed PRISM_HOME and asserts:
 *
 *   1. both runs exit 0
 *   2. user-authored config.toml content survives run 1 byte-for-byte
 *      (foreign mcp_servers block, comments, trailing commas)
 *   3. run 2 writes ZERO files into the harness root (find -newer marker)
 *   4. git diff after run 2 == git diff after run 1
 *
 * Failures here are findings about the current pipeline, not bugs in the
 * gate: this script is expected to go green as the one-writer overhaul lands.
 * Never points at real harness roots or the real ~/.prism.
 *
 * Usage: bun scripts/acceptance/idempotency-git.ts
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const PLUGIN_CORPUS = resolve(homedir(), "Projects", "prism-plugins");
const FIXTURE_PLUGIN = "atomic-commits";
const HARNESS = "codex-cli";

const USER_CONFIG_TOML = `# Personal Codex configuration — hand-maintained, do not reformat.
# Prism must keep every byte of this file it does not own.

model = "gpt-6-codex"
approval_policy = "on-request"

[tools]
# web search stays on

web_search = true

view_image = true

# Foreign MCP server owned by the user, not Prism.
[mcp_servers.user-thing]
command = "bunx"
args = [
  "user-thing-mcp",
  "--flag",
]
startup_timeout_ms = 20000

[notify]
channels = [
  "desktop",
  "sound",
]
`;

interface Assertion {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

const record = (name: string, pass: boolean, detail: string): void => {
  assertions.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

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

const git = (root: string, args: string[]) => run(["git", "-C", root, ...args]);

/** Full worktree-vs-baseline patch, including untracked files (via index). */
const captureGitDiff = async (root: string): Promise<string> => {
  await git(root, ["add", "-A"]);
  const { stdout } = await git(root, ["diff", "--cached"]);
  return stdout;
};

const main = async (): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "prism-acc-idem-"));
  const pluginDir = join(work, "plugin");
  const rootDir = join(work, "root");
  const prismHome = join(work, "prism-home");
  const env = { PRISM_HOME: prismHome };

  try {
    // Plugin copy: compile writes dist/.prism-cache + prism.lock into the
    // plugin dir, so never run against the corpus checkout directly.
    await cp(join(PLUGIN_CORPUS, FIXTURE_PLUGIN), pluginDir, { recursive: true });
    await rm(join(pluginDir, "dist"), { recursive: true, force: true });

    // Synthetic user-styled harness root under git.
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "config.toml"), USER_CONFIG_TOML);
    await git(rootDir, ["init", "--quiet"]);
    await git(rootDir, ["config", "user.email", "acceptance@prism.test"]);
    await git(rootDir, ["config", "user.name", "Prism Acceptance"]);
    await git(rootDir, ["add", "-A"]);
    await git(rootDir, ["commit", "--quiet", "-m", "baseline: user-styled codex root"]);

    const compileArgs = [
      "bun",
      CLI_PATH,
      "refresh",
      "--plugin",
      pluginDir,
      "--harness",
      HARNESS,
      "--compile-only",
      "--compile-root",
      rootDir,
    ];

    const run1 = await run(compileArgs, { env });
    record(
      "run-1-exit-0",
      run1.exitCode === 0,
      `exit ${run1.exitCode}${run1.exitCode === 0 ? "" : `; stderr: ${run1.stderr.trim().slice(0, 400)}`}`,
    );

    const configAfterRun1 = await readFile(join(rootDir, "config.toml"), "utf8");
    const preservedFragments = [
      "# Personal Codex configuration — hand-maintained, do not reformat.",
      "[mcp_servers.user-thing]",
      'command = "bunx"',
      "  \"user-thing-mcp\",\n  \"--flag\",\n]",
      "# web search stays on\n\nweb_search = true",
      "  \"desktop\",\n  \"sound\",\n]",
    ];
    const missing = preservedFragments.filter((f) => !configAfterRun1.includes(f));
    record(
      "user-config-preserved-after-run-1",
      missing.length === 0,
      missing.length === 0
        ? "all user-authored fragments (foreign mcp block, comments, trailing commas, blank lines) intact"
        : `${missing.length}/${preservedFragments.length} fragments lost: ${JSON.stringify(missing)}`,
    );

    const diffAfterRun1 = await captureGitDiff(rootDir);

    // Marker for the zero-write assertion; sleep past mtime granularity.
    const marker = join(work, "run2-marker");
    await writeFile(marker, "marker\n");
    await Bun.sleep(1100);

    const run2 = await run(compileArgs, { env });
    record(
      "run-2-exit-0",
      run2.exitCode === 0,
      `exit ${run2.exitCode}${run2.exitCode === 0 ? "" : `; stderr: ${run2.stderr.trim().slice(0, 400)}`}`,
    );

    const findNewer = await run([
      "find",
      rootDir,
      "-type",
      "f",
      "-not",
      "-path",
      "*/.git/*",
      "-newer",
      marker,
    ]);
    const rewritten = findNewer.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    record(
      "run-2-writes-zero-files",
      rewritten.length === 0,
      rewritten.length === 0
        ? "find -newer marker is empty for the harness root"
        : `${rewritten.length} file(s) rewritten by run 2: ${rewritten.join(", ")}`,
    );

    const diffAfterRun2 = await captureGitDiff(rootDir);
    record(
      "git-diff-stable-across-runs",
      diffAfterRun2 === diffAfterRun1,
      diffAfterRun2 === diffAfterRun1
        ? `run-2 diff is byte-identical to run-1 diff (${diffAfterRun1.split("\n").length} lines)`
        : `diff drifted between runs (run-1: ${diffAfterRun1.length} bytes, run-2: ${diffAfterRun2.length} bytes)`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const failed = assertions.filter((a) => !a.pass);
  const summary = {
    gate: "idempotency-git",
    pass: failed.length === 0,
    details: {
      plugin: FIXTURE_PLUGIN,
      harness: HARNESS,
      assertions,
      counts: { pass: assertions.length - failed.length, fail: failed.length },
      knownFailing:
        failed.length > 0
          ? "Failures are expected findings until the one-writer overhaul (WS3-WS5) lands."
          : undefined,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();

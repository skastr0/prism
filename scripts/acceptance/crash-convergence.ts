/**
 * Acceptance gate: crash-convergence (overhaul WS1 regression net).
 *
 * For N=5 random kill points: starts a prism compile against a sandboxed
 * harness root + PRISM_HOME, kill -9s the process mid-run, re-runs the same
 * compile to completion, and asserts the harness root is byte-identical
 * (diff -r) to the output of a clean single run.
 *
 * Failures here are findings about the current pipeline, not bugs in the
 * gate: this script is expected to go green as the one-writer overhaul lands.
 * Never points at real harness roots or the real ~/.prism.
 *
 * Usage: bun scripts/acceptance/crash-convergence.ts
 */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const PLUGIN_CORPUS = resolve(homedir(), "Projects", "prism-plugins");
const FIXTURE_PLUGIN = "atomic-commits";
const HARNESS = "codex-cli";
const KILL_POINTS = 5;

interface CaseResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly killAfterMs?: number;
  readonly killedBeforeExit?: boolean;
}

const results: CaseResult[] = [];

const record = (result: CaseResult): void => {
  results.push(result);
  console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
};

const run = async (
  cmd: string[],
  options: { env?: Record<string, string | undefined>; killAfterMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }> => {
  const proc = Bun.spawn({
    cmd,
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.killAfterMs !== undefined) {
    killTimer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, options.killAfterMs);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (killTimer !== undefined) clearTimeout(killTimer);
  return { exitCode, stdout, stderr, killed };
};

const compileArgs = (pluginDir: string, rootDir: string): string[] => [
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

const setupSandbox = async (
  work: string,
  name: string,
): Promise<{ pluginDir: string; rootDir: string; prismHome: string }> => {
  const base = join(work, name);
  const pluginDir = join(base, "plugin");
  const rootDir = join(base, "root");
  const prismHome = join(base, "prism-home");
  // Plugin copy: compile writes dist/.prism-cache + prism.lock into the
  // plugin dir, so each case gets its own copy of the corpus plugin.
  await cp(join(PLUGIN_CORPUS, FIXTURE_PLUGIN), pluginDir, { recursive: true });
  await rm(join(pluginDir, "dist"), { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  return { pluginDir, rootDir, prismHome };
};

const main = async (): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "prism-acc-crash-"));

  try {
    // Clean single-run reference output.
    const reference = await setupSandbox(work, "reference");
    const started = Date.now();
    const cleanRun = await run(compileArgs(reference.pluginDir, reference.rootDir), {
      env: { PRISM_HOME: reference.prismHome },
    });
    const cleanDurationMs = Date.now() - started;
    record({
      name: "clean-reference-run",
      pass: cleanRun.exitCode === 0,
      detail:
        cleanRun.exitCode === 0
          ? `clean run converged in ${cleanDurationMs}ms`
          : `clean run failed (exit ${cleanRun.exitCode}): ${cleanRun.stderr.trim().slice(0, 400)}`,
    });

    for (let index = 1; index <= KILL_POINTS; index += 1) {
      const sandbox = await setupSandbox(work, `case-${index}`);
      const env = { PRISM_HOME: sandbox.prismHome };
      const args = compileArgs(sandbox.pluginDir, sandbox.rootDir);

      // Random kill point inside the measured clean-run window.
      const killAfterMs = Math.max(
        30,
        Math.floor(Math.random() * cleanDurationMs * 0.9),
      );
      const crashed = await run(args, { env, killAfterMs });

      // Re-run the same compile to completion.
      const rerun = await run(args, { env });
      if (rerun.exitCode !== 0) {
        record({
          name: `kill-point-${index}`,
          pass: false,
          killAfterMs,
          killedBeforeExit: crashed.killed,
          detail: `re-run after kill -9 @${killAfterMs}ms failed (exit ${rerun.exitCode}): ${rerun.stderr.trim().slice(0, 400)}`,
        });
        continue;
      }

      // Byte-identity of the harness root vs the clean reference output.
      const diff = await run(["diff", "-r", sandbox.rootDir, reference.rootDir]);
      record({
        name: `kill-point-${index}`,
        pass: diff.exitCode === 0,
        killAfterMs,
        killedBeforeExit: crashed.killed,
        detail:
          diff.exitCode === 0
            ? `kill -9 @${killAfterMs}ms (killed=${crashed.killed}) -> re-run converged; root byte-identical to clean run`
            : `root differs from clean run after kill -9 @${killAfterMs}ms: ${diff.stdout.trim().slice(0, 400)}`,
      });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  const summary = {
    gate: "crash-convergence",
    pass: failed.length === 0,
    details: {
      plugin: FIXTURE_PLUGIN,
      harness: HARNESS,
      killPoints: KILL_POINTS,
      results,
      counts: { pass: results.length - failed.length, fail: failed.length },
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

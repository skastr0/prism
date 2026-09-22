/**
 * Keeps the untracked build outputs the test suite depends on fresh, so plain
 * `bun test` works on a clean checkout (called from scripts/test-preload.ts).
 *
 *  - packages/prism-sdk/dist  (`bun run build:core`): src imports
 *    `@skastr0/prism-sdk/*`, which resolves through the package exports to dist/.
 *    A missing dist fails module resolution; a stale one fails at runtime.
 *  - dist/dts-tmp  (`bun scripts/build-dts.ts`): the "prism" declarations the
 *    workflow typecheck, loader, and CLI tests type-check against.
 *
 * Each artifact records a stamp: the repo files tsc read (`--listFiles`) and a
 * content hash over them plus bun.lock and the build inputs that tsc does not
 * list. A run rebuilds only when the stamp is missing or the hash moved, so the
 * warm path costs one hash over a few dozen files. Builds run under a
 * cross-process lock because `bun test --parallel` loads the preload in every
 * worker.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { dtsOutDir, prepareDtsEmit } from "./build-dts.js";

const repoRoot = resolve(import.meta.dir, "..");
const tscBin = join(repoRoot, "node_modules", ".bin", "tsc");
const lockDir = join(repoRoot, "dist", ".test-build.lock");
const LOCK_TIMEOUT_MS = 120_000;

interface Stamp {
  readonly hash: string;
  readonly inputs: readonly string[];
}

interface Artifact {
  readonly name: string;
  readonly command: string;
  readonly stampPath: string;
  /** Inputs tsc does not report via --listFiles (configs, lockfile, build script). */
  readonly extraInputs: readonly string[];
  /** Prepares the output and returns the tsc arguments that emit it. */
  readonly prepare: () => Promise<readonly string[]>;
}

const artifacts: readonly Artifact[] = [
  {
    name: "@skastr0/prism-sdk dist",
    command: "bun run build:core",
    stampPath: join(repoRoot, "packages", "prism-sdk", "dist", ".test-build-stamp.json"),
    extraInputs: ["bun.lock", "packages/prism-sdk/tsconfig.json", "scripts/test-build-artifacts.ts"],
    prepare: async () => ["-p", join(repoRoot, "packages", "prism-sdk", "tsconfig.json")],
  },
  {
    name: "prism authoring declarations (dist/dts-tmp)",
    command: "bun scripts/build-dts.ts",
    stampPath: join(dtsOutDir, ".test-build-stamp.json"),
    extraInputs: ["bun.lock", "scripts/build-dts.ts", "scripts/test-build-artifacts.ts"],
    prepare: async () => ["--project", await prepareDtsEmit()],
  },
];

const hashInputs = (inputs: readonly string[]): string | undefined => {
  const hash = createHash("sha256");
  for (const input of inputs) {
    const path = join(repoRoot, input);
    if (!existsSync(path)) return undefined;
    hash.update(input).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
};

const readStamp = (artifact: Artifact): Stamp | undefined => {
  try {
    return JSON.parse(readFileSync(artifact.stampPath, "utf8")) as Stamp;
  } catch {
    return undefined;
  }
};

const isFresh = (artifact: Artifact): boolean => {
  const stamp = readStamp(artifact);
  return stamp !== undefined && hashInputs(stamp.inputs) === stamp.hash;
};

const build = async (artifact: Artifact): Promise<void> => {
  const args = await artifact.prepare();
  const result = Bun.spawnSync([tscBin, ...args, "--listFiles"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    const diagnostics = stdout
      .split("\n")
      .filter((line) => line.length > 0 && !isAbsolute(line))
      .join("\n");
    throw new Error(
      `bun test preload: building the ${artifact.name} failed (tsc exit ${result.exitCode}).\n` +
        `${diagnostics}${result.stderr.toString()}\n` +
        `Fix the errors above, then re-run \`bun test\`; \`${artifact.command}\` reproduces the build alone.`,
    );
  }
  const listed = stdout
    .split("\n")
    .filter((line) => isAbsolute(line) && !line.includes("/node_modules/"))
    .map((line) => relative(repoRoot, line))
    .filter((path) => !path.startsWith(".."));
  const inputs = [...new Set([...listed, ...artifact.extraInputs])].sort();
  const hash = hashInputs(inputs);
  if (hash === undefined) {
    throw new Error(`bun test preload: an input of the ${artifact.name} vanished during the build; re-run \`bun test\`.`);
  }
  writeFileSync(artifact.stampPath, JSON.stringify({ hash, inputs } satisfies Stamp));
};

const lockOwnerAlive = (): boolean => {
  let pid: number;
  try {
    pid = Number(readFileSync(join(lockDir, "pid"), "utf8"));
  } catch {
    // The owner creates the directory before writing its pid; give it a moment
    // before treating a pid-less lock as abandoned.
    try {
      return Date.now() - statSync(lockDir).mtimeMs < 5_000;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const withBuildLock = async (body: () => Promise<void>): Promise<void> => {
  mkdirSync(join(repoRoot, "dist"), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lockOwnerAlive()) {
        // A crashed builder left the lock behind.
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `bun test preload: another process has held ${lockDir} for over ${LOCK_TIMEOUT_MS / 1000}s. ` +
            "If no other test run is building, remove that directory and re-run `bun test`.",
        );
      }
      Bun.sleepSync(100);
    }
  }
  try {
    await body();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
};

/** Rebuilds every stale test build artifact, in dependency order. */
export const ensureTestBuildArtifacts = async (): Promise<void> => {
  if (artifacts.every(isFresh)) return;
  await withBuildLock(async () => {
    // Re-check under the lock: a concurrent worker may have just built.
    for (const artifact of artifacts) {
      if (!isFresh(artifact)) await build(artifact);
    }
  });
};

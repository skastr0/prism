/**
 * Test hygiene guard: proves a command (typically `bun test`) does not touch
 * the real `~/.prism`.
 *
 * Snapshots the full file tree of the real Prism home (sorted relative paths
 * + per-file sha256) and verifies byte-identity afterwards.
 *
 * Usage:
 *   bun scripts/test-hygiene-guard.ts snapshot [--out <path>]
 *   bun scripts/test-hygiene-guard.ts verify   [--out <path>]
 *   bun scripts/test-hygiene-guard.ts run -- <command...>
 *
 * `run` snapshots, executes the command, then verifies — and fails if either
 * the command or the verification fails. Wired as `bun run test:guarded`.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

const REAL_PRISM_HOME = join(homedir(), ".prism");
const DEFAULT_SNAPSHOT_PATH = join(tmpdir(), "prism-test-hygiene-snapshot.json");

interface TreeSnapshot {
  readonly root: string;
  readonly takenAt: string;
  readonly files: Record<string, string>;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const listFilesRecursive = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(path)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(path);
    }
  }
  return out;
};

const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const files: Record<string, string> = {};
  const rootExists = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (rootExists) {
    for (const path of (await listFilesRecursive(root)).sort()) {
      files[relative(root, path)] = sha256(await readFile(path));
    }
  }
  return { root, takenAt: new Date().toISOString(), files };
};

const diffSnapshots = (
  before: TreeSnapshot,
  after: TreeSnapshot,
): { added: string[]; removed: string[]; changed: string[] } => {
  const added = Object.keys(after.files).filter((f) => !(f in before.files));
  const removed = Object.keys(before.files).filter((f) => !(f in after.files));
  const changed = Object.keys(after.files).filter(
    (f) => f in before.files && before.files[f] !== after.files[f],
  );
  return { added, removed, changed };
};

const parseArgs = (
  argv: string[],
): { mode: string; out: string; command: string[] } => {
  const [mode = "", ...rest] = argv;
  let out = DEFAULT_SNAPSHOT_PATH;
  const command: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "--out") {
      out = rest[i + 1] ?? out;
      i += 1;
    } else if (arg === "--") {
      command.push(...rest.slice(i + 1));
      break;
    } else {
      command.push(arg);
    }
  }
  return { mode, out, command };
};

const takeSnapshot = async (out: string): Promise<void> => {
  const snapshot = await snapshotTree(REAL_PRISM_HOME);
  await Bun.write(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `hygiene-guard: snapshot of ${REAL_PRISM_HOME} (${Object.keys(snapshot.files).length} files) -> ${out}`,
  );
};

const verifySnapshot = async (out: string): Promise<boolean> => {
  const before = JSON.parse(await readFile(out, "utf8")) as TreeSnapshot;
  const after = await snapshotTree(REAL_PRISM_HOME);
  const { added, removed, changed } = diffSnapshots(before, after);
  const clean = added.length === 0 && removed.length === 0 && changed.length === 0;
  if (clean) {
    console.log(
      `hygiene-guard: PASS — ${REAL_PRISM_HOME} is byte-identical (${Object.keys(after.files).length} files).`,
    );
    return true;
  }
  console.error(`hygiene-guard: FAIL — real ${REAL_PRISM_HOME} was mutated:`);
  for (const file of added) console.error(`  added:   ${file}`);
  for (const file of removed) console.error(`  removed: ${file}`);
  for (const file of changed) console.error(`  changed: ${file}`);
  return false;
};

const runGuarded = async (out: string, command: string[]): Promise<number> => {
  if (command.length === 0) {
    console.error("hygiene-guard: 'run' requires a command after '--'.");
    return 2;
  }
  await takeSnapshot(out);
  const child = Bun.spawn({
    cmd: command,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const commandExit = await child.exited;
  const clean = await verifySnapshot(out);
  if (!clean) return 1;
  return commandExit;
};

const main = async (): Promise<void> => {
  const { mode, out, command } = parseArgs(process.argv.slice(2));
  switch (mode) {
    case "snapshot":
      await takeSnapshot(out);
      return;
    case "verify":
      process.exitCode = (await verifySnapshot(out)) ? 0 : 1;
      return;
    case "run":
      process.exitCode = await runGuarded(out, command);
      return;
    default:
      console.error(
        "Usage: bun scripts/test-hygiene-guard.ts <snapshot|verify|run> [--out <path>] [-- <command...>]",
      );
      process.exitCode = 2;
  }
};

await main();

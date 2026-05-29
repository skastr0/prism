import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backupManagedTarget, managedBackupTargetRoot } from "./managed-backups.js";
import {
  emptyHarnessLedger,
  managedEntryId,
  readHarnessLedger,
  upsertLedgerEntries,
  writeHarnessLedger,
} from "./managed-ledger.js";
import {
  defaultPrismConfig,
  prismConfigPath,
  readPrismConfig,
  resolvePrismHome,
} from "./prism-home.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-home-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("resolvePrismHome honors PRISM_HOME", async () => {
  const root = await createTempRoot();
  process.env.PRISM_HOME = root;

  expect(resolvePrismHome()).toBe(root);
});

test("readPrismConfig returns managed backup defaults when config is absent", async () => {
  const root = await createTempRoot();

  expect(await readPrismConfig(root)).toEqual(defaultPrismConfig());
});

test("readPrismConfig validates config shape and positive retention", async () => {
  const root = await createTempRoot();
  await writeText(
    prismConfigPath(root),
    `${JSON.stringify({ version: 1, backup: { mode: "always", retentionPerTarget: 0 } })}\n`,
  );

  await expect(readPrismConfig(root)).rejects.toThrow(/positive integer/);
});

test("harness ledger read and write are schema validated", async () => {
  const root = await createTempRoot();
  const ledger = emptyHarnessLedger("opencode");
  const entryId = managedEntryId({
    harness: "opencode",
    scope: "global",
    root: "/tmp/opencode",
    pluginName: "demo",
    artifact: "skill",
    kind: "file",
    sourcePath: "skills/demo/SKILL.md",
    targetPath: "/tmp/opencode/skills/demo/SKILL.md",
  });

  await writeHarnessLedger(
    upsertLedgerEntries(ledger, [
      {
        id: entryId,
        pluginName: "demo",
        pluginVersion: "0.1.0",
        pluginPath: "/plugins/demo",
        harness: "opencode",
        scope: "global",
        root: "/tmp/opencode",
        artifact: "skill",
        sourcePath: "skills/demo/SKILL.md",
        targetPath: "/tmp/opencode/skills/demo/SKILL.md",
        kind: "file",
        contentHash: "abc123",
        updatedAt: "2026-05-29T00:00:00.000Z",
      },
    ]),
    root,
  );

  expect(await readHarnessLedger("opencode", root)).toMatchObject({
    version: 1,
    harness: "opencode",
    entries: [{ id: entryId, contentHash: "abc123" }],
  });
});

test("readHarnessLedger fails closed on harness mismatch", async () => {
  const root = await createTempRoot();
  await writeText(
    join(root, "state", "opencode.ledger.json"),
    `${JSON.stringify({ version: 1, harness: "claude-code", entries: [] })}\n`,
  );

  await expect(readHarnessLedger("opencode", root)).rejects.toThrow(/harness mismatch/);
});

test("backupManagedTarget stores original filenames under Prism home and rolls retention", async () => {
  const root = await createTempRoot();
  const target = join(root, "harness", "skills", "demo", "SKILL.md");
  await writeText(target, "one\n");
  const config = { version: 1 as const, backup: { mode: "always" as const, retentionPerTarget: 3 } };

  for (const [index, content] of ["one\n", "two\n", "three\n", "four\n"].entries()) {
    await writeText(target, content);
    await backupManagedTarget({
      harness: "opencode",
      scope: "global",
      targetPath: target,
      operation: "write",
      prismHome: root,
      config,
      now: new Date(`2026-05-29T00:00:0${index}.000Z`),
    });
  }

  const backupRoot = managedBackupTargetRoot({
    harness: "opencode",
    scope: "global",
    targetPath: target,
    prismHome: root,
  });
  const events = (await import("node:fs/promises")).readdir(backupRoot);
  await expect(events).resolves.toHaveLength(3);

  const newest = join(backupRoot, "20260529T000003000Z-write", "SKILL.md");
  expect(await readFile(newest, "utf8")).toBe("four\n");
});

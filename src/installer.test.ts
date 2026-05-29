import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, planInstallation } from "./installer.js";
import { readHarnessLedger } from "./managed-ledger.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-installer-"));
  tempRoots.push(root);
  process.env.PRISM_HOME = join(root, "prism-home");
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

test("planInstallation does not adopt legacy rule markers without a ledger", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "rules-demo",
      version: "0.1.0",
      targets: { rules: ["opencode"] },
    })}\n`,
  );
  await writeText(join(pluginPath, "rules", "project", "context.md"), "Project rules\n");
  await writeText(
    join(projectPath, "AGENTS.md"),
    "<!-- BEGIN: context -->\nProject rules\n<!-- END: context -->\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    type: "append",
    artifact: "rules",
    harness: "opencode",
    source: join(pluginPath, "rules", "project", "context.md"),
    target: join(projectPath, "AGENTS.md"),
    managed: {
      kind: "section",
      pluginName: "rules-demo",
      sourcePath: "project/context.md",
    },
  });
});

test("install records managed rule sections and later plans unchanged as skip", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "rules-demo",
      version: "0.1.0",
      targets: { rules: ["opencode"] },
    })}\n`,
  );
  await writeText(join(pluginPath, "rules", "project", "context.md"), "Project rules\n");

  const first = await install({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });
  expect(first.success).toBe(true);
  expect(await readFile(join(projectPath, "AGENTS.md"), "utf8")).toContain(
    "prism:managed-section begin",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    type: "skip",
    reason: "Content already exists and is identical",
    managed: { kind: "section", pluginName: "rules-demo" },
  });
});

test("install updates managed rule sections with Prism-home backups", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "rules-update-demo",
      version: "0.1.0",
      targets: { rules: ["opencode"] },
    })}\n`,
  );
  await writeText(join(pluginPath, "rules", "project", "context.md"), "Project rules\n");

  await install({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });
  await writeText(join(pluginPath, "rules", "project", "context.md"), "Updated rules\n");

  const second = await install({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });

  expect(second.success).toBe(true);
  expect(second.backups).toHaveLength(1);
  expect(second.backups[0]).toContain(join(process.env.PRISM_HOME!, "backups", "opencode"));
  expect(second.backups[0]).not.toContain(".bak");
  expect(await readFile(join(projectPath, "AGENTS.md"), "utf8")).toContain("Updated rules");
});

test("planInstallation copies project rules into rulesDir with mdc extension", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-rules-demo",
      version: "0.1.0",
      targets: { rules: ["cursor"] },
    })}\n`,
  );
  await writeText(join(pluginPath, "rules", "project", "policy.md"), "Cursor rules\n");

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["cursor"],
    projectPath,
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    type: "copy",
    source: join(pluginPath, "rules", "project", "policy.md"),
    target: join(projectPath, ".cursor", "rules", "policy.mdc"),
    harness: "cursor",
    artifact: "rules",
    managed: {
      kind: "file",
      pluginName: "cursor-rules-demo",
      sourcePath: "project/policy.md",
    },
  });
});

test("install prunes stale ledger-owned whole-file project rules", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const sourcePath = join(pluginPath, "rules", "project", "policy.md");
  const targetPath = join(projectPath, ".cursor", "rules", "policy.mdc");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-rules-demo",
      version: "0.1.0",
      targets: { rules: ["cursor"] },
    })}\n`,
  );
  await writeText(sourcePath, "Cursor rules\n");

  await install({
    pluginPath,
    harnesses: ["cursor"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });
  await rm(sourcePath);

  const second = await install({
    pluginPath,
    harnesses: ["cursor"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });

  expect(second.success).toBe(true);
  expect(second.operations).toContainEqual(
    expect.objectContaining({ type: "prune", target: targetPath }),
  );
  await expect(readFile(targetPath, "utf8")).rejects.toThrow();
  expect((await readHarnessLedger("cursor")).entries).toHaveLength(0);
});

test("planInstallation fails closed on drifted ledger-owned files", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const targetPath = join(projectPath, ".cursor", "rules", "policy.mdc");
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-rules-demo",
      version: "0.1.0",
      targets: { rules: ["cursor"] },
    })}\n`,
  );
  await writeText(join(pluginPath, "rules", "project", "policy.md"), "Cursor rules\n");

  await install({
    pluginPath,
    harnesses: ["cursor"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });
  await writeText(targetPath, "manual edit\n");

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["cursor"],
    projectPath,
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    type: "drift",
    reason: "Managed target changed outside Prism",
    target: targetPath,
  });
});

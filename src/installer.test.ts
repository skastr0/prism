import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planInstallation } from "./installer.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-installer-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("planInstallation skips identical project rule append sections", async () => {
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
    backup: false,
    dryRun: true,
  });

  expect(operations).toEqual([
    {
      type: "skip",
      source: join(pluginPath, "rules", "project", "context.md"),
      target: join(projectPath, "AGENTS.md"),
      harness: "opencode",
      artifact: "rules",
      reason: "Content already exists and is identical",
    },
  ]);
});

test("planInstallation marks changed project rule append sections for update", async () => {
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
  await writeText(
    join(projectPath, "AGENTS.md"),
    "<!-- BEGIN: context -->\nOld rules\n<!-- END: context -->\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["opencode"],
    projectPath,
    overwrite: false,
    backup: false,
    dryRun: true,
  });

  expect(operations).toEqual([
    {
      type: "append",
      source: join(pluginPath, "rules", "project", "context.md"),
      target: join(projectPath, "AGENTS.md"),
      harness: "opencode",
      artifact: "rules",
      reason: "Updating existing section",
    },
  ]);
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
    backup: false,
    dryRun: true,
  });

  expect(operations).toEqual([
    {
      type: "copy",
      source: join(pluginPath, "rules", "project", "policy.md"),
      target: join(projectPath, ".cursor", "rules", "policy.mdc"),
      harness: "cursor",
      artifact: "rules",
    },
  ]);
});

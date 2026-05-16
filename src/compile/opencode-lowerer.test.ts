import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComposedAgent } from "./compose.js";
import { executeLowering, planLowering, type LowerOperation } from "./lowerers/opencode.js";
import type { ResolvedContractBinding } from "./resolve.js";
import { Contract } from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-opencode-lowerer-"));
  tempRoots.push(root);
  return root;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const createComposedAgent = (
  toolBindings: ReadonlyArray<ResolvedContractBinding>,
): ComposedAgent => ({
  name: "worker",
  description: "Worker agent",
  body: "# Worker\n",
  color: undefined,
  model: undefined,
  targetOverride: {},
  skills: [],
  allowedSkills: [],
  toolBindings,
  allowedTools: [],
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("opencode executeLowering skips every operation during dry run", async () => {
  const root = await createTempRoot();
  const mdTarget = join(root, "agents", "builder.md");
  const jsonTarget = join(root, "opencode.json");

  const result = await executeLowering(
    [
      {
        kind: "write-md",
        target: mdTarget,
        content: "new markdown",
        reason: "new",
      },
      {
        kind: "patch-json",
        target: jsonTarget,
        agentName: "builder",
        nextBlock: { model: "openai/gpt-5.4" },
        reason: "new",
      },
    ],
    { backup: true, dryRun: true },
  );

  expect(result.backups).toEqual([]);
  expect(await pathExists(mdTarget)).toBe(false);
  expect(await pathExists(jsonTarget)).toBe(false);
});

test("opencode executeLowering applies mixed operations and aggregates config patches", async () => {
  const root = await createTempRoot();
  const mdTarget = join(root, "agents", "builder.md");
  const pluginTarget = join(root, "plugins", "generated", "dist", "server.mjs");
  const skippedTarget = join(root, "agents", "skipped.md");
  const pruneFileTarget = join(root, "plugins", "generated", "stale.txt");
  const pruneDirTarget = join(root, "plugins", "generated", "stale-dir");
  const jsonTarget = join(root, "opencode.json");

  await writeText(mdTarget, "old markdown");
  await writeText(pluginTarget, "old plugin");
  await writeText(pruneFileTarget, "stale file");
  await writeText(join(pruneDirTarget, "nested.txt"), "stale dir");
  await writeText(
    jsonTarget,
    `${JSON.stringify(
      {
        agent: {
          builder: { model: "old" },
          reviewer: { model: "kept" },
        },
        plugin: ["old-plugin", "remove-plugin"],
        permission: {
          "old_*": "ask",
          "remove_*": "deny",
        },
      },
      null,
      2,
    )}\n`,
  );

  const operations: LowerOperation[] = [
    {
      kind: "write-md",
      target: mdTarget,
      content: "new markdown",
      reason: "changed",
    },
    {
      kind: "write-plugin-file",
      target: pluginTarget,
      content: "new plugin",
      reason: "changed",
    },
    {
      kind: "write-md",
      target: skippedTarget,
      content: "should not write",
      reason: "unchanged",
    },
    {
      kind: "prune-plugin-path",
      target: pruneFileTarget,
      targetType: "file",
      reason: "stale",
    },
    {
      kind: "prune-plugin-path",
      target: pruneDirTarget,
      targetType: "dir",
      reason: "stale",
    },
    {
      kind: "patch-json",
      target: jsonTarget,
      agentName: "builder",
      nextBlock: { model: "next", mode: "subagent" },
      reason: "changed",
    },
    {
      kind: "patch-json",
      target: jsonTarget,
      agentName: "skipped",
      nextBlock: { model: "skip" },
      reason: "unchanged",
    },
    {
      kind: "patch-opencode-plugins",
      target: jsonTarget,
      pluginEntry: "new-plugin",
      desiredPresent: true,
      reason: "new",
    },
    {
      kind: "patch-opencode-plugins",
      target: jsonTarget,
      pluginEntry: "remove-plugin",
      desiredPresent: false,
      reason: "changed",
    },
    {
      kind: "patch-opencode-permission",
      target: jsonTarget,
      permissionKey: "new_*",
      desiredAction: "deny",
      reason: "new",
    },
    {
      kind: "patch-opencode-permission",
      target: jsonTarget,
      permissionKey: "remove_*",
      desiredAction: undefined,
      reason: "changed",
    },
  ];

  const result = await executeLowering(operations, { backup: true, dryRun: false });

  expect(result.backups).toEqual([`${mdTarget}.bak`, `${jsonTarget}.bak`]);
  expect(await readFile(`${mdTarget}.bak`, "utf8")).toBe("old markdown");
  expect(await pathExists(`${pluginTarget}.bak`)).toBe(false);
  expect(await readFile(mdTarget, "utf8")).toBe("new markdown");
  expect(await readFile(pluginTarget, "utf8")).toBe("new plugin");
  expect(await pathExists(skippedTarget)).toBe(false);
  expect(await pathExists(pruneFileTarget)).toBe(false);
  expect(await pathExists(pruneDirTarget)).toBe(false);

  const config = await readJson<Record<string, unknown>>(jsonTarget);
  expect(config).toEqual({
    agent: {
      builder: { model: "next", mode: "subagent" },
      reviewer: { model: "kept" },
    },
    plugin: ["old-plugin", "new-plugin"],
    permission: {
      "old_*": "ask",
      "new_*": "deny",
    },
  });
});

test("opencode executeLowering skips unchanged operations without backups", async () => {
  const root = await createTempRoot();
  const mdTarget = join(root, "agents", "builder.md");
  const jsonTarget = join(root, "opencode.json");

  await writeText(mdTarget, "old markdown");
  await writeText(
    jsonTarget,
    `${JSON.stringify({ agent: { builder: { model: "old" } } }, null, 2)}\n`,
  );

  const result = await executeLowering(
    [
      {
        kind: "write-md",
        target: mdTarget,
        content: "new markdown",
        reason: "unchanged",
      },
      {
        kind: "patch-json",
        target: jsonTarget,
        agentName: "builder",
        nextBlock: { model: "new" },
        reason: "unchanged",
      },
    ],
    { backup: true, dryRun: false },
  );

  expect(result.backups).toEqual([]);
  expect(await readFile(mdTarget, "utf8")).toBe("old markdown");
  expect(await pathExists(`${mdTarget}.bak`)).toBe(false);
  expect(await readJson<Record<string, unknown>>(jsonTarget)).toEqual({
    agent: { builder: { model: "old" } },
  });
  expect(await pathExists(`${jsonTarget}.bak`)).toBe(false);
});

test("opencode executeLowering preserves plugin keys and deletes empty permission keys", async () => {
  const root = await createTempRoot();
  const jsonTarget = join(root, "opencode.json");

  await writeText(
    jsonTarget,
    `${JSON.stringify(
      {
        plugin: ["remove-plugin"],
        permission: { "remove_*": "deny" },
      },
      null,
      2,
    )}\n`,
  );

  await executeLowering(
    [
      {
        kind: "patch-opencode-plugins",
        target: jsonTarget,
        pluginEntry: "remove-plugin",
        desiredPresent: false,
        reason: "changed",
      },
      {
        kind: "patch-opencode-permission",
        target: jsonTarget,
        permissionKey: "remove_*",
        desiredAction: undefined,
        reason: "changed",
      },
    ],
    { backup: false, dryRun: false },
  );

  expect(await readJson<Record<string, unknown>>(jsonTarget)).toEqual({
    plugin: [],
    agent: {},
  });
});

test("opencode executeLowering deletes absent empty plugin keys and normalizes scalar permissions", async () => {
  const root = await createTempRoot();
  const jsonTarget = join(root, "opencode.json");

  await writeText(jsonTarget, `${JSON.stringify({ permission: "allow" }, null, 2)}\n`);

  await executeLowering(
    [
      {
        kind: "patch-opencode-plugins",
        target: jsonTarget,
        pluginEntry: "missing-plugin",
        desiredPresent: false,
        reason: "changed",
      },
      {
        kind: "patch-opencode-permission",
        target: jsonTarget,
        permissionKey: "generated_*",
        desiredAction: "deny",
        reason: "new",
      },
    ],
    { backup: false, dryRun: false },
  );

  expect(await readJson<Record<string, unknown>>(jsonTarget)).toEqual({
    permission: {
      "*": "allow",
      "generated_*": "deny",
    },
    agent: {},
  });
});

test("opencode planLowering reports generated contract mirror collisions", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");
  const pluginRoot = join(root, "mirror-demo");
  const sourcePath = join(pluginRoot, "tools", "submit.tool.ts");
  const generatedPath = "contracts/submit.contract.ts";

  const firstContract = new Contract({
    name: "submit-a",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [{ relativePath: generatedPath, content: "export const value = 1;\n" }],
  });
  const secondContract = new Contract({
    name: "submit-b",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [{ relativePath: generatedPath, content: "export const value = 2;\n" }],
  });

  await expect(
    planLowering({
      agents: [
        createComposedAgent([
          {
            kind: "synthetic",
            logicalName: "submitA",
            contract: firstContract,
            toolPluginName: "mirror-demo",
            toolName: "submit-a",
            toolSourcePath: sourcePath,
          },
          {
            kind: "synthetic",
            logicalName: "submitB",
            contract: secondContract,
            toolPluginName: "mirror-demo",
            toolName: "submit-b",
            toolSourcePath: sourcePath,
          },
        ]),
      ],
      orbits: [],
      tools: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: "mirror-demo",
      },
    }),
  ).rejects.toThrow(
    "generated contract name collision at mirror-demo:contracts/submit.contract.ts",
  );
});

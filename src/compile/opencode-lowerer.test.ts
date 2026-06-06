import { afterEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComposedAgent } from "./compose.js";
import { executeLowering, planLowering, type LowerOperation } from "./lowerers/opencode.js";
import { executeStandardLowering } from "./lowerers/shared.js";
import { readHarnessLedger } from "../managed-ledger.js";
import type { ResolvedContractBinding } from "./resolve.js";
import { Contract } from "./sources.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-opencode-lowerer-"));
  tempRoots.push(root);
  process.env.PRISM_HOME = join(root, "prism-home");
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
  process.env.PRISM_HOME = originalPrismHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const opencodeExecutionTarget = (root: string) => ({
  harness: "opencode" as const,
  scope: "global" as const,
  root,
  sourcePluginName: "opencode-lowerer-test",
  sourcePluginVersion: "0.1.0",
  sourcePluginPath: join(root, "plugin"),
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
    { dryRun: true },
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
  const target = opencodeExecutionTarget(root);

  await executeStandardLowering(
    [
      {
        kind: "write-md",
        target: mdTarget,
        content: "old markdown",
        reason: "new",
      },
      {
        kind: "write-plugin-file",
        target: pluginTarget,
        content: "old plugin",
        reason: "new",
      },
      {
        kind: "write-plugin-file",
        target: pruneFileTarget,
        content: "stale file",
        reason: "new",
      },
      {
        kind: "write-plugin-file",
        target: join(pruneDirTarget, "nested.txt"),
        content: "stale dir",
        reason: "new",
      },
    ],
    { dryRun: false, target },
  );
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

  const result = await executeLowering(operations, {
    dryRun: false,
    target,
  });

  expect(result.backups).toHaveLength(2);
  expect(result.backups[0]).toContain(join(process.env.PRISM_HOME!, "backups", "opencode"));
  expect(result.backups[1]).toContain(join(process.env.PRISM_HOME!, "backups", "opencode"));
  expect(await readFile(result.backups[0]!, "utf8")).toBe("old markdown");
  expect(await readFile(result.backups[1]!, "utf8")).toContain('"old"');
  expect(await pathExists(`${mdTarget}.bak`)).toBe(false);
  expect(await pathExists(`${jsonTarget}.bak`)).toBe(false);
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

  const ledger = await readHarnessLedger("opencode");
  expect(ledger.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPath: mdTarget, kind: "file" }),
      expect.objectContaining({ targetPath: pluginTarget, kind: "file" }),
      expect.objectContaining({ targetPath: jsonTarget, kind: "config" }),
    ]),
  );
});

test("executeStandardLowering backs up and records config patch operations", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".codex");
  const configTarget = join(targetRoot, "config.toml");

  await executeStandardLowering(
    [
      {
        kind: "write-plugin-file",
        target: configTarget,
        content: "old config\n",
        reason: "new",
      },
    ],
    {
      dryRun: false,
      target: {
        harness: "codex-cli",
        scope: "global",
        root: targetRoot,
        sourcePluginName: "config-patch-test",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, "plugin"),
      },
    },
  );
  await chmod(configTarget, 0o644);

  const result = await executeStandardLowering(
    [
      {
        kind: "patch-config",
        target: configTarget,
        content: "new config\n",
        mode: 0o600,
        reason: "changed",
      },
    ],
    {
      dryRun: false,
      target: {
        harness: "codex-cli",
        scope: "global",
        root: targetRoot,
        sourcePluginName: "config-patch-test",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, "plugin"),
      },
    },
  );

  expect(result.backups).toHaveLength(1);
  expect(result.backups[0]).toContain(join(process.env.PRISM_HOME!, "backups", "codex-cli"));
  expect(await readFile(result.backups[0]!, "utf8")).toBe("old config\n");
  expect(await pathExists(`${configTarget}.bak`)).toBe(false);
  expect(await readFile(configTarget, "utf8")).toBe("new config\n");
  expect((await stat(configTarget)).mode & 0o777).toBe(0o600);

  const ledger = await readHarnessLedger("codex-cli");
  expect(ledger.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPath: configTarget, kind: "config" }),
    ]),
  );
  expect(ledger.entries).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPath: configTarget, kind: "file" }),
    ]),
  );
});

test("executeStandardLowering records unchanged config patches and migrates old file ownership", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".hermes");
  const configTarget = join(targetRoot, "config.yaml");
  const target = {
    harness: "hermes" as const,
    scope: "global" as const,
    root: targetRoot,
    sourcePluginName: "config-patch-test",
    sourcePluginVersion: "0.1.0",
    sourcePluginPath: join(root, "plugin"),
  };

  await executeStandardLowering(
    [
      {
        kind: "write-plugin-file",
        target: configTarget,
        content: "stable config\n",
        reason: "new",
      },
    ],
    { dryRun: false, target },
  );
  await chmod(configTarget, 0o644);

  const result = await executeStandardLowering(
    [
      {
        kind: "patch-config",
        target: configTarget,
        content: "stable config\n",
        mode: 0o600,
        reason: "unchanged",
      },
    ],
    { dryRun: false, target },
  );

  expect(result.backups).toEqual([]);
  expect(await readFile(configTarget, "utf8")).toBe("stable config\n");
  expect((await stat(configTarget)).mode & 0o777).toBe(0o600);

  const ledger = await readHarnessLedger("hermes");
  expect(ledger.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPath: configTarget, kind: "config" }),
    ]),
  );
  expect(ledger.entries).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPath: configTarget, kind: "file" }),
    ]),
  );
});

test("executeStandardLowering rejects unmanaged existing compile writes", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".codex");
  const targetPath = join(targetRoot, "agents", "builder.md");
  const target = {
    harness: "codex-cli" as const,
    scope: "global" as const,
    root: targetRoot,
    sourcePluginName: "compile-ownership-test",
    sourcePluginVersion: "0.1.0",
    sourcePluginPath: join(root, "plugin"),
  };
  await writeText(targetPath, "user content\n");

  await expect(
    executeStandardLowering(
      [
        {
          kind: "write-md",
          target: targetPath,
          content: "generated content\n",
          reason: "changed",
        },
      ],
      { dryRun: false, target },
    ),
  ).rejects.toThrow("Compile target exists but is not owned by Prism");
  expect(await readFile(targetPath, "utf8")).toBe("user content\n");
});

test("executeStandardLowering repairs missing ledger for identical compile writes", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".codex");
  const targetPath = join(targetRoot, "agents", "builder.md");
  const target = {
    harness: "codex-cli" as const,
    scope: "global" as const,
    root: targetRoot,
    sourcePluginName: "compile-recovery-test",
    sourcePluginVersion: "0.1.0",
    sourcePluginPath: join(root, "plugin"),
  };
  await writeText(targetPath, "generated content\n");

  const result = await executeStandardLowering(
    [
      {
        kind: "write-md",
        target: targetPath,
        content: "generated content\n",
        reason: "unchanged",
      },
    ],
    { dryRun: false, target },
  );

  expect(result.backups).toEqual([]);
  expect((await readHarnessLedger("codex-cli")).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pluginName: "compile-recovery-test",
        kind: "file",
        targetPath,
      }),
    ]),
  );
});

test("executeStandardLowering refuses to prune changed stale compile files", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".codex");
  const targetPath = join(targetRoot, "plugins", "generated", "stale.txt");
  const target = {
    harness: "codex-cli" as const,
    scope: "global" as const,
    root: targetRoot,
    sourcePluginName: "compile-prune-test",
    sourcePluginVersion: "0.1.0",
    sourcePluginPath: join(root, "plugin"),
  };

  await executeStandardLowering(
    [
      {
        kind: "write-plugin-file",
        target: targetPath,
        content: "old generated content\n",
        reason: "new",
      },
    ],
    { dryRun: false, target },
  );
  await writeText(targetPath, "user changed content\n");

  await expect(
    executeStandardLowering(
      [
        {
          kind: "prune-plugin-path",
          target: targetPath,
          targetType: "file",
          reason: "stale",
        },
      ],
      { dryRun: false, target },
    ),
  ).rejects.toThrow("Managed compile prune target changed outside Prism");
  expect(await readFile(targetPath, "utf8")).toBe("user changed content\n");
});

test("executeStandardLowering prunes ledger-owned generated roots", async () => {
  const root = await createTempRoot();
  const targetRoot = join(root, ".codex");
  const generatedRoot = join(targetRoot, "plugins", "generated");
  const target = {
    harness: "codex-cli" as const,
    scope: "global" as const,
    root: targetRoot,
    sourcePluginName: "compile-root-prune-test",
    sourcePluginVersion: "0.1.0",
    sourcePluginPath: join(root, "plugin"),
  };

  await executeStandardLowering(
    [
      {
        kind: "write-plugin-file",
        target: join(generatedRoot, "package.json"),
        content: "{}\n",
        reason: "new",
      },
      {
        kind: "write-plugin-file",
        target: join(generatedRoot, "dist", "server.mjs"),
        content: "console.log('generated');\n",
        reason: "new",
      },
    ],
    { dryRun: false, target },
  );

  await executeStandardLowering(
    [
      {
        kind: "prune-plugin-path",
        target: generatedRoot,
        targetType: "dir",
        reason: "stale",
      },
    ],
    { dryRun: false, target },
  );

  expect(await pathExists(generatedRoot)).toBe(false);
  expect((await readHarnessLedger("codex-cli")).entries).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pluginName: "compile-root-prune-test" }),
    ]),
  );
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
    { dryRun: false },
  );

  expect(result.backups).toEqual([]);
  expect(await readFile(mdTarget, "utf8")).toBe("old markdown");
  expect(await pathExists(`${mdTarget}.bak`)).toBe(false);
  expect(await readJson<Record<string, unknown>>(jsonTarget)).toEqual({
    agent: { builder: { model: "old" } },
  });
  expect(await pathExists(`${jsonTarget}.bak`)).toBe(false);
});

test("executeLowering applies explicit modes to unchanged write operations", async () => {
  const root = await createTempRoot();
  const opencodeTarget = join(root, "opencode", "secret.toml");
  const sharedTarget = join(root, "shared", "secret.json");
  const configTarget = join(root, "shared", "config.toml");
  await writeText(opencodeTarget, "secret\n");
  await writeText(sharedTarget, "secret\n");
  await writeText(configTarget, "secret\n");
  await chmod(opencodeTarget, 0o644);
  await chmod(sharedTarget, 0o644);
  await chmod(configTarget, 0o644);

  const opencodeOperations: LowerOperation[] = [
    {
      kind: "write-plugin-file",
      target: opencodeTarget,
      content: "secret\n",
      mode: 0o600,
      reason: "unchanged",
    },
  ];
  const sharedOperations: LowerOperation[] = [
    {
      kind: "write-plugin-file",
      target: sharedTarget,
      content: "secret\n",
      mode: 0o600,
      reason: "unchanged",
    },
    {
      kind: "patch-config",
      target: configTarget,
      content: "secret\n",
      mode: 0o600,
      reason: "unchanged",
    },
  ];

  await executeLowering(opencodeOperations, { dryRun: false });
  await executeStandardLowering(sharedOperations, { dryRun: false });

  expect((await stat(opencodeTarget)).mode & 0o777).toBe(0o600);
  expect((await stat(sharedTarget)).mode & 0o777).toBe(0o600);
  expect((await stat(configTarget)).mode & 0o777).toBe(0o600);
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
    { dryRun: false },
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
    { dryRun: false },
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

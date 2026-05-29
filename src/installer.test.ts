import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeContentHash } from "./content-hash.js";
import { install, planInstallation } from "./installer.js";
import { managedEntryId, readHarnessLedger, writeHarnessLedger } from "./managed-ledger.js";

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

test("planInstallation keeps Factory skills direct only when no compile bundle is targeted", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-skills-demo",
      version: "0.1.0",
      targets: { skills: ["factory-droid"] },
    })}\n`,
  );
  await writeText(
    join(pluginPath, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["factory-droid"],
    overwrite: false,
    dryRun: true,
  });

  expect(operations.some((operation) => operation.target.includes(join(".factory", "skills")))).toBe(true);
});

test("planInstallation keeps Factory skills direct with source-only compile targets", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-source-only-demo",
      version: "0.1.0",
      targets: {
        skills: ["factory-droid"],
        toolspaces: ["factory-droid"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginPath, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["factory-droid"],
    overwrite: false,
    dryRun: true,
  });

  expect(operations.some((operation) => operation.target.includes(join(".factory", "skills")))).toBe(true);
});

test("planInstallation routes Kimi and Pi base support to skills only", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "skills-only-demo",
      version: "0.1.0",
      targets: { skills: ["kimi-code", "pi"] },
    })}\n`,
  );
  await writeText(
    join(pluginPath, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["kimi-code", "pi"],
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toHaveLength(2);
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        harness: "kimi-code",
        artifact: "skill",
        target: expect.stringContaining(join(".kimi-code", "skills", "testing", "SKILL.md")),
      }),
      expect.objectContaining({
        harness: "pi",
        artifact: "skill",
        target: expect.stringContaining(join(".pi", "agent", "skills", "testing", "SKILL.md")),
      }),
    ]),
  );
});

test("planInstallation keeps Factory skills direct with orbit-only compile targets", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-orbit-skills-demo",
      version: "0.1.0",
      targets: {
        skills: ["factory-droid"],
        orbits: ["factory-droid"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginPath, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["factory-droid"],
    overwrite: false,
    dryRun: true,
  });

  expect(operations.some((operation) => operation.target.includes(join(".factory", "skills")))).toBe(true);
});

test("planInstallation skips direct Factory skills when a compile plugin bundle owns them", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-compile-demo",
      version: "0.1.0",
      targets: {
        agents: ["factory-droid"],
        skills: ["factory-droid"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginPath, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["factory-droid"],
    overwrite: false,
    dryRun: true,
  });

  expect(operations.some((operation) => operation.target.includes(join(".factory", "skills")))).toBe(false);
});

test("planInstallation skips direct skills when the compile lowerer owns targeted skills", async () => {
  const cases = [
    "amp-code",
    "antigravity-cli",
    "claude-code",
    "codex-cli",
    "grok",
    "hermes",
  ] as const;

  for (const harness of cases) {
    const root = await createTempRoot();
    const pluginPath = join(root, `plugin-${harness}`);
    await writeText(
      join(pluginPath, "plugin.json"),
      `${JSON.stringify({
        name: `compile-owned-skills-${harness}`,
        version: "0.1.0",
        targets: {
          skills: [harness],
          tools: [harness],
        },
      })}\n`,
    );
    await writeText(
      join(pluginPath, "skills", "testing", "SKILL.md"),
      "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
    );

    const operations = await planInstallation({
      pluginPath,
      harnesses: [harness],
      overwrite: false,
      dryRun: true,
    });

    expect(
      operations.some((operation) => operation.harness === harness && operation.artifact === "skill"),
    ).toBe(false);
  }
});

test("planInstallation keeps direct skills when compile does not own targeted skills", async () => {
  const cases = [
    {
      harness: "codex-cli" as const,
      targets: { skills: ["codex-cli"] },
    },
    {
      harness: "opencode" as const,
      targets: { skills: ["opencode"], tools: ["opencode"] },
    },
  ];

  for (const item of cases) {
    const root = await createTempRoot();
    const pluginPath = join(root, `plugin-${item.harness}`);
    await writeText(
      join(pluginPath, "plugin.json"),
      `${JSON.stringify({
        name: `direct-skills-${item.harness}`,
        version: "0.1.0",
        targets: item.targets,
      })}\n`,
    );
    await writeText(
      join(pluginPath, "skills", "testing", "SKILL.md"),
      "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
    );

    const operations = await planInstallation({
      pluginPath,
      harnesses: [item.harness],
      overwrite: false,
      dryRun: true,
    });

    expect(
      operations.some((operation) => operation.harness === item.harness && operation.artifact === "skill"),
    ).toBe(true);
  }
});

test("install prunes stale compile-owned Factory plugin files when compile target is removed", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const factoryRoot = join(projectPath, ".factory");
  const targetPath = join(
    factoryRoot,
    "plugins",
    "prism-generated-factory-compile-demo",
    ".factory-plugin",
    "plugin.json",
  );
  const content = '{"name":"prism-generated-factory-compile-demo"}\n';
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-compile-demo",
      version: "0.1.0",
      targets: { skills: ["factory-droid"] },
    })}\n`,
  );
  await writeText(targetPath, content);

  const ledger = await readHarnessLedger("factory-droid");
  const entryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: factoryRoot,
    pluginName: "factory-compile-demo",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  await writeHarnessLedger({
    ...ledger,
    entries: [
      {
        id: entryId,
        pluginName: "factory-compile-demo",
        pluginVersion: "0.1.0",
        pluginPath,
        harness: "factory-droid",
        scope: "project",
        root: factoryRoot,
        artifact: "compile",
        targetPath,
        kind: "file",
        contentHash: computeContentHash(content),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const result = await install({
    pluginPath,
    harnesses: ["factory-droid"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });

  expect(result.success).toBe(true);
  expect(result.operations).toContainEqual(
    expect.objectContaining({ type: "prune", artifact: "compile", target: targetPath }),
  );
  await expect(readFile(targetPath, "utf8")).rejects.toThrow();
  expect((await readHarnessLedger("factory-droid")).entries).toHaveLength(0);
});

test("install prunes stale compile-owned Factory plugin files when only source compile targets remain", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const factoryRoot = join(projectPath, ".factory");
  const targetPath = join(
    factoryRoot,
    "plugins",
    "prism-generated-factory-compile-demo",
    "droids",
    "worker.md",
  );
  const content = "---\nname: worker\n---\n";
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-compile-demo",
      version: "0.1.0",
      targets: { toolspaces: ["factory-droid"] },
    })}\n`,
  );
  await writeText(targetPath, content);

  const ledger = await readHarnessLedger("factory-droid");
  const entryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: factoryRoot,
    pluginName: "factory-compile-demo",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  await writeHarnessLedger({
    ...ledger,
    entries: [
      {
        id: entryId,
        pluginName: "factory-compile-demo",
        pluginVersion: "0.1.0",
        pluginPath,
        harness: "factory-droid",
        scope: "project",
        root: factoryRoot,
        artifact: "compile",
        targetPath,
        kind: "file",
        contentHash: computeContentHash(content),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const result = await install({
    pluginPath,
    harnesses: ["factory-droid"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });

  expect(result.success).toBe(true);
  expect(result.operations).toContainEqual(
    expect.objectContaining({ type: "prune", artifact: "compile", target: targetPath }),
  );
  await expect(readFile(targetPath, "utf8")).rejects.toThrow();
  expect((await readHarnessLedger("factory-droid")).entries).toHaveLength(0);
});

test("install forgets shared MCP runtime compile entries owned by another harness", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const factoryRoot = join(projectPath, ".factory");
  const claudeRoot = join(projectPath, ".claude");
  const targetPath = join(
    root,
    "shared-runtime",
    "prism",
    "mcp",
    "prism-generated-factory-compile-demo",
    "server.mjs",
  );
  const previousContent = "console.log('old shared runtime');\n";
  const content = "console.log('shared runtime');\n";
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-compile-demo",
      version: "0.1.0",
      targets: { skills: ["factory-droid"] },
    })}\n`,
  );
  await writeText(targetPath, content);

  const factoryEntryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: factoryRoot,
    pluginName: "factory-compile-demo",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  const claudeEntryId = managedEntryId({
    harness: "claude-code",
    scope: "project",
    root: claudeRoot,
    pluginName: "factory-compile-demo",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  const sharedEntry = {
    pluginName: "factory-compile-demo",
    pluginVersion: "0.1.0",
    pluginPath,
    scope: "project" as const,
    artifact: "compile",
    targetPath,
    kind: "file" as const,
    updatedAt: new Date().toISOString(),
  };
  await writeHarnessLedger({
    ...(await readHarnessLedger("factory-droid")),
    entries: [
      {
        ...sharedEntry,
        id: factoryEntryId,
        harness: "factory-droid",
        root: factoryRoot,
        contentHash: computeContentHash(previousContent),
      },
    ],
  });
  await writeHarnessLedger({
    ...(await readHarnessLedger("claude-code")),
    entries: [
      {
        ...sharedEntry,
        id: claudeEntryId,
        harness: "claude-code",
        root: claudeRoot,
        contentHash: computeContentHash(content),
      },
    ],
  });

  const result = await install({
    pluginPath,
    harnesses: ["factory-droid"],
    projectPath,
    overwrite: false,
    dryRun: false,
  });

  expect(result.success).toBe(true);
  expect(result.operations).toContainEqual(
    expect.objectContaining({ type: "prune", artifact: "compile", target: targetPath }),
  );
  expect(await readFile(targetPath, "utf8")).toBe(content);
  expect((await readHarnessLedger("factory-droid")).entries).toHaveLength(0);
  expect((await readHarnessLedger("claude-code")).entries).toHaveLength(1);
});

test("planInstallation does not treat same-harness shared MCP duplicates as another owner", async () => {
  const root = await createTempRoot();
  const pluginPath = join(root, "plugin");
  const projectPath = join(root, "project");
  const factoryRoot = join(projectPath, ".factory");
  const targetPath = join(
    root,
    "shared-runtime",
    "prism",
    "mcp",
    "prism-generated-factory-compile-demo",
    "server.mjs",
  );
  const previousContent = "console.log('old shared runtime');\n";
  const content = "console.log('shared runtime');\n";
  await mkdir(projectPath, { recursive: true });
  await writeText(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify({
      name: "factory-compile-demo",
      version: "0.1.0",
      targets: { skills: ["factory-droid"] },
    })}\n`,
  );
  await writeText(targetPath, content);

  const staleEntryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: factoryRoot,
    pluginName: "factory-compile-demo",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  const duplicateEntryId = `${staleEntryId}:duplicate`;
  const sharedEntry = {
    pluginName: "factory-compile-demo",
    pluginVersion: "0.1.0",
    pluginPath,
    harness: "factory-droid" as const,
    scope: "project" as const,
    root: factoryRoot,
    artifact: "compile",
    targetPath,
    kind: "file" as const,
    updatedAt: new Date().toISOString(),
  };
  await writeHarnessLedger({
    ...(await readHarnessLedger("factory-droid")),
    entries: [
      {
        ...sharedEntry,
        id: staleEntryId,
        contentHash: computeContentHash(previousContent),
      },
      {
        ...sharedEntry,
        id: duplicateEntryId,
        contentHash: computeContentHash(content),
      },
    ],
  });

  const operations = await planInstallation({
    pluginPath,
    harnesses: ["factory-droid"],
    projectPath,
    overwrite: false,
    dryRun: true,
  });

  expect(operations).toContainEqual(
    expect.objectContaining({ type: "drift", artifact: "compile", target: targetPath }),
  );
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

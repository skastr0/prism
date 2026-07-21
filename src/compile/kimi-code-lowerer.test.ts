import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { composeAgent } from "./compose.js";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/kimi-code.js";
import { mcpToolNameForBinding } from "./mcp-bundle.js";
import { pluginServerKey, renderPluginWire } from "@skastr0/prism-sdk/mcp/wire-naming";
import {
  instantiateOrbit,
  resolveAgent,
  validateOrbit,
  type ResolvedContractBinding,
} from "./resolve.js";
import type { DesiredFile, DesiredRegion } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-kimi-lowerer-"));
  tempRoots.push(root);
  return root;
};

const findContentOperation = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

const permissionBinding = (
  ownerPlugin: string,
  toolName: string,
): ResolvedContractBinding => ({
  kind: "permission",
  logicalName: toolName,
  toolPluginName: ownerPlugin,
  toolName,
  toolSourcePath: `/plugins/${ownerPlugin}/tools/${toolName}.tool.ts`,
});

const findRegionByKey = (
  regions: ReadonlyArray<DesiredRegion>,
  regionKey: string,
): DesiredRegion | undefined => regions.find((region) => region.regionKey === regionKey);

const regionContent = (region: DesiredRegion | undefined): string => {
  if (!region) return "";
  if (region.kind === "marker") return region.content;
  if (region.kind === "json-array-member") return JSON.stringify(region.value);
  return "";
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const TARGET = "kimi-code";

const prepareRegistryForLowering = async (pluginRoot: string) => {
  const registry = await Effect.runPromise(loadPlugin(pluginRoot));

  const agents = await Effect.runPromise(
    Effect.all(
      [...registry.agents.values()].map((agent) =>
        Effect.map(resolveAgent(agent, registry, TARGET), composeAgent),
      ),
    ),
  );

  const orbits = await Effect.runPromise(
    Effect.all(
      [...registry.orbits.values()].map((orbit) =>
        Effect.gen(function* () {
          yield* validateOrbit(orbit, registry);
          return yield* instantiateOrbit(orbit);
        }),
      ),
    ),
  );

  return {
    registry,
    agents,
    orbits,
    tools: [...registry.tools.values()],
    skills: [...registry.skills.values()],
    hooks: [...registry.hooks.values()],
  };
};

test("kimi-code lowerer emits a generated plugin with all compile surfaces", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");
  const pluginRoot = join(process.cwd(), "examples", "prism-harness-qa");

  const { registry, agents, orbits, tools, skills, hooks } =
    await prepareRegistryForLowering(pluginRoot);

  const { files, regions } = await planLowering({
    agents,
    orbits,
    tools,
    skills,
    hooks,
    registry,
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "prism-harness-qa",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const pluginId = "prism-generated-prism-harness-qa";

  const manifest = findContentOperation(files, "kimi.plugin.json");
  expect(manifest).toBeDefined();
  const manifestJson = JSON.parse(manifest?.content ?? "{}") as {
    readonly name?: string;
    readonly version?: string;
    readonly skills?: string;
    readonly sessionStart?: { readonly skill?: string };
    readonly mcpServers?: Record<string, { readonly env?: Record<string, string>; readonly enabledTools?: string[] }>;
  };
  expect(manifestJson.name).toBe(pluginId);
  expect(manifestJson.version).toBe("0.1.0");
  expect(manifestJson.skills).toBe("./skills/");
  expect(manifestJson.sessionStart).toEqual({ skill: "prism-context" });
  expect(manifestJson.mcpServers).toBeDefined();

  const mcpServerName = Object.keys(manifestJson.mcpServers ?? {})[0];
  expect(mcpServerName).toBe(pluginServerKey("prism-harness-qa"));
  const mcpServer = manifestJson.mcpServers?.[mcpServerName ?? ""];
  // Load-bearing: without this the running shim advertises its default
  // aggregated `p_<hash>_<tool>` names, which won't match `enabledTools`
  // below and every real tool call would 404 (see kimi-code.ts
  // renderKimiMcpServerEntry).
  expect(mcpServer?.env?.PRISM_SHIM_NAMING).toBe("per-plugin");
  expect(mcpServer?.enabledTools).toEqual(["challenge_echo"]);

  const contextSkill = findContentOperation(files, "skills/prism-context/SKILL.md");
  expect(contextSkill?.content).toContain("<!-- prism:kimi-context -->");
  expect(contextSkill?.content).toContain("QA Rules");

  const roleSkill = findContentOperation(files, "skills/prism-agent-qa-tester/SKILL.md");
  expect(roleSkill?.content).toContain("prism-agent-qa-tester");
  expect(roleSkill?.content).toContain("<!-- prism:kimi-agent-role -->");
  expect(roleSkill?.content).toContain("qa-helper");
  expect(roleSkill?.content).toContain("mcp__prism-harness-qa__challenge_echo");

  const commandSkill = findContentOperation(files, "skills/prism-command-qa-report/SKILL.md");
  expect(commandSkill?.content).toContain("prism-command-qa-report");
  expect(commandSkill?.content).toMatch(/type:\s*"?flow"?/);
  expect(commandSkill?.content).toContain("QA Report");

  const orbitSkill = findContentOperation(files, "skills/qa-orbit/SKILL.md");
  expect(orbitSkill?.content).toContain("qa-orbit");
  expect(orbitSkill?.content).toContain("Verify harness load");

  const bundledSkill = findContentOperation(files, "skills/qa-helper/SKILL.md");
  expect(bundledSkill?.content).toContain("qa-helper");
  expect(bundledSkill?.content).toContain("QA Helper");

  const hookWrapper = findContentOperation(files, "hooks/session-start.mjs");
  expect(hookWrapper?.content).toBeDefined();
  expect(hookWrapper?.content).toContain("SessionStart");
  expect(hookWrapper?.content).toContain("#!/usr/bin/env node");

  const hooksRegion = findRegionByKey(regions, "kimi.hooks.prism-harness-qa");
  expect(regionContent(hooksRegion)).toContain("[[hooks]]");
  expect(regionContent(hooksRegion)).toContain("event = \"SessionStart\"");
  expect(regionContent(hooksRegion)).toContain("session-start.mjs");

  const installedRegion = findRegionByKey(regions, "installed.prism-generated-prism-harness-qa");
  expect(regionContent(installedRegion)).toContain(pluginId);
  expect(regionContent(installedRegion)).toContain("\"enabled\":true");

  // Verify the hook wrapper runs without crashing.
  if (hookWrapper) {
    const wrapperPath = join(root, "session-start.mjs");
    await writeFile(wrapperPath, hookWrapper.content, "utf8");
    const { exitCode, stderr } = await new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn("node", [wrapperPath], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
      child.stdin.end(JSON.stringify({ cwd: "/tmp", session: { id: "test" } }));
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  }
});

test("kimi-code production default omits generated MCP role tools and MCP config", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");
  const owner = "kimi-mcp-off-fixture";
  const binding = permissionBinding(owner, "echo");
  const previous = process.env.PRISM_TOOLS_MCP_EMIT;
  const previousCli = process.env.PRISM_TOOLS_CLI_EMIT;
  const previousInject = process.env.PRISM_TOOLS_CLI_INJECT;

  delete process.env.PRISM_TOOLS_MCP_EMIT;
  delete process.env.PRISM_TOOLS_CLI_EMIT;
  delete process.env.PRISM_TOOLS_CLI_INJECT;
  try {
    const { files } = await planLowering({
      agents: [{
        name: "consumer",
        description: "Consumes one native and one canonical tool",
        body: "# Consumer\n",
        color: undefined,
        model: {},
        targetOverride: {},
        skills: [],
        allowedSkills: [],
        allowedTools: ["read_file"],
        toolBindings: [binding],
      }],
      orbits: [],
      tools: [],
      skills: [],
      hooks: [],
      target: {
        scope: "global",
        root: outputRoot,
        sourcePluginName: owner,
        sourcePluginVersion: "0.1.0",
      },
    });

    const role = findContentOperation(
      files,
      join("skills", "prism-agent-consumer", "SKILL.md"),
    );
    const generatedName = `mcp__${pluginServerKey(owner)}__${renderPluginWire(
      "kimi-code",
      owner,
      mcpToolNameForBinding(owner, binding),
    )}`;
    expect(role?.content).toContain("Native tools requested by this role: `read_file`.");
    expect(role?.content).not.toContain("Generated MCP tools for this role:");
    expect(role?.content).not.toContain(generatedName);
    expect(role?.content).toContain("Load skill `prism-tools-kimi-mcp-off-fixture`");
    expect(role?.content).toContain(
      "prism tools invoke kimi-mcp-off-fixture <tool-name>",
    );
    expect(role?.content).toContain("`echo`");
    const manifest = JSON.parse(
      findContentOperation(files, "kimi.plugin.json")?.content ?? "{}",
    ) as { readonly mcpServers?: unknown };
    expect(manifest.mcpServers).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PRISM_TOOLS_MCP_EMIT;
    else process.env.PRISM_TOOLS_MCP_EMIT = previous;
    if (previousCli === undefined) delete process.env.PRISM_TOOLS_CLI_EMIT;
    else process.env.PRISM_TOOLS_CLI_EMIT = previousCli;
    if (previousInject === undefined) delete process.env.PRISM_TOOLS_CLI_INJECT;
    else process.env.PRISM_TOOLS_CLI_INJECT = previousInject;
  }
});

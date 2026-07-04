import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { composeAgent } from "./compose.js";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/kimi-code.js";
import { generatedMcpWireServerName } from "./mcp-runtime.js";
import { instantiateOrbit, resolveAgent, validateOrbit } from "./resolve.js";
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
      mcpRuntimePort: 38467,
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
    readonly mcpServers?: Record<string, unknown>;
  };
  expect(manifestJson.name).toBe(pluginId);
  expect(manifestJson.version).toBe("0.1.0");
  expect(manifestJson.skills).toBe("./skills/");
  expect(manifestJson.sessionStart).toEqual({ skill: "prism-context" });
  expect(manifestJson.mcpServers).toBeDefined();

  const mcpServerName = Object.keys(manifestJson.mcpServers ?? {})[0];
  expect(mcpServerName).toBe(generatedMcpWireServerName("prism-harness-qa"));

  const contextSkill = findContentOperation(files, "skills/prism-context/SKILL.md");
  expect(contextSkill?.content).toContain("<!-- prism:kimi-context -->");
  expect(contextSkill?.content).toContain("QA Rules");

  const roleSkill = findContentOperation(files, "skills/prism-agent-qa-tester/SKILL.md");
  expect(roleSkill?.content).toContain("prism-agent-qa-tester");
  expect(roleSkill?.content).toContain("<!-- prism:kimi-agent-role -->");
  expect(roleSkill?.content).toContain("qa-helper");
  expect(roleSkill?.content).toContain("mcp__plugin-prism-generated-prism-harness-qa");

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

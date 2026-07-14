import { afterEach, expect, test, describe } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/hermes.js";
import type { DesiredFile, DesiredRegion } from "../sync/desired.js";

const tempRoots: string[] = [];

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-hermes-hooks-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const findFile = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

const findRegion = (
  regions: ReadonlyArray<DesiredRegion>,
  regionKey: string,
): DesiredRegion | undefined => regions.find((region) => region.regionKey === regionKey);

const markerContent = (region: DesiredRegion | undefined): string => {
  if (!region || region.kind !== "marker") throw new Error("expected a marker region");
  return region.content;
};

const runGeneratedHookWrapper = (
  wrapperPath: string,
  payload: unknown,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("node", [wrapperPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe("hermes hook lowerer", () => {
  test("lowering tool.before + prompt.submit + session.end", async () => {
    const tempRoot = await createTempRoot();
    const pluginRoot = join(tempRoot, "plugin");
    const hermesRoot = join(tempRoot, "hermes-root");
    await mkdir(hermesRoot, { recursive: true });

    // Write plugin.json
    await writeText(
      join(pluginRoot, "plugin.json"),
      JSON.stringify(
        {
          name: "hermes-hooks-fixture",
          version: "0.1.0",
          targets: { hooks: ["hermes"] },
        },
        null,
        2,
      ) + "\n",
    );

    // Write toolspace
    await writeText(
      join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
      `export default {
  name: "workspace",
  tools: {
    shell: { targets: { hermes: { name: "shell.command" } } },
  },
};`
    );

    // Write tool.before hook
    await writeText(
      join(pluginRoot, "hooks", "audit-shell.hook.ts"),
      `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-shell",
  description: "Audit shell commands",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};`
    );

    // Write prompt.submit hook
    await writeText(
      join(pluginRoot, "hooks", "audit-submit.hook.ts"),
      `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit prompts",
  event: hookEvent.promptSubmit,
  handle: (event) => Effect.succeed({ decision: "continue" as const, additionalContext: "injected-context" }),
};`
    );

    // Write session.end hook
    await writeText(
      join(pluginRoot, "hooks", "session-ended.hook.ts"),
      `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-ended",
  description: "Session ended",
  event: hookEvent.sessionEnd,
  handle: (event) => Effect.succeed({ decision: "continue" as const }),
};`
    );

    const registry = await Effect.runPromise(loadPlugin(pluginRoot));
    const auditShell = registry.hooks.get("audit-shell");
    const auditSubmit = registry.hooks.get("audit-submit");
    const sessionEnded = registry.hooks.get("session-ended");

    expect(auditShell).toBeDefined();
    expect(auditSubmit).toBeDefined();
    expect(sessionEnded).toBeDefined();

    const lowered = await planLowering({
      agents: [],
      orbits: [],
      tools: [],
      skills: [],
      hooks: [auditShell!, auditSubmit!, sessionEnded!],
      registry,
      target: {
        scope: "global",
        root: hermesRoot,
        sourcePluginName: "hermes-hooks-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    });

    // Verify config.yaml regions
    // Regions are keyed per NATIVE EVENT (not per hook) so that multiple hooks
    // sharing a native event land under one `<event>:` key, never duplicate keys.
    const auditShellRegion = findRegion(lowered.regions, "hermes.hooks.pre_tool_call");
    expect(auditShellRegion).toBeDefined();
    const auditShellYaml = markerContent(auditShellRegion);
    expect(auditShellYaml).toContain("pre_tool_call:");
    expect(auditShellYaml).toContain("- command: ");
    expect(auditShellYaml).toContain('matcher: "shell.command"');

    const auditSubmitRegion = findRegion(lowered.regions, "hermes.hooks.pre_llm_call");
    expect(auditSubmitRegion).toBeDefined();
    const auditSubmitYaml = markerContent(auditSubmitRegion);
    expect(auditSubmitYaml).toContain("pre_llm_call:");

    const sessionEndedRegion = findRegion(lowered.regions, "hermes.hooks.on_session_end");
    expect(sessionEndedRegion).toBeDefined();
    const sessionEndedYaml = markerContent(sessionEndedRegion);
    expect(sessionEndedYaml).toContain("on_session_end:");

    // Verify hook wrapper files
    const auditShellWrapper = findFile(lowered.files, join("hooks", "audit-shell.mjs"));
    expect(auditShellWrapper).toBeDefined();

    const auditSubmitWrapper = findFile(lowered.files, join("hooks", "audit-submit.mjs"));
    expect(auditSubmitWrapper).toBeDefined();

    const sessionEndedWrapper = findFile(lowered.files, join("hooks", "session-ended.mjs"));
    expect(sessionEndedWrapper).toBeDefined();

    // Write wrapper files to disk and execute them to verify logic
    // We need to write them to tempRoot under the correct absolute paths so they find effect runtime
    await writeText(auditShellWrapper!.targetPath, auditShellWrapper!.content);
    await writeText(auditSubmitWrapper!.targetPath, auditSubmitWrapper!.content);

    // Assert that the pre_tool_call wrapper blocks correctly
    const blockedRes = await runGeneratedHookWrapper(auditShellWrapper!.targetPath, {
      tool_name: "shell.command",
      tool_input: { block: true },
      session_id: "test",
      cwd: tempRoot,
    });
    expect(blockedRes.exitCode).toBe(0);
    const blockedJson = JSON.parse(blockedRes.stdout.trim());
    expect(blockedJson).toEqual({ decision: "block", reason: "blocked" });

    // Assert continue
    const allowedRes = await runGeneratedHookWrapper(auditShellWrapper!.targetPath, {
      tool_name: "shell.command",
      tool_input: { block: false },
      session_id: "test",
      cwd: tempRoot,
    });
    expect(allowedRes.exitCode).toBe(0);
    expect(allowedRes.stdout.trim()).toBe("");

    // Assert prompt.submit pre_llm_call context injection
    const submitRes = await runGeneratedHookWrapper(auditSubmitWrapper!.targetPath, {
      session_id: "test",
      cwd: tempRoot,
    });
    expect(submitRes.exitCode).toBe(0);
    const submitJson = JSON.parse(submitRes.stdout.trim());
    expect(submitJson).toEqual({ context: "injected-context" });
  });

  test("two hooks on the same native event share one key (no duplicate YAML keys)", async () => {
    const tempRoot = await createTempRoot();
    const pluginRoot = join(tempRoot, "plugin");
    const hermesRoot = join(tempRoot, "hermes-root");
    await mkdir(hermesRoot, { recursive: true });

    await writeText(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "hermes-collide", version: "0.1.0", targets: { hooks: ["hermes"] } }, null, 2) + "\n",
    );
    for (const name of ["audit-a", "audit-b"]) {
      await writeText(
        join(pluginRoot, "hooks", `${name}.hook.ts`),
        `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};
export default {
  name: "${name}",
  event: hookEvent.toolBefore,
  handle: (event) => Effect.succeed({ decision: "continue" as const }),
};`,
      );
    }

    const registry = await Effect.runPromise(loadPlugin(pluginRoot));
    const lowered = await planLowering({
      agents: [], orbits: [], tools: [], skills: [],
      hooks: [registry.hooks.get("audit-a")!, registry.hooks.get("audit-b")!],
      registry,
      target: {
        scope: "global", root: hermesRoot,
        sourcePluginName: "hermes-collide", sourcePluginVersion: "0.1.0", sourcePluginPath: pluginRoot,
      },
    });

    // Exactly ONE region for pre_tool_call, holding BOTH hooks' commands.
    const preToolRegions = lowered.regions.filter((r) => r.regionKey === "hermes.hooks.pre_tool_call");
    expect(preToolRegions).toHaveLength(1);
    const yaml = markerContent(preToolRegions[0]);
    expect((yaml.match(/pre_tool_call:/g) ?? []).length).toBe(1);
    expect((yaml.match(/- command: /g) ?? []).length).toBe(2);
    // Both wrapper files still emitted per hook.
    expect(findFile(lowered.files, join("hooks", "audit-a.mjs"))).toBeDefined();
    expect(findFile(lowered.files, join("hooks", "audit-b.mjs"))).toBeDefined();
  });
});

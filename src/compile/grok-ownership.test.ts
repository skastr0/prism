import { afterEach, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/grok.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";
import { PathConflictError } from "../errors.js";
import { readSnapshot } from "../state/store.js";
import { planSync } from "../sync/plan.js";
import { applySync } from "../sync/apply.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-grok-ownership-"));
  tempRoots.push(root);
  return root;
};

const findContentOperation = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("two plugins compiling a same-named Grok project agent fail closed, naming both plugins", async () => {
  const root = await createTempRoot();
  const home = await createTempRoot();
  const outputRoot = join(root, ".grok");

  const agentNamed = (sourcePluginName: string): ComposedAgent => ({
    name: "builder",
    description: `Builder from ${sourcePluginName}`,
    body: `# Builder\n\nAuthored independently by ${sourcePluginName}.\n`,
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [],
  });

  const lowerFor = (sourcePluginName: string) =>
    planLowering({
      agents: [agentNamed(sourcePluginName)],
      orbits: [],
      skills: [],
      hooks: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName,
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, sourcePluginName),
      },
    });

  const first = await lowerFor("agent-forge");
  const second = await lowerFor("agent-quasar");
  const agentTargetPath = join(outputRoot, "agents", "builder.md");
  expect(first.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);
  expect(second.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);

  const refreshScoped = async (desired: typeof first, plugin: string) => {
    const snapshot = await readSnapshot({ prismHome: home, harness: "grok", root: outputRoot });
    const plan = await planSync({
      desired: {
        harness: "grok",
        root: outputRoot,
        files: desired.files,
        regions: desired.regions,
      },
      snapshot: snapshot.manifest,
      scopePlugins: new Set([plugin]),
    });
    return applySync({ prismHome: home, plan });
  };

  await refreshScoped(first, "agent-forge");
  try {
    await refreshScoped(second, "agent-quasar");
    throw new Error("expected a PathConflictError");
  } catch (error) {
    expect(error).toBeInstanceOf(PathConflictError);
    if (!(error instanceof PathConflictError)) throw error;
    expect(error.targetPath).toBe(agentTargetPath);
    expect(error.firstPlugin).toBe("agent-forge");
    expect(error.secondPlugin).toBe("agent-quasar");
  }
});

/**
 * Acceptance gate: orbit workflow metadata.
 *
 * Loads every first-party Prism plugin under ../prism-plugins that declares
 * orbits, verifies every orbit phase preserves workflow metadata after loader
 * normalization, then compiles the plugin for Codex CLI in dry-run mode and
 * verifies the generated orbit skill plus phase references render the metadata.
 *
 * Add --strict to require every optional workflow subfield to be present.
 *
 * Usage:
 *   bun scripts/acceptance/orbit-workflows.ts [--strict] [../prism-plugins]
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "../../src/compile/load.js";
import { compilePluginForTarget } from "../../src/compile/pipeline.js";
import type { OrbitPhase } from "../../src/compile/sources.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_PLUGIN_CORPUS = resolve(REPO_ROOT, "..", "prism-plugins");
const TARGET = "codex-cli";
const STRICT = process.argv.includes("--strict");

interface GateFailure {
  readonly plugin: string;
  readonly orbit?: string;
  readonly phase?: string;
  readonly detail: string;
}

const printSummary = (input: {
  readonly pass: boolean;
  readonly plugins: number;
  readonly orbits: number;
  readonly phases: number;
  readonly failures: ReadonlyArray<GateFailure>;
  readonly roots?: ReadonlyArray<string>;
}): void => {
  console.log(JSON.stringify({
    schema: "prism.acceptance.orbit-workflows.v1",
    gate: STRICT ? "orbit-workflows-strict" : "orbit-workflows",
    pass: input.pass,
    expected: STRICT ? "FAIL" : "PASS",
    strict: STRICT,
    counts: {
      plugins: input.plugins,
      orbits: input.orbits,
      phases: input.phases,
      failures: input.failures.length,
    },
    ...(input.roots ? { roots: input.roots } : {}),
    ...(input.failures.length > 0 ? { failures: input.failures } : {}),
  }, null, 2));
};

const fail = (
  failures: GateFailure[],
  counts: { readonly plugins: number; readonly orbits: number; readonly phases: number },
): never => {
  console.error(`orbit workflow acceptance failed (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
  for (const failure of failures) {
    const scope = [
      failure.plugin,
      failure.orbit ? `orbit=${failure.orbit}` : undefined,
      failure.phase ? `phase=${failure.phase}` : undefined,
    ].filter(Boolean).join(" ");
    console.error(`- ${scope}: ${failure.detail}`);
  }
  printSummary({ pass: false, failures, ...counts });
  process.exit(1);
};

const findOrbitPluginRoots = async (pluginsRoot: string): Promise<string[]> => {
  const proc = Bun.spawn({
    cmd: ["find", pluginsRoot, "-path", "*/node_modules", "-prune", "-o", "-path", "*/orbits/*.orbit.ts", "-print"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`failed to discover orbit files: ${stderr.trim()}`);
  }

  const roots = new Set<string>();
  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    roots.add(dirname(dirname(line)));
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
};

const missingWorkflowFields = (phase: OrbitPhase): string[] => {
  const workflow = phase.workflow;
  if (!workflow) return ["workflow"];

  const missing: string[] = [];
  const hasAnyField =
    Boolean(workflow.when?.trim()) ||
    (workflow.inputs?.length ?? 0) > 0 ||
    (workflow.outputs?.length ?? 0) > 0 ||
    (workflow.sequence?.length ?? 0) > 0 ||
    Boolean(workflow.coordination?.trim()) ||
    (workflow.finish_criteria?.length ?? 0) > 0 ||
    Boolean(workflow.escalation?.trim());

  if (!hasAnyField) return ["workflow.<any field>"];
  if (!STRICT) return missing;

  if (!workflow.when?.trim()) missing.push("workflow.when");
  if ((workflow.inputs?.length ?? 0) === 0) missing.push("workflow.inputs");
  if ((workflow.outputs?.length ?? 0) === 0) missing.push("workflow.outputs");
  if ((workflow.sequence?.length ?? 0) === 0) missing.push("workflow.sequence");
  if (!workflow.coordination?.trim()) missing.push("workflow.coordination");
  if ((workflow.finish_criteria?.length ?? 0) === 0) missing.push("workflow.finish_criteria");
  if (!workflow.escalation?.trim()) missing.push("workflow.escalation");
  return missing;
};

const requireContains = (
  failures: GateFailure[],
  input: {
    readonly plugin: string;
    readonly orbit: string;
    readonly phase?: string;
    readonly content: string;
    readonly needle: string;
    readonly detail: string;
  },
): void => {
  if (!input.content.includes(input.needle)) {
    failures.push({
      plugin: input.plugin,
      orbit: input.orbit,
      phase: input.phase,
      detail: input.detail,
    });
  }
};

const main = async (): Promise<void> => {
  const pluginsRootArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const pluginsRoot = resolve(pluginsRootArg ?? DEFAULT_PLUGIN_CORPUS);
  const pluginRoots = await findOrbitPluginRoots(pluginsRoot);
  const prismHome = await mkdtemp(join(tmpdir(), "prism-orbit-workflows-prism-home."));
  const outputRootBase = await mkdtemp(join(tmpdir(), "prism-orbit-workflows-codex-root."));
  const failures: GateFailure[] = [];
  let orbitCount = 0;
  let phaseCount = 0;

  for (const pluginRoot of pluginRoots) {
    const plugin = basename(pluginRoot);
    const registry = await Effect.runPromise(loadPlugin(pluginRoot));
    if (registry.orbits.size === 0) continue;

    const compileResult = await Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target: TARGET,
        scope: "global",
        root: join(outputRootBase, plugin),
        prismHome,
        dryRun: true,
      }),
    );

    for (const orbit of registry.orbits.values()) {
      orbitCount += 1;
      const skill = compileResult.files.find((file) =>
        file.targetPath.endsWith(join("skills", orbit.name, "SKILL.md")),
      );
      if (!skill) {
        failures.push({ plugin, orbit: orbit.name, detail: "compiled orbit SKILL.md was not emitted" });
        continue;
      }

      for (const phase of orbit.phases) {
        phaseCount += 1;
        const missing = missingWorkflowFields(phase);
        if (missing.length > 0) {
          failures.push({
            plugin,
            orbit: orbit.name,
            phase: phase.name,
            detail: `loader-normalized phase is missing ${missing.join(", ")}`,
          });
          continue;
        }

        if (phase.workflow?.when) {
          requireContains(failures, {
            plugin,
            orbit: orbit.name,
            phase: phase.name,
            content: skill.content,
            needle: `- **Workflow trigger**: ${phase.workflow.when}`,
            detail: "root SKILL.md did not render workflow trigger",
          });
        }
        if ((phase.workflow?.finish_criteria?.length ?? 0) > 0) {
          requireContains(failures, {
            plugin,
            orbit: orbit.name,
            phase: phase.name,
            content: skill.content,
            needle: "- **Workflow finish criteria**:",
            detail: "root SKILL.md did not render workflow finish criteria",
          });
        }

        const reference = compileResult.files.find((file) =>
          file.targetPath.endsWith(join("skills", orbit.name, "references", `${phase.name}.md`)),
        );
        if (!reference) {
          failures.push({
            plugin,
            orbit: orbit.name,
            phase: phase.name,
            detail: "compiled phase reference was not emitted",
          });
          continue;
        }

        const workflow = phase.workflow;
        const headings = [
          "## Workflow",
          ...(workflow?.when ? ["### When to use this workflow"] : []),
          ...((workflow?.inputs?.length ?? 0) > 0 ? ["### Inputs"] : []),
          ...((workflow?.outputs?.length ?? 0) > 0 ? ["### Outputs"] : []),
          ...((workflow?.sequence?.length ?? 0) > 0 ? ["### Sequence"] : []),
          ...((workflow?.finish_criteria?.length ?? 0) > 0 ? ["### Finish criteria"] : []),
          ...(workflow?.coordination ? ["### Coordination"] : []),
          ...(workflow?.escalation ? ["### Escalation"] : []),
        ];
        for (const heading of headings) {
          requireContains(failures, {
            plugin,
            orbit: orbit.name,
            phase: phase.name,
            content: reference.content,
            needle: heading,
            detail: `phase reference did not render ${heading}`,
          });
        }
      }
    }
  }

  if (failures.length > 0) {
    fail(failures, { plugins: pluginRoots.length, orbits: orbitCount, phases: phaseCount });
  }

  console.error(
    `orbit workflow acceptance passed: ${pluginRoots.length} plugins, ${orbitCount} orbits, ${phaseCount} phases`,
  );
  console.error(`isolated roots: ${prismHome} ${outputRootBase}`);
  printSummary({
    pass: true,
    plugins: pluginRoots.length,
    orbits: orbitCount,
    phases: phaseCount,
    failures,
    roots: [prismHome, outputRootBase],
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

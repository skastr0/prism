/**
 * Workflow catalog — project the machine-global generated surface
 * (~/.prism/state/projects/<key>/generated/{agents,orbits,models}.ts) into a
 * compact, author-facing catalog for workflow authoring.
 *
 * The generated object keys ARE the refs an author types (`agents.forge.builder`),
 * so the catalog is imported directly from that surface and cannot drift from
 * what `prism/refs` actually resolves.
 *
 * Split into a pure projection (`projectCatalog`, unit-tested against a fixture)
 * and an I/O loader (`loadGeneratedSurface`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowWorkerHarnessIds, type WorkflowWorkerHarnessId } from "./lowerer-capabilities.js";
import {
  deriveProjectKey,
  projectCompileManifestPath,
  projectGeneratedAgentsPath,
  projectGeneratedRefsDir,
} from "./project-key.js";
import { resolvePrismHome } from "./prism-home.js";
import type { WorkflowWorkerId } from "./workflows.js";

// Assert the capability registry's `workflowWorker` bit (lowerer-capabilities.ts)
// covers exactly the harnesses with a workflow worker module (WorkflowWorkerId,
// workflows.ts / workflow-workers.ts) — in both directions. A harness flagged
// here without a worker module, or a worker module for a harness not flagged
// here, fails typecheck instead of silently drifting apart (PQ-163).
const workflowWorkerCapabilityCoverageIsExhaustive:
  Exclude<WorkflowWorkerHarnessId, WorkflowWorkerId> extends never
    ? Exclude<WorkflowWorkerId, WorkflowWorkerHarnessId> extends never
      ? true
      : never
    : never = true;
void workflowWorkerCapabilityCoverageIsExhaustive;

/** The harness workers a workflow task may target — derived from the `workflowWorker` capability bit in lowerer-capabilities.ts. That table is the single source; do not hand-list harness ids here. */
export const WORKFLOW_WORKERS: readonly WorkflowWorkerId[] = workflowWorkerHarnessIds();

interface RawModelTarget {
  readonly model?: string;
  readonly models?: ReadonlyArray<{ readonly model?: string }>;
}
interface RawAgent {
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  readonly installs?: ReadonlyArray<string>;
  readonly model?: { readonly targets?: Readonly<Record<string, RawModelTarget>> };
}
interface RawOrbit {
  readonly plugin: string;
  readonly name: string;
}
type RawGroup<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

export interface GeneratedSurface {
  readonly agents: RawGroup<RawAgent>;
  readonly orbits: RawGroup<RawOrbit>;
  readonly models: Readonly<Record<string, Record<string, Record<string, unknown>>>>;
}

export interface CatalogAgent {
  readonly ref: string;
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  readonly installs: ReadonlyArray<string>;
  readonly modelByHarness: Readonly<Record<string, string>>;
}
export interface CatalogOrbit {
  readonly ref: string;
  readonly plugin: string;
  readonly name: string;
}
export interface CatalogNamespace {
  readonly namespace: string;
  readonly orbit: CatalogOrbit | null;
  readonly agents: ReadonlyArray<CatalogAgent>;
}
export interface CatalogModelProfile {
  readonly ref: string;
  readonly plugin: string;
  readonly modelspace: string;
  readonly profile: string;
}
export interface WorkflowCatalog {
  readonly namespaces: ReadonlyArray<CatalogNamespace>;
  readonly workers: ReadonlyArray<string>;
  readonly modelProfiles: ReadonlyArray<CatalogModelProfile>;
}

const modelByHarness = (agent: RawAgent): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [harness, target] of Object.entries(agent.model?.targets ?? {})) {
    if (target.model) {
      out[harness] = target.model;
    } else if (target.models && target.models.length > 0 && target.models[0]?.model) {
      const first = target.models[0].model;
      out[harness] = target.models.length > 1 ? `${first} (+${target.models.length - 1})` : first;
    }
  }
  return out;
};

const orbitForNamespace = (orbits: RawGroup<RawOrbit>, namespace: string): CatalogOrbit | null => {
  const group = orbits[namespace];
  if (!group) return null;
  const entry = Object.entries(group)[0];
  if (!entry) return null;
  const [key, orbit] = entry;
  return { ref: `orbits.${namespace}.${key}`, plugin: orbit.plugin, name: orbit.name };
};

/** Pure projection: generated surface objects -> author-facing catalog. */
export const projectCatalog = (surface: GeneratedSurface): WorkflowCatalog => {
  const namespaces: CatalogNamespace[] = Object.keys(surface.agents)
    .sort()
    .map((namespace) => {
      const agents: CatalogAgent[] = Object.entries(surface.agents[namespace] ?? {})
        .map(([key, agent]) => ({
          ref: `agents.${namespace}.${key}`,
          plugin: agent.plugin,
          name: agent.name,
          description: agent.description,
          installs: agent.installs ?? [],
          modelByHarness: modelByHarness(agent),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { namespace, orbit: orbitForNamespace(surface.orbits, namespace), agents };
    });

  const modelProfiles: CatalogModelProfile[] = [];
  for (const [plugin, spaces] of Object.entries(surface.models ?? {})) {
    for (const [modelspace, profiles] of Object.entries(spaces ?? {})) {
      for (const profile of Object.keys(profiles ?? {})) {
        modelProfiles.push({ ref: `models.${plugin}.${modelspace}.${profile}`, plugin, modelspace, profile });
      }
    }
  }

  return { namespaces, workers: [...WORKFLOW_WORKERS], modelProfiles };
};

/** I/O: import the generated surface from a project's generated dir. Null when absent. */
export const loadGeneratedSurface = async (dir: string): Promise<GeneratedSurface | null> => {
  if (!existsSync(join(dir, "agents.ts"))) return null;
  const load = async (file: string): Promise<Record<string, unknown>> => {
    const path = join(dir, file);
    return existsSync(path) ? ((await import(path)) as Record<string, unknown>) : {};
  };
  const [agentsMod, orbitsMod, modelsMod] = await Promise.all([
    load("agents.ts"),
    load("orbits.ts"),
    load("models.ts"),
  ]);
  return {
    agents: (agentsMod.agents ?? {}) as GeneratedSurface["agents"],
    orbits: (orbitsMod.orbits ?? {}) as GeneratedSurface["orbits"],
    models: (modelsMod.models ?? {}) as GeneratedSurface["models"],
  };
};

export interface BuildCatalogResult {
  readonly surfaceDir: string;
  readonly present: boolean;
  readonly catalog: WorkflowCatalog | null;
}

/** Resolve the current project's surface and project it. */
export const buildWorkflowCatalog = async (
  options: { readonly prismHome?: string; readonly cwd?: string } = {},
): Promise<BuildCatalogResult> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const { key } = deriveProjectKey(options.cwd);
  const surfaceDir = projectGeneratedRefsDir(prismHome, key);
  const surface = await loadGeneratedSurface(surfaceDir);
  return { surfaceDir, present: surface !== null, catalog: surface ? projectCatalog(surface) : null };
};

/** Human-readable catalog rendering. */
export const renderCatalogHuman = (result: BuildCatalogResult, filterOrbit?: string): string => {
  if (!result.present || !result.catalog) {
    return [
      `No compiled workflow surface found for this project at:`,
      `  ${result.surfaceDir}`,
      ``,
      `Compile this project first: \`prism refresh <plugin-path>\` (or \`prism compile\`),`,
      `then re-run \`prism workflow catalog\`.`,
    ].join("\n");
  }
  const lines: string[] = [`Workflow surface (import refs from \`prism/refs\`):`, `  ${result.surfaceDir}`, ``];
  let shown = 0;
  for (const ns of result.catalog.namespaces) {
    if (filterOrbit && ns.namespace !== filterOrbit) continue;
    if (ns.agents.length === 0 && ns.orbit === null) continue;
    shown += 1;
    lines.push(ns.orbit ? `${ns.namespace}  (orbit ref: ${ns.orbit.ref})` : `${ns.namespace}`);
    for (const agent of ns.agents) {
      const model = agent.modelByHarness["claude-code"] ?? Object.values(agent.modelByHarness)[0] ?? "?";
      lines.push(`  ${agent.ref}  [claude-code: ${model}]`);
      lines.push(`      ${agent.description}`);
    }
    lines.push(``);
  }
  if (filterOrbit !== undefined && shown === 0) {
    lines.push(
      `No orbit/namespace named "${filterOrbit}". Available: ${result.catalog.namespaces.map((ns) => ns.namespace).join(", ")}`,
    );
  }
  if (!filterOrbit) {
    lines.push(`workers: ${result.catalog.workers.join(", ")}`);
    const profiles = result.catalog.modelProfiles;
    const sample = profiles.slice(0, 3).map((p) => p.ref).join(", ");
    lines.push(`model profiles: ${profiles.length}${profiles.length > 0 ? ` (e.g. ${sample})` : ""}`);
  }
  return lines.join("\n");
};

// --- refs / freshness ---------------------------------------------------------

export interface RefsStatus {
  readonly surfaceDir: string;
  readonly present: boolean;
  readonly refsManifestHash: string | null;
  readonly compileManifestHash: string | null;
  readonly freshness: "fresh" | "stale" | "missing";
}

/** Resolve the generated refs surface for the current project and its freshness. */
export const workflowRefsStatus = (
  options: { readonly prismHome?: string; readonly cwd?: string } = {},
): RefsStatus => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const { key } = deriveProjectKey(options.cwd);
  const surfaceDir = projectGeneratedRefsDir(prismHome, key);
  const agentsPath = projectGeneratedAgentsPath(prismHome, key);
  if (!existsSync(agentsPath)) {
    return { surfaceDir, present: false, refsManifestHash: null, compileManifestHash: null, freshness: "missing" };
  }
  const header = readFileSync(agentsPath, "utf8").slice(0, 512);
  const refsManifestHash = /Source: compile manifest ([0-9a-f]+)/u.exec(header)?.[1] ?? null;
  const manifestPath = projectCompileManifestPath(prismHome, key);
  let compileManifestHash: string | null = null;
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly manifestHash?: string };
      compileManifestHash = parsed.manifestHash ?? null;
    } catch {
      compileManifestHash = null;
    }
  }
  const freshness: RefsStatus["freshness"] =
    compileManifestHash === null || refsManifestHash === null
      ? "fresh"
      : refsManifestHash === compileManifestHash
        ? "fresh"
        : "stale";
  return { surfaceDir, present: true, refsManifestHash, compileManifestHash, freshness };
};

export const renderRefsStatus = (status: RefsStatus): string => {
  if (!status.present) {
    return [
      `refs:      ${status.surfaceDir}`,
      `freshness: missing — compile this project first (\`prism refresh <plugin-path>\`)`,
    ].join("\n");
  }
  const detail =
    status.freshness === "stale"
      ? `  (refs ${status.refsManifestHash?.slice(0, 12)} != compile ${status.compileManifestHash?.slice(0, 12)} — run \`prism refresh\`)`
      : "";
  return [`refs:      ${status.surfaceDir}`, `freshness: ${status.freshness}${detail}`].join("\n");
};

// --- scaffold -----------------------------------------------------------------

/**
 * Pick a sensible default agent for a starter workflow: the generic Forge
 * explorer if present, then any explorer, then any orchestrator, then anything.
 */
export const pickDefaultAgent = (catalog: WorkflowCatalog): CatalogAgent | undefined => {
  const all = catalog.namespaces.flatMap((ns) => ns.agents);
  return (
    all.find((agent) => agent.ref === "agents.forge.explorer") ??
    all.find((agent) => agent.name === "explorer") ??
    all.find((agent) => agent.name.includes("orchestrator")) ??
    all[0]
  );
};

/** Same pick as {@link pickDefaultAgent}, projected to its ref string. */
export const pickDefaultAgentRef = (catalog: WorkflowCatalog): string =>
  pickDefaultAgent(catalog)?.ref ?? "agents.forge.explorer";

/**
 * Pick 1-2 workers for the scaffold's example tasks, restricted to harnesses
 * the chosen agent is actually compiled for (`agent.installs`) that also have
 * a Prism workflow-worker module (`catalog.workers`) — never a harness the
 * generated workflow can't run against out of the box (PQ-176 footgun #2).
 * Two workers reproduce the illustrative cross-harness fan-out; one worker
 * degrades to a single task when the agent is installed on only one workflow
 * harness. Falls back to "claude-code" alone when the agent has no recorded
 * installs (e.g. an empty/minimal catalog) since it's the most commonly
 * available workflow worker.
 */
export const pickDefaultWorkers = (
  catalog: WorkflowCatalog,
  agent: CatalogAgent | undefined,
): readonly [string] | readonly [string, string] => {
  const workerSet = new Set(catalog.workers);
  const runnable = (agent?.installs ?? []).filter((harness) => workerSet.has(harness));
  if (runnable.length === 0) return ["claude-code"];
  // Prefer claude-code first when it's installed — the most broadly
  // authenticated default harness — so fan-out order reads predictably
  // instead of drifting with the (alphabetical) installs list.
  const ordered = runnable.includes("claude-code")
    ? ["claude-code", ...runnable.filter((harness) => harness !== "claude-code")]
    : runnable;
  return ordered.length >= 2 ? [ordered[0]!, ordered[1]!] : [ordered[0]!];
};

/** A complete, validating starter workflow source that uses a real discovered agent ref and installed workers. */
export const scaffoldWorkflowSource = (
  name: string,
  agentRef: string,
  workers: readonly [string] | readonly [string, string],
): string => {
  const header = `/**
 * ${name} — scaffolded by \`prism workflow scaffold\`.
 * Lives at ~/.prism/workflows/${name}.workflow.ts by convention — never inside
 * (or git-added to) the project repo it drives; tasks reference their target
 * repo by absolute path, so the file's own location doesn't matter to it.
 * Edit the tasks, then:
 *   prism workflow validate ~/.prism/workflows/${name}.workflow.ts
 *   prism workflow run      ~/.prism/workflows/${name}.workflow.ts --max-concurrent-tasks 2
 *
 * Discover other agents/orbits/models with: prism workflow catalog
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const Result = Schema.Struct({
  worker: Schema.String,
  summary: Schema.String,
});
`;

  const workerUnion = workers.map((worker) => JSON.stringify(worker)).join(" | ");
  const probe = `const probe = (id: string, worker: ${workerUnion}) =>
  defineTask({
    id,
    agent: ${agentRef},
    prompt: \`Run under the \${worker} harness and return a one-line summary in "summary". Set worker="\${worker}".\`,
    output: Result,
    cacheKey: \`${name}-\${worker}-v1\`,
    worker: { worker },
  });
`;

  const run =
    workers.length === 2
      ? `export const workflow = defineWorkflow({
  name: "${name}",
  run: (wf) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [wf.runTask(probe("a", ${JSON.stringify(workers[0])})), wf.runTask(probe("b", ${JSON.stringify(workers[1])}))],
        { concurrency: "unbounded" },
      );
      return { results };
    }),
});
`
      : `export const workflow = defineWorkflow({
  name: "${name}",
  run: (wf) =>
    Effect.gen(function* () {
      const result = yield* wf.runTask(probe("a", ${JSON.stringify(workers[0])}));
      return { results: [result] };
    }),
});
`;

  return `${header}\n${probe}\n${run}`;
};


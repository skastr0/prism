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
import {
  deriveProjectKey,
  projectCompileManifestPath,
  projectGeneratedAgentsPath,
  projectGeneratedRefsDir,
} from "./project-key.js";
import { resolvePrismHome } from "./prism-home.js";

/** The harness workers a workflow task may target. */
export const WORKFLOW_WORKERS = [
  "claude-code",
  "codex-cli",
  "grok",
  "opencode",
  "hermes",
  "kimi-code",
  "amp-code",
] as const;

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
 * Pick a sensible default agent ref for a starter workflow: the generic Forge
 * explorer if present, then any explorer, then any orchestrator, then anything.
 */
export const pickDefaultAgentRef = (catalog: WorkflowCatalog): string => {
  const all = catalog.namespaces.flatMap((ns) => ns.agents);
  return (
    all.find((agent) => agent.ref === "agents.forge.explorer")?.ref ??
    all.find((agent) => agent.name === "explorer")?.ref ??
    all.find((agent) => agent.name.includes("orchestrator"))?.ref ??
    all[0]?.ref ??
    "agents.forge.explorer"
  );
};

/** A complete, validating starter workflow source that uses a real discovered agent ref. */
export const scaffoldWorkflowSource = (name: string, agentRef: string): string =>
  `/**
 * ${name} — scaffolded by \`prism workflow scaffold\`.
 * Edit the tasks, then:
 *   git add workflows/${name}.workflow.ts
 *   prism workflow validate workflows/${name}.workflow.ts
 *   prism workflow run      workflows/${name}.workflow.ts --max-concurrent-tasks 2
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

const probe = (id: string, worker: "claude-code" | "grok") =>
  defineTask({
    id,
    agent: ${agentRef},
    prompt: \`Run under the \${worker} harness and return a one-line summary in "summary". Set worker="\${worker}".\`,
    output: Result,
    cacheKey: \`${name}-\${worker}-v1\`,
    worker: { worker },
  });

export const workflow = defineWorkflow({
  name: "${name}",
  run: (wf) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [wf.runTask(probe("a", "claude-code")), wf.runTask(probe("b", "grok"))],
        { concurrency: "unbounded" },
      );
      return { results };
    }),
});
`;


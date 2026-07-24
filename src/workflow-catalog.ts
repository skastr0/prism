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
interface RawOrbitAgent {
  readonly plugin: string;
  readonly name: string;
}
interface RawOrbitPhase {
  readonly name: string;
  readonly orbit: string;
  readonly plugin: string;
  readonly agents: Readonly<Record<string, RawOrbitAgent>>;
  readonly criteria: ReadonlyArray<string>;
  readonly io: { readonly inputs: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> };
  readonly framing: Readonly<Record<string, string>>;
  readonly notes?: Readonly<Record<string, string>>;
  readonly contract?: { readonly input?: unknown; readonly output?: unknown };
}
interface RawOrbit {
  readonly kind?: string;
  readonly plugin: string;
  readonly name: string;
  readonly sequence?: ReadonlyArray<string>;
  readonly phases?: Readonly<Record<string, RawOrbitPhase>>;
}
type RawGroup<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const isTypedOrbit = (orbit: RawOrbit): orbit is RawOrbit & { readonly phases: Readonly<Record<string, RawOrbitPhase>> } =>
  orbit.phases !== undefined && typeof orbit.phases === "object";

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
export interface CatalogPhaseAgent {
  readonly slot: string;
  readonly ref: string;
  readonly plugin: string;
  readonly name: string;
}
export interface CatalogPhaseSummary {
  readonly ref: string;
  readonly key: string;
  readonly name: string;
  readonly agents: ReadonlyArray<CatalogPhaseAgent>;
  readonly criteriaCount: number;
  readonly hasContract: boolean;
}
export interface CatalogOrbitDetail extends CatalogOrbit {
  readonly sequence: ReadonlyArray<string>;
  readonly phases: ReadonlyArray<CatalogPhaseSummary>;
  readonly phaseDetails: ReadonlyArray<CatalogPhaseDetail>;
}
export interface CatalogPhaseDetail extends CatalogPhaseSummary {
  readonly orbit: string;
  readonly plugin: string;
  readonly criteria: ReadonlyArray<string>;
  readonly io: { readonly inputs: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> };
  readonly framing: Readonly<Record<string, string>>;
  readonly notes?: Readonly<Record<string, string>>;
  readonly hasInputContract: boolean;
  readonly hasOutputContract: boolean;
}
export interface CatalogNamespace {
  readonly namespace: string;
  readonly orbit: CatalogOrbit | null;
  readonly orbitDetail: CatalogOrbitDetail | null;
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

const orbitEntryForNamespace = (
  orbits: RawGroup<RawOrbit>,
  namespace: string,
): { readonly key: string; readonly orbit: RawOrbit } | null => {
  const group = orbits[namespace];
  if (!group) return null;
  const entry = Object.entries(group)[0];
  if (!entry) return null;
  return { key: entry[0], orbit: entry[1] };
};

const orbitForNamespace = (orbits: RawGroup<RawOrbit>, namespace: string): CatalogOrbit | null => {
  const entry = orbitEntryForNamespace(orbits, namespace);
  if (!entry) return null;
  return { ref: `orbits.${namespace}.${entry.key}`, plugin: entry.orbit.plugin, name: entry.orbit.name };
};

const projectPhaseAgents = (namespace: string, agents: Readonly<Record<string, RawOrbitAgent>>): CatalogPhaseAgent[] =>
  Object.entries(agents)
    .map(([slot, agent]) => ({
      slot,
      ref: `agents.${namespace}.${slot}`,
      plugin: agent.plugin,
      name: agent.name,
    }))
    .sort((left, right) => left.slot.localeCompare(right.slot));

const projectPhaseDetail = (
  namespace: string,
  orbitKey: string,
  orbitName: string,
  orbitPlugin: string,
  phaseKey: string,
  phase: RawOrbitPhase,
): CatalogPhaseDetail => ({
  ref: `orbits.${namespace}.${orbitKey}.phases.${phaseKey}`,
  key: phaseKey,
  name: phase.name,
  orbit: orbitName,
  plugin: orbitPlugin,
  agents: projectPhaseAgents(namespace, phase.agents),
  criteriaCount: phase.criteria.length,
  hasContract: phase.contract?.input !== undefined || phase.contract?.output !== undefined,
  criteria: [...phase.criteria],
  io: {
    inputs: [...phase.io.inputs],
    outputs: [...phase.io.outputs],
  },
  framing: { ...phase.framing },
  ...(phase.notes !== undefined ? { notes: { ...phase.notes } } : {}),
  hasInputContract: phase.contract?.input !== undefined,
  hasOutputContract: phase.contract?.output !== undefined,
});

const projectPhaseSummary = (detail: CatalogPhaseDetail): CatalogPhaseSummary => ({
  ref: detail.ref,
  key: detail.key,
  name: detail.name,
  agents: detail.agents,
  criteriaCount: detail.criteriaCount,
  hasContract: detail.hasContract,
});

const projectOrbitDetail = (
  orbits: RawGroup<RawOrbit>,
  namespace: string,
): CatalogOrbitDetail | null => {
  const entry = orbitEntryForNamespace(orbits, namespace);
  if (!entry) return null;
  const base = { ref: `orbits.${namespace}.${entry.key}`, plugin: entry.orbit.plugin, name: entry.orbit.name };
  if (!isTypedOrbit(entry.orbit)) {
    return { ...base, sequence: [], phases: [], phaseDetails: [] };
  }
  const sequence = entry.orbit.sequence ?? Object.keys(entry.orbit.phases);
  const phaseDetails = sequence
    .map((phaseKey) => {
      const phase = entry.orbit.phases?.[phaseKey];
      return phase
        ? projectPhaseDetail(namespace, entry.key, entry.orbit.name, entry.orbit.plugin, phaseKey, phase)
        : null;
    })
    .filter((phase): phase is CatalogPhaseDetail => phase !== null);
  return {
    ...base,
    sequence: [...sequence],
    phases: phaseDetails.map(projectPhaseSummary),
    phaseDetails,
  };
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
      return {
        namespace,
        orbit: orbitForNamespace(surface.orbits, namespace),
        orbitDetail: projectOrbitDetail(surface.orbits, namespace),
        agents,
      };
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

const renderMissingSurfaceHuman = (surfaceDir: string): string =>
  [
    `No compiled workflow surface found for this project at:`,
    `  ${surfaceDir}`,
    ``,
    `Compile this project first: \`prism refresh <plugin-path>\`,`,
    `then re-run \`prism workflow catalog\`.`,
  ].join("\n");

/** Human-readable full-detail catalog rendering (used by `--full` and `--orbit <ns>`). */
export const renderCatalogHuman = (result: BuildCatalogResult, filterOrbit?: string): string => {
  if (!result.present || !result.catalog) {
    return renderMissingSurfaceHuman(result.surfaceDir);
  }
  const lines: string[] = [`Workflow surface (import refs from \`prism/refs\`):`, `  ${result.surfaceDir}`, ``];
  let shown = 0;
  for (const ns of result.catalog.namespaces) {
    if (filterOrbit && ns.namespace !== filterOrbit) continue;
    if (ns.agents.length === 0 && ns.orbit === null) continue;
    shown += 1;
    lines.push(ns.orbit ? `${ns.namespace}  (orbit ref: ${ns.orbit.ref})` : `${ns.namespace}`);
    if (ns.orbitDetail && ns.orbitDetail.phases.length > 0) {
      const sequence = ns.orbitDetail.sequence.length > 0 ? ns.orbitDetail.sequence.join(" → ") : "(unordered)";
      lines.push(`  phases (${sequence}):`);
      for (const phase of ns.orbitDetail.phases) {
        const agentNames = phase.agents.map((agent) => agent.slot).join(", ") || "(none)";
        const contract = phase.hasContract ? "yes" : "no";
        lines.push(
          `    ${phase.name}  agents: ${agentNames}  criteria: ${phase.criteriaCount}  contract: ${contract}`,
        );
        lines.push(`      ref: ${phase.ref}`);
      }
      lines.push(``);
    }
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

// --- gradual-disclosure catalog modes ------------------------------------------
//
// `prism workflow catalog` defaults to a compact index (this section) instead of
// the full dump (`renderCatalogHuman` above) — the full dump is a context bomb
// for an agent skimming for one ref. Every mode below composes with `--json`.

export interface CompactNamespaceEntry {
  readonly namespace: string;
  readonly orbitRef: string | null;
  readonly agentCount: number;
}

export interface CompactCatalogIndex {
  readonly surfaceDir: string;
  readonly present: true;
  readonly namespaces: ReadonlyArray<CompactNamespaceEntry>;
  readonly workers: ReadonlyArray<string>;
  readonly modelProfileCount: number;
}

/** Pure projection: one line per namespace, no per-agent detail — the default `catalog` view. */
export const projectCompactIndex = (catalog: WorkflowCatalog, surfaceDir: string): CompactCatalogIndex => ({
  surfaceDir,
  present: true,
  namespaces: catalog.namespaces
    .filter((ns) => ns.agents.length > 0 || ns.orbit !== null)
    .map((ns) => ({ namespace: ns.namespace, orbitRef: ns.orbit?.ref ?? null, agentCount: ns.agents.length })),
  workers: catalog.workers,
  modelProfileCount: catalog.modelProfiles.length,
});

export const renderCompactIndexHuman = (index: CompactCatalogIndex): string => {
  const lines: string[] = [`Workflow surface (compact index — import refs from \`prism/refs\`):`, `  ${index.surfaceDir}`, ``];
  for (const ns of index.namespaces) {
    const agentCount = `${ns.agentCount} agent${ns.agentCount === 1 ? "" : "s"}`;
    lines.push(ns.orbitRef ? `${ns.namespace}  (${agentCount}, orbit ref: ${ns.orbitRef})` : `${ns.namespace}  (${agentCount})`);
  }
  lines.push(``);
  lines.push(`workers: ${index.workers.join(", ")}`);
  lines.push(`model profiles: ${index.modelProfileCount}`);
  lines.push(``);
  lines.push(
    `Drill down: --orbit <ns> (one namespace) | --ref <ref> (one entity) | --query <text> (search) | --full (complete dump)`,
  );
  return lines.join("\n");
};

export interface OrbitLookupResult {
  readonly found: boolean;
  readonly namespace: CatalogNamespace | null;
  readonly orbitDetail: CatalogOrbitDetail | null;
  readonly phases: ReadonlyArray<CatalogPhaseSummary>;
  readonly available: ReadonlyArray<string>;
}

/** Pure lookup backing `--orbit <name>`'s JSON output (the human path still uses {@link renderCatalogHuman}). */
export const lookupOrbitNamespace = (catalog: WorkflowCatalog, orbitName: string): OrbitLookupResult => {
  const namespace = catalog.namespaces.find((ns) => ns.namespace === orbitName) ?? null;
  const orbitDetail = namespace?.orbitDetail ?? null;
  return {
    found: namespace !== null,
    namespace,
    orbitDetail,
    phases: orbitDetail?.phases ?? [],
    available: catalog.namespaces.map((ns) => ns.namespace),
  };
};

/** A single catalog entity resolved by ref, tagged with its kind so `--ref` output stays a discriminated union. */
export type CatalogEntity =
  | ({ readonly kind: "agent" } & CatalogAgent)
  | ({ readonly kind: "orbit" } & CatalogOrbitDetail)
  | ({ readonly kind: "phase" } & CatalogPhaseDetail)
  | ({ readonly kind: "model" } & CatalogModelProfile);

export interface RefLookupResult {
  readonly found: boolean;
  readonly entity: CatalogEntity | null;
  /** Up to 5 refs closest to the query, by simple substring match, when not found. */
  readonly suggestions: ReadonlyArray<string>;
}

const catalogEntities = (catalog: WorkflowCatalog): ReadonlyArray<CatalogEntity> => {
  const entities: CatalogEntity[] = [];
  for (const ns of catalog.namespaces) {
    if (ns.orbitDetail) entities.push({ kind: "orbit", ...ns.orbitDetail });
    if (ns.orbitDetail) {
      for (const phase of ns.orbitDetail.phaseDetails) entities.push({ kind: "phase", ...phase });
    } else if (ns.orbit) {
      entities.push({ kind: "orbit", ...ns.orbit, sequence: [], phases: [], phaseDetails: [] });
    }
    for (const agent of ns.agents) entities.push({ kind: "agent", ...agent });
  }
  for (const profile of catalog.modelProfiles) entities.push({ kind: "model", ...profile });
  return entities;
};

/** Pure lookup backing `--ref <ref>`: exact match, else up to 5 substring-closest suggestions. */
export const lookupCatalogRef = (catalog: WorkflowCatalog, ref: string): RefLookupResult => {
  const entities = catalogEntities(catalog);
  const hit = entities.find((entity) => entity.ref === ref);
  if (hit) return { found: true, entity: hit, suggestions: [] };
  const needle = ref.toLowerCase();
  const suggestions = entities
    .filter((entity) => {
      const candidate = entity.ref.toLowerCase();
      return candidate.includes(needle) || needle.includes(candidate);
    })
    .map((entity) => entity.ref)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 5);
  return { found: false, entity: null, suggestions };
};

export const renderRefNotFoundMessage = (ref: string, suggestions: ReadonlyArray<string>): string =>
  suggestions.length > 0
    ? `no entity with ref "${ref}". Closest matches: ${suggestions.join(", ")}`
    : `no entity with ref "${ref}". No close matches — try \`prism workflow catalog --query <text>\` to search.`;

export const renderRefDetailHuman = (entity: CatalogEntity): string => {
  if (entity.kind === "agent") {
    const modelLines = Object.entries(entity.modelByHarness).map(([harness, model]) => `  ${harness}: ${model}`);
    return [
      `${entity.ref}`,
      `  plugin: ${entity.plugin}`,
      `  name: ${entity.name}`,
      `  description: ${entity.description}`,
      `  installs: ${entity.installs.length > 0 ? entity.installs.join(", ") : "(none recorded)"}`,
      `  model by harness:`,
      ...(modelLines.length > 0 ? modelLines : [`    (none recorded)`]),
    ].join("\n");
  }
  if (entity.kind === "orbit") {
    const lines = [`${entity.ref}`, `  plugin: ${entity.plugin}`, `  name: ${entity.name}`];
    if (entity.sequence.length > 0) lines.push(`  sequence: ${entity.sequence.join(" → ")}`);
    if (entity.phases.length > 0) {
      lines.push(`  phases:`);
      for (const phase of entity.phases) {
        const agentNames = phase.agents.map((agent) => agent.slot).join(", ") || "(none)";
        lines.push(
          `    ${phase.name}  agents: ${agentNames}  criteria: ${phase.criteriaCount}  contract: ${phase.hasContract ? "yes" : "no"}`,
        );
        lines.push(`      ref: ${phase.ref}`);
      }
    }
    return lines.join("\n");
  }
  if (entity.kind === "phase") {
    const agentLines = entity.agents.map((agent) => `    ${agent.slot}: ${agent.ref} (${agent.plugin}/${agent.name})`);
    const framingLines = Object.entries(entity.framing).map(([key, value]) => `    ${key}: ${value}`);
    return [
      `${entity.ref}`,
      `  orbit: ${entity.orbit}`,
      `  plugin: ${entity.plugin}`,
      `  name: ${entity.name}`,
      `  agents:`,
      ...(agentLines.length > 0 ? agentLines : ["    (none)"]),
      `  criteria (${entity.criteria.length}): ${entity.criteria.length > 0 ? entity.criteria.join("; ") : "(none)"}`,
      `  contract: input=${entity.hasInputContract ? "yes" : "no"} output=${entity.hasOutputContract ? "yes" : "no"}`,
      `  io inputs: ${entity.io.inputs.join(", ") || "(none)"}`,
      `  io outputs: ${entity.io.outputs.join(", ") || "(none)"}`,
      ...(framingLines.length > 0 ? [`  framing:`, ...framingLines] : []),
    ].join("\n");
  }
  return [`${entity.ref}`, `  plugin: ${entity.plugin}`, `  modelspace: ${entity.modelspace}`, `  profile: ${entity.profile}`].join("\n");
};

export interface CatalogQueryHit {
  readonly ref: string;
  readonly name: string;
  /** First ~100 chars of the entity's description; empty for entities without one (orbits, model profiles). */
  readonly descriptionExcerpt: string;
}

const excerpt = (description: string, maxLength = 100): string =>
  description.length > maxLength ? `${description.slice(0, maxLength)}…` : description;

/** Pure search backing `--query <text>`: case-insensitive substring match over refs, names, and descriptions. */
export const searchCatalog = (catalog: WorkflowCatalog, query: string): ReadonlyArray<CatalogQueryHit> => {
  const needle = query.toLowerCase();
  const matches = (...haystack: ReadonlyArray<string>): boolean =>
    haystack.some((text) => text.toLowerCase().includes(needle));
  const hits: CatalogQueryHit[] = [];
  for (const ns of catalog.namespaces) {
    if (ns.orbit && matches(ns.orbit.ref, ns.orbit.name)) {
      hits.push({ ref: ns.orbit.ref, name: ns.orbit.name, descriptionExcerpt: "" });
    }
    if (ns.orbitDetail) {
      for (const phase of ns.orbitDetail.phaseDetails) {
        if (matches(phase.ref, phase.name)) {
          hits.push({ ref: phase.ref, name: phase.name, descriptionExcerpt: "" });
        }
      }
    }
    for (const agent of ns.agents) {
      if (matches(agent.ref, agent.name, agent.description)) {
        hits.push({ ref: agent.ref, name: agent.name, descriptionExcerpt: excerpt(agent.description) });
      }
    }
  }
  for (const profile of catalog.modelProfiles) {
    if (matches(profile.ref, profile.profile)) {
      hits.push({ ref: profile.ref, name: profile.profile, descriptionExcerpt: "" });
    }
  }
  return hits;
};

export const renderQueryResultsHuman = (hits: ReadonlyArray<CatalogQueryHit>, query: string): string => {
  if (hits.length === 0) {
    return [`No matches for "${query}".`, `Run \`prism workflow catalog\` for the compact index.`].join("\n");
  }
  const lines = hits.map((hit) =>
    hit.descriptionExcerpt.length > 0 ? `${hit.ref} — ${hit.name} — ${hit.descriptionExcerpt}` : `${hit.ref} — ${hit.name}`,
  );
  lines.push(``);
  lines.push(`Drill in: \`prism workflow catalog --ref <ref>\``);
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


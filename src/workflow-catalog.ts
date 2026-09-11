/**
 * Workflow catalog — project the machine-global generated surface
 * (~/.prism/state/projects/<key>/generated/{sops,models}.ts) into a
 * compact, author-facing catalog for workflow authoring.
 *
 * The generated object keys ARE the refs an author types (`sops.forge.beacon.phases.build`),
 * so the catalog is imported directly from that surface and cannot drift from
 * what `prism/refs` actually resolves.
 *
 * Split into a pure projection (`projectCatalog`, unit-tested against a fixture)
 * and an I/O loader (`loadGeneratedSurface`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveEffectRuntimePath } from "./compile/load.js";
import { rewriteGeneratedRefsForRuntime } from "./workflow-generated-surface.js";
import { workflowWorkerHarnessIds, type WorkflowWorkerHarnessId } from "./lowerer-capabilities.js";
import {
  deriveProjectKey,
  projectCompileManifestPath,
  projectGeneratedSopsPath,
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

interface RawSopPhase {
  readonly name: string;
  readonly sop?: string;
  readonly plugin?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly criteria?: ReadonlyArray<string>;
  readonly framing?: {
    readonly purpose?: string;
    readonly when?: string;
    readonly escalation?: string;
  };
}
interface RawSop {
  readonly plugin: string;
  readonly name: string;
  readonly phases?: Readonly<Record<string, RawSopPhase>>;
}
type RawGroup<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

export interface GeneratedSurface {
  readonly sops: RawGroup<RawSop>;
  readonly models: Readonly<Record<string, Record<string, Record<string, unknown>>>>;
}
export interface CatalogSop {
  readonly ref: string;
  readonly plugin: string;
  readonly name: string;
}
export interface CatalogSopPhaseDetail {
  readonly ref: string;
  readonly key: string;
  readonly name: string;
  readonly purpose: string;
  readonly acceptanceCriteriaCount: number;
  readonly hasInputContract: boolean;
  readonly hasOutputContract: boolean;
  readonly when?: string;
  readonly escalation?: string;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}
export interface CatalogSopDetail extends CatalogSop {
  readonly phases: ReadonlyArray<CatalogSopPhaseDetail>;
}
export interface CatalogNamespace {
  readonly namespace: string;
  readonly sops: ReadonlyArray<CatalogSopDetail>;
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

const projectSopPhaseDetail = (
  namespace: string,
  sopKey: string,
  phaseKey: string,
  phase: RawSopPhase,
): CatalogSopPhaseDetail => {
  const criteria = phase.criteria ?? [];
  const framing = phase.framing ?? {};
  return {
    ref: `sops.${namespace}.${sopKey}.phases.${phaseKey}`,
    key: phaseKey,
    name: phase.name,
    purpose: framing.purpose ?? "",
    acceptanceCriteriaCount: criteria.length,
    hasInputContract: phase.input !== undefined,
    hasOutputContract: phase.output !== undefined,
    ...(framing.when !== undefined ? { when: framing.when } : {}),
    ...(framing.escalation !== undefined ? { escalation: framing.escalation } : {}),
    acceptanceCriteria: [...criteria],
  };
};

const projectSopDetails = (
  sops: RawGroup<RawSop>,
  namespace: string,
): CatalogSopDetail[] =>
  Object.entries(sops[namespace] ?? {})
    .map(([sopKey, sop]) => ({
      ref: `sops.${namespace}.${sopKey}`,
      plugin: sop.plugin,
      name: sop.name,
      phases: Object.entries(sop.phases ?? {})
        .map(([phaseKey, phase]) =>
          projectSopPhaseDetail(namespace, sopKey, phaseKey, phase)
        )
        .sort((left, right) => left.key.localeCompare(right.key)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

/** Pure projection: generated surface objects -> author-facing catalog. */
export const projectCatalog = (surface: GeneratedSurface): WorkflowCatalog => {
  const namespaces: CatalogNamespace[] = Object.keys(surface.sops)
    .sort()
    .map((namespace) => ({
      namespace,
      sops: projectSopDetails(surface.sops, namespace),
    }));

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
  if (!existsSync(join(dir, "sops.ts"))) return null;
  const runtimeDir = rewriteGeneratedRefsForRuntime(dir, await resolveEffectRuntimePath());
  const load = async (file: string): Promise<Record<string, unknown>> => {
    const path = join(runtimeDir, file);
    return existsSync(path) ? ((await import(pathToFileURL(path).href)) as Record<string, unknown>) : {};
  };
  const [sopsMod, modelsMod] = await Promise.all([
    load("sops.ts"),
    load("models.ts"),
  ]);
  return {
    sops: (sopsMod.sops ?? {}) as GeneratedSurface["sops"],
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
    `Workflows are plugin-free. No compiled plugin refs at:`,
    `  ${surfaceDir}`,
    ``,
    `List live harness slugs:  \`prism workflow models\``,
    `Query one worker:         \`prism workflow models --worker cursor --query opus\``,
    `Refresh the snapshot:     \`prism workflow refresh-harness-types\``,
    `Scaffold a starter:       \`prism workflow scaffold hello\``,
    ``,
    `Plugin refs (sops.*) are optional. Compile a plugin only if you want them.`,
  ].join("\n");

/** Human-readable full-detail catalog rendering (used by `--full`). */
export const renderCatalogHuman = (result: BuildCatalogResult): string => {
  if (!result.present || !result.catalog) {
    return renderMissingSurfaceHuman(result.surfaceDir);
  }
  const lines: string[] = [`Workflow surface (import refs from \`prism/refs\`):`, `  ${result.surfaceDir}`, ``];
  for (const ns of result.catalog.namespaces) {
    if (ns.sops.length === 0) continue;
    lines.push(`${ns.namespace}`);
    for (const sop of ns.sops) {
      lines.push(`  sop ref: ${sop.ref}`);
      for (const phase of sop.phases) {
        const contract = phase.hasInputContract || phase.hasOutputContract ? "yes" : "no";
        lines.push(
          `    ${phase.name}  purpose: ${phase.purpose}  criteria: ${phase.acceptanceCriteriaCount}  contract: ${contract}`,
        );
        lines.push(`      ref: ${phase.ref}`);
      }
      lines.push(``);
    }
    lines.push(``);
  }
  lines.push(`workers: ${result.catalog.workers.join(", ")}`);
  const profiles = result.catalog.modelProfiles;
  const sample = profiles.slice(0, 3).map((p) => p.ref).join(", ");
  lines.push(`model profiles: ${profiles.length}${profiles.length > 0 ? ` (e.g. ${sample})` : ""}`);
  return lines.join("\n");
};

// --- gradual-disclosure catalog modes ------------------------------------------
//
// `prism workflow catalog` defaults to a compact index (this section) instead of
// the full dump (`renderCatalogHuman` above) — the full dump is a context bomb
// for an agent skimming for one ref. Every mode below composes with `--json`.

export interface CompactNamespaceEntry {
  readonly namespace: string;
  readonly sopRefs: ReadonlyArray<string>;
}

export interface CompactCatalogIndex {
  readonly surfaceDir: string;
  readonly present: true;
  readonly namespaces: ReadonlyArray<CompactNamespaceEntry>;
  readonly workers: ReadonlyArray<string>;
  readonly modelProfileCount: number;
}

/** Pure projection: one line per namespace, no per-phase detail — the default `catalog` view. */
export const projectCompactIndex = (catalog: WorkflowCatalog, surfaceDir: string): CompactCatalogIndex => ({
  surfaceDir,
  present: true,
  namespaces: catalog.namespaces
    .filter((ns) => ns.sops.length > 0)
    .map((ns) => ({
      namespace: ns.namespace,
      sopRefs: ns.sops.map((sop) => sop.ref),
    })),
  workers: catalog.workers,
  modelProfileCount: catalog.modelProfiles.length,
});

export const renderCompactIndexHuman = (index: CompactCatalogIndex): string => {
  const lines: string[] = [`Workflow surface (compact index — import refs from \`prism/refs\`):`, `  ${index.surfaceDir}`, ``];
  for (const ns of index.namespaces) {
    lines.push(`${ns.namespace}  (${ns.sopRefs.join(", ")})`);
  }
  lines.push(``);
  lines.push(`workers: ${index.workers.join(", ")}`);
  lines.push(`model profiles: ${index.modelProfileCount}  (plugin modelspaces — optional)`);
  lines.push(`harness models: \`prism workflow models\`  (plugin-free live slugs)`);
  lines.push(``);
  lines.push(
    `Drill down: --sop <name> (one sop) | --ref <ref> (one entity) | --query <text> (search) | --full (complete dump)`,
  );
  return lines.join("\n");
};

export interface SopLookupResult {
  readonly found: boolean;
  readonly namespace: string | null;
  readonly sop: CatalogSopDetail | null;
  readonly phases: ReadonlyArray<CatalogSopPhaseDetail>;
  readonly available: ReadonlyArray<string>;
}

/**
 * Pure lookup backing `--sop <name>`. Accepts a bare sop name (`beacon`), a
 * namespace-qualified name (`beacon.beacon`), or a full ref
 * (`sops.beacon.beacon`).
 */
export const lookupSop = (catalog: WorkflowCatalog, query: string): SopLookupResult => {
  for (const ns of catalog.namespaces) {
    for (const sop of ns.sops) {
      const matches =
        sop.name === query ||
        sop.ref === query ||
        `${ns.namespace}.${sop.name}` === query;
      if (!matches) continue;
      return {
        found: true,
        namespace: ns.namespace,
        sop,
        phases: sop.phases,
        available: catalog.namespaces.flatMap((entry) => entry.sops.map((entrySop) => entrySop.ref)),
      };
    }
  }
  return {
    found: false,
    namespace: null,
    sop: null,
    phases: [],
    available: catalog.namespaces.flatMap((ns) => ns.sops.map((sop) => sop.ref)),
  };
};

/** A single catalog entity resolved by ref, tagged with its kind so `--ref` output stays a discriminated union. */
export type CatalogEntity =
  | ({ readonly kind: "sop" } & CatalogSopDetail)
  | ({ readonly kind: "sop-phase" } & CatalogSopPhaseDetail)
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
    for (const sop of ns.sops) {
      entities.push({ kind: "sop", ...sop });
      for (const phase of sop.phases) entities.push({ kind: "sop-phase", ...phase });
    }
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
  if (entity.kind === "sop") {
    const lines = [`${entity.ref}`, `  plugin: ${entity.plugin}`, `  name: ${entity.name}`];
    if (entity.phases.length > 0) {
      lines.push(`  phases:`);
      for (const phase of entity.phases) {
        const contract = phase.hasInputContract || phase.hasOutputContract ? "yes" : "no";
        lines.push(
          `    ${phase.name}  criteria: ${phase.acceptanceCriteriaCount}  contract: ${contract}`,
        );
        lines.push(`      purpose: ${phase.purpose}`);
        lines.push(`      ref: ${phase.ref}`);
      }
    }
    return lines.join("\n");
  }
  if (entity.kind === "sop-phase") {
    return [
      `${entity.ref}`,
      `  name: ${entity.name}`,
      `  purpose: ${entity.purpose}`,
      `  contract: input=${entity.hasInputContract ? "yes" : "no"} output=${entity.hasOutputContract ? "yes" : "no"}`,
      `  acceptance criteria (${entity.acceptanceCriteria.length}): ${entity.acceptanceCriteria.length > 0 ? entity.acceptanceCriteria.join("; ") : "(none)"}`,
      ...(entity.escalation !== undefined ? [`  escalation: ${entity.escalation}`] : []),
    ].join("\n");
  }
  return [`${entity.ref}`, `  plugin: ${entity.plugin}`, `  modelspace: ${entity.modelspace}`, `  profile: ${entity.profile}`].join("\n");
};

export interface CatalogQueryHit {
  readonly ref: string;
  readonly name: string;
  /** First ~100 chars of the entity's description; empty for entities without one (models). */
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
    for (const sop of ns.sops) {
      if (matches(sop.ref, sop.name)) {
        hits.push({ ref: sop.ref, name: sop.name, descriptionExcerpt: "" });
      }
      for (const phase of sop.phases) {
        if (matches(phase.ref, phase.name, phase.purpose, phase.acceptanceCriteria.join(" "), phase.escalation ?? "")) {
          hits.push({ ref: phase.ref, name: phase.name, descriptionExcerpt: excerpt(phase.purpose) });
        }
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
  const sopsPath = projectGeneratedSopsPath(prismHome, key);
  if (!existsSync(sopsPath)) {
    return { surfaceDir, present: false, refsManifestHash: null, compileManifestHash: null, freshness: "missing" };
  }
  const header = readFileSync(sopsPath, "utf8").slice(0, 512);
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
      `freshness: missing — no compiled plugin refs (optional)`,
      `  List slugs:  \`prism workflow models\``,
      `  Compile refs only if you want sops.*: \`prism refresh <plugin-path>\``,
    ].join("\n");
  }
  const detail =
    status.freshness === "stale"
      ? `  (refs ${status.refsManifestHash?.slice(0, 12)} != compile ${status.compileManifestHash?.slice(0, 12)} — run \`prism refresh\`)`
      : "";
  return [`refs:      ${status.surfaceDir}`, `freshness: ${status.freshness}${detail}`].join("\n");
};

// --- scaffold -----------------------------------------------------------------

const scaffoldWorkflowHeader = (name: string): string => `/**
 * ${name} — scaffolded by \`prism workflow scaffold\`.
 * Lives at ~/.prism/workflows/${name}.workflow.ts by convention — never inside
 * (or git-added to) the project repo it drives; tasks reference their target
 * repo by absolute path, so the file's own location doesn't matter to it.
 * Edit the tasks, then:
 *   prism workflow validate ~/.prism/workflows/${name}.workflow.ts
 *   prism workflow run      ~/.prism/workflows/${name}.workflow.ts
 *
 * Discover harness models: prism workflow models --offer
 * Refresh slugs:           prism workflow refresh-harness-types
 * Authoring skill:         prism workflow skill
 * Model quiz skill:        prism workflow skill --models
 */`;

export interface ScaffoldSourcePin {
  readonly worker: string;
  readonly model?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
}

const renderScaffoldWorker = (pin: ScaffoldSourcePin): string => {
  const fields = [`worker: ${JSON.stringify(pin.worker)}`];
  if (pin.model !== undefined) fields.push(`model: ${JSON.stringify(pin.model)}`);
  if (pin.catalogModel !== undefined) fields.push(`catalogModel: ${JSON.stringify(pin.catalogModel)}`);
  if (pin.effort !== undefined) fields.push(`effort: ${JSON.stringify(pin.effort)}`);
  return `{ ${fields.join(", ")} }`;
};

const renderScaffoldTask = (
  name: string,
  id: string,
  pin: ScaffoldSourcePin,
): string => `      const ${id} = defineTask({
        id: ${JSON.stringify(id)},
        prompt: ${JSON.stringify(`Run under the ${pin.worker} harness and return a one-line summary in "summary". Set worker="${pin.worker}".`)},
        output: Result,
        cacheKey: ${JSON.stringify(`${name}-${pin.worker}-v1`)},
        worker: ${renderScaffoldWorker(pin)},
      });`;

const renderScaffoldRun = (
  name: string,
  pins: readonly [ScaffoldSourcePin, ...ScaffoldSourcePin[]],
): string => {
  const ids = pins.map((_, index) => (index === 0 ? "a" : "b"));
  const tasks = pins.map((pin, index) => renderScaffoldTask(name, ids[index]!, pin)).join("\n");
  if (pins.length === 1) {
    return `export const workflow = defineWorkflow({
  name: "${name}",
  run: (wf) =>
    Effect.gen(function* () {
${tasks}
      const result = yield* wf.runTask(a);
      return { results: [result] };
    }),
});
`;
  }
  return `export const workflow = defineWorkflow({
  name: "${name}",
  run: (wf) =>
    Effect.gen(function* () {
${tasks}
      const results = yield* Effect.all([wf.runTask(a), wf.runTask(b)], { concurrency: "unbounded" });
      return { results };
    }),
});
`;
};

/** A complete, validating starter workflow: harness workers with a prompt and typed IO. */
export const scaffoldWorkflowSource = (
  name: string,
  pins: readonly [ScaffoldSourcePin, ...ScaffoldSourcePin[]] = [
    { worker: "claude-code" },
  ],
): string => {
  const header = `${scaffoldWorkflowHeader(name)}
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const Result = Schema.Struct({
  worker: Schema.String,
  summary: Schema.String,
});
`;
  return `${header}\n${renderScaffoldRun(name, pins)}`;
};

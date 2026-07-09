import { join } from "node:path";
import { parseNamedRef, parseSpaceItemRef } from "@skastr0/prism-sdk/refs";
import type {
  CompileManifest,
  CompileManifestAgent,
  CompileManifestOrbit,
  CompileManifestOrbitPhase,
  CompileManifestOrbitPhaseContract,
  CompileManifestTrait,
  CompileManifestCanonicalTool,
  CompileManifestToolspaceTool,
} from "./compile-manifest.js";
import { projectGeneratedRefsDir } from "../project-key.js";
import type { DesiredRoot } from "../sync/desired.js";

export const WORKFLOW_REFS_HARNESS = "prism-workflows";

/**
 * Generated workflow refs are Prism-owned, never project source. They live
 * machine-global, project-keyed, at
 * ~/.prism/state/projects/<key>/generated/ (toolchain & distribution §5).
 */
export const workflowRefsRoot = (prismHome: string, projectKey: string): string =>
  projectGeneratedRefsDir(prismHome, projectKey);

export const workflowAgentsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "agents.ts");

export const workflowModelsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "models.ts");

export const workflowSkillsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "skills.ts");

export const workflowTraitsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "traits.ts");

export const workflowOrbitsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "orbits.ts");

export const workflowToolsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "tools.ts");

const camelKey = (value: string): string => {
  const parts = value
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0);
  const [first, ...rest] = parts;
  if (!first) return "agent";
  const normalizedFirst = first[0]!.toLowerCase() + first.slice(1);
  return [
    normalizedFirst,
    ...rest.map((part) => part[0]!.toUpperCase() + part.slice(1)),
  ].join("");
};

const pascalKey = (value: string): string => {
  const camel = camelKey(value);
  return camel.length > 0 ? camel[0]!.toUpperCase() + camel.slice(1) : "Agent";
};

export class WorkflowOrbitsEmitError extends Error {
  override readonly name = "WorkflowOrbitsEmitError";
  constructor(message: string) {
    super(message);
  }
}

type JsonSchemaObject = Record<string, unknown>;

export const jsonSchemaToEffectSchemaSource = (
  schema: JsonSchemaObject,
  path: string,
): string => {
  if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
    return `Schema.Literal(${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")})`;
  }

  if (
    schema.type === "object" &&
    typeof schema.properties === "object" &&
    schema.properties !== null
  ) {
    const properties = schema.properties as Record<string, JsonSchemaObject>;
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const fields = Object.keys(properties)
      .sort()
      .map((key) => {
        const child = jsonSchemaToEffectSchemaSource(
          properties[key]!,
          `${path}.${key}`,
        );
        return required.has(key)
          ? `${JSON.stringify(key)}: ${child}`
          : `${JSON.stringify(key)}: Schema.optional(${child})`;
      });
    return `Schema.Struct({ ${fields.join(", ")} })`;
  }

  if (schema.type === "string") {
    return "Schema.String";
  }

  if (schema.type === "number") return "Schema.Number";
  if (schema.type === "boolean") return "Schema.Boolean";

  if (schema.type === "array" && typeof schema.items === "object" && schema.items !== null) {
    return `Schema.Array(${jsonSchemaToEffectSchemaSource(schema.items as JsonSchemaObject, `${path}[]`)})`;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const variants = schema.anyOf as JsonSchemaObject[];
    const nullVariant = variants.find((variant) => variant.type === "null");
    const nonNullVariant = variants.find((variant) => variant.type !== "null");
    if (nullVariant && nonNullVariant) {
      return `Schema.NullOr(${jsonSchemaToEffectSchemaSource(nonNullVariant, path)})`;
    }
  }

  if (
    schema.type === "object" &&
    (schema.properties === undefined ||
      (typeof schema.properties === "object" &&
        schema.properties !== null &&
        Object.keys(schema.properties).length === 0))
  ) {
    return "Schema.Unknown";
  }

  throw new WorkflowOrbitsEmitError(
    `unsupported JSON Schema at ${path}: ${JSON.stringify(schema)}`,
  );
};

const manifestAgentId = (plugin: string, name: string): string => `${plugin}:${name}`;

const agentRefExpression = (options: {
  readonly manifest: CompileManifest;
  readonly plugin: string;
  readonly name: string;
  readonly context: string;
}): string => {
  const manifestId = manifestAgentId(options.plugin, options.name);
  if (!options.manifest.agents[manifestId]) {
    throw new WorkflowOrbitsEmitError(
      `phase agent ${manifestId} is missing from the emitted agents module (${options.context})`,
    );
  }
  return `agents.${camelKey(options.plugin)}.${camelKey(options.name)}`;
};

const renderPhaseContract = (
  contract: CompileManifestOrbitPhaseContract,
  context: string,
): string => {
  const sides: string[] = [];
  if (contract.input) {
    sides.push(
      `input: ${jsonSchemaToEffectSchemaSource(contract.input as JsonSchemaObject, `${context}.contract.input`)}`,
    );
  }
  if (contract.output) {
    sides.push(
      `output: ${jsonSchemaToEffectSchemaSource(contract.output as JsonSchemaObject, `${context}.contract.output`)}`,
    );
  }
  return sides.length > 0 ? `,\n      contract: { ${sides.join(", ")} }` : "";
};

const renderPhaseAgents = (options: {
  readonly manifest: CompileManifest;
  readonly orbit: CompileManifestOrbit;
  readonly phase: CompileManifestOrbitPhase;
}): string => {
  const context = `${options.orbit.plugin}:${options.orbit.name} phase ${options.phase.name}`;
  const entries = options.phase.agents.map((agent) => {
    const slotKey = camelKey(agent.name);
    const ref = agentRefExpression({
      manifest: options.manifest,
      plugin: agent.plugin,
      name: agent.name,
      context,
    });
    return `        ${JSON.stringify(slotKey)}: ${ref}`;
  });
  return entries.length > 0 ? entries.join(",\n") : "";
};

const renderPhase = (options: {
  readonly manifest: CompileManifest;
  readonly orbit: CompileManifestOrbit;
  readonly phase: CompileManifestOrbitPhase;
}): string => {
  const phaseKey = camelKey(options.phase.name);
  const context = `${options.orbit.plugin}:${options.orbit.name}.${phaseKey}`;
  const notes =
    options.phase.notes && Object.keys(options.phase.notes).length > 0
      ? `,\n      notes: ${JSON.stringify(options.phase.notes)}`
      : "";
  const contract = options.phase.contract
    ? renderPhaseContract(options.phase.contract, context)
    : "";
  const agentsBlock = renderPhaseAgents(options);
  return `      ${JSON.stringify(phaseKey)}: {
        name: ${JSON.stringify(options.phase.name)},
        orbit: ${JSON.stringify(options.orbit.name)},
        plugin: ${JSON.stringify(options.orbit.plugin)},
        agents: {
${agentsBlock}
        },
        criteria: ${JSON.stringify(options.phase.criteria)},
        io: ${JSON.stringify(options.phase.io)},
        framing: ${JSON.stringify(options.phase.framing)}${notes}${contract}
      }`;
};

const renderOrbit = (options: {
  readonly manifest: CompileManifest;
  readonly orbit: CompileManifestOrbit;
}): string => {
  const orbitKey = camelKey(options.orbit.name);
  const sequence = options.orbit.phases.map((phase) => camelKey(phase.name));
  const phaseBlocks = options.orbit.phases
    .map((phase) =>
      renderPhase({
        manifest: options.manifest,
        orbit: options.orbit,
        phase,
      }),
    )
    .join(",\n");
  return `    ${JSON.stringify(orbitKey)}: {
      plugin: ${JSON.stringify(options.orbit.plugin)},
      name: ${JSON.stringify(options.orbit.name)},
      sequence: ${JSON.stringify(sequence)} as const,
      phases: {
${phaseBlocks}
      }
    }`;
};

const phaseAgentTypeAlias = (options: {
  readonly plugin: string;
  readonly orbitName: string;
  readonly phaseName: string;
}): string => {
  const pluginKey = camelKey(options.plugin);
  const orbitKey = camelKey(options.orbitName);
  const phaseKey = camelKey(options.phaseName);
  const alias = `${pascalKey(options.plugin)}${pascalKey(options.orbitName)}${pascalKey(options.phaseName)}Agent`;
  return `export type ${alias} = typeof orbits.${pluginKey}.${orbitKey}.phases.${phaseKey}.agents[keyof typeof orbits.${pluginKey}.${orbitKey}.phases.${phaseKey}.agents];`;
};

const collectManifestOrbits = (manifest: CompileManifest): CompileManifestOrbit[] =>
  Object.values(manifest.orbits ?? {}).sort((left, right) =>
    left.plugin === right.plugin
      ? left.name.localeCompare(right.name)
      : left.plugin.localeCompare(right.plugin),
  );

const sortStrings = (values: Iterable<string>): string[] => [...values].sort();

type EmittedModelProfileRef = {
  readonly kind: "model-profile-ref";
  readonly plugin: string;
  readonly modelspace: string;
  readonly profile: string;
  readonly targets: Readonly<Record<string, Record<string, unknown>>>;
};

type EmittedManagedSkillRef = {
  readonly kind: "managed-skill-ref";
  readonly plugin: string;
  readonly name: string;
};

type EmittedSkillspaceRef = {
  readonly kind: "skillspace-ref";
  readonly plugin: string;
  readonly skillspace: string;
  readonly skills: readonly string[];
};

type EmittedTraitRef = {
  readonly kind: "trait-ref";
  readonly id: string;
  readonly ref: string;
};

type EmittedCanonicalToolRef = {
  readonly kind: "canonical-tool-ref";
  readonly plugin: string;
  readonly name: string;
};

type EmittedToolspaceToolRef = {
  readonly kind: "toolspace-tool-ref";
  readonly plugin: string;
  readonly toolspace: string;
  readonly name: string;
};

type EmittedToolGroupValue = EmittedCanonicalToolRef | Record<string, EmittedToolspaceToolRef>;

type UsedToolEntry = CompileManifestCanonicalTool | CompileManifestToolspaceTool;

const toolSortKey = (entry: UsedToolEntry): string =>
  "toolspace" in entry && entry.toolspace !== undefined
    ? `${entry.toolspace}/${entry.name}`
    : entry.name;

const pluginNames = (manifest: CompileManifest): string[] =>
  [...new Set(Object.values(manifest.agents).map((agent) => agent.plugin))].sort();

const pluginAgents = (
  manifest: CompileManifest,
  pluginName: string,
): CompileManifestAgent[] =>
  Object.values(manifest.agents)
    .filter((agent) => agent.plugin === pluginName)
    .sort((left, right) => left.name.localeCompare(right.name));

const collectUsedModelProfiles = (
  manifest: CompileManifest,
): Array<{ plugin: string; modelspace: string; profile: string; targets: Readonly<Record<string, Record<string, unknown>>> }> => {
  const entries: Array<{ plugin: string; modelspace: string; profile: string; targets: Record<string, Record<string, unknown>> }> = [];
  const seen = new Set<string>();
  const targetsByKey = new Map<string, Record<string, Record<string, unknown>>>();

  for (const agent of Object.values(manifest.agents)) {
    const mb = agent.composed.modelBindings;
    if (!mb.modelspace || !mb.profile) continue;
    let p = agent.plugin;
    let ms = mb.modelspace;
    const colon = mb.modelspace.indexOf(":");
    if (colon !== -1) {
      p = mb.modelspace.slice(0, colon);
      ms = mb.modelspace.slice(colon + 1);
    }
    const key = `${p}:${ms}:${mb.profile}`;
    const targets = targetsByKey.get(key) ?? {};
    for (const [harness, slice] of Object.entries(agent.composed.perTarget)) {
      if (slice.model !== null) targets[harness] = slice.model;
    }
    targetsByKey.set(key, targets);
  }

  const msRec = manifest.modelspaces;
  if (msRec && Object.keys(msRec).length > 0) {
    for (const entry of Object.values(msRec)) {
      for (const profile of entry.profiles ?? []) {
        const k = `${entry.plugin}:${entry.modelspace}:${profile}`;
        if (!seen.has(k)) {
          seen.add(k);
          const msKey = `${entry.plugin}:${entry.modelspace}`;
          const msEntry = manifest.modelspaces[msKey];
          const targets = msEntry?.profilesData?.[profile] ?? targetsByKey.get(k) ?? {};
          entries.push({
            plugin: entry.plugin,
            modelspace: entry.modelspace,
            profile,
            targets,
          });
        }
      }
    }
  } else {
    // Fallback: derive from agent bindings (manifest is source of truth either way)
    for (const agent of Object.values(manifest.agents)) {
      const mb = agent.composed.modelBindings;
      if (mb.modelspace && mb.profile) {
        let p = agent.plugin;
        let ms = mb.modelspace;
        const colon = mb.modelspace.indexOf(":");
        if (colon !== -1) {
          p = mb.modelspace.slice(0, colon);
          ms = mb.modelspace.slice(colon + 1);
        }
        const k = `${p}:${ms}:${mb.profile}`;
        if (!seen.has(k)) {
          seen.add(k);
          entries.push({ plugin: p, modelspace: ms, profile: mb.profile, targets: targetsByKey.get(k) ?? {} });
        }
      }
    }
  }

  return entries.sort((a, b) =>
    a.plugin === b.plugin
      ? a.modelspace === b.modelspace
        ? a.profile.localeCompare(b.profile)
        : a.modelspace.localeCompare(b.modelspace)
      : a.plugin.localeCompare(b.plugin),
  );
};

const collectUsedSkills = (
  manifest: CompileManifest,
): Array<{ plugin: string; name?: string; skillspace?: string; skills?: readonly string[] }> => {
  const entries: Array<{ plugin: string; name?: string; skillspace?: string; skills?: readonly string[] }> = [];
  const seen = new Set<string>();

  const skRec = manifest.skills;
  if (skRec && Object.keys(skRec).length > 0) {
    for (const entry of Object.values(skRec)) {
      const k = "skillspace" in entry && entry.skillspace !== undefined
        ? `${entry.plugin}:${entry.skillspace}`
        : `${entry.plugin}:${(entry as { readonly name?: string }).name ?? ""}`;
      if (!seen.has(k)) {
        seen.add(k);
        entries.push({ ...entry });
      }
    }
  } else {
    // Fallback: derive from agent skill strings (manifest is source of truth either way)
    const skillAccum: Record<
      string,
      { plugin: string; name?: string; skillspace?: string; skills?: Set<string> }
    > = {};
    for (const agent of Object.values(manifest.agents)) {
      const allRefs = new Set<string>([
        ...agent.skills,
        ...agent.composed.grants.skills,
        ...Object.values(agent.composed.perTarget).flatMap((slice) => slice.allowedSkills),
      ]);
      for (const ref of allRefs) {
        const named = parseNamedRef(ref);
        const space = parseSpaceItemRef(ref, "/");
        let owner = named.pluginPrefix ?? agent.plugin;
        let key: string;
        if (space) {
          owner = space.pluginPrefix ?? agent.plugin;
          key = `${owner}:${space.space}`;
          if (!skillAccum[key]) {
            skillAccum[key] = { plugin: owner, skillspace: space.space, skills: new Set() };
          }
          skillAccum[key]!.skills!.add(space.name);
        } else {
          key = `${owner}:${named.name}`;
          if (!skillAccum[key]) {
            skillAccum[key] = { plugin: owner, name: named.name };
          }
        }
      }
    }
    for (const [_key, acc] of Object.entries(skillAccum)) {
      let item: { plugin: string; name?: string; skillspace?: string; skills?: readonly string[] };
      if (acc.skillspace) {
        item = {
          plugin: acc.plugin,
          skillspace: acc.skillspace,
          skills: sortStrings(acc.skills!),
        };
      } else if (acc.name) {
        item = { plugin: acc.plugin, name: acc.name };
      } else {
        continue;
      }
      entries.push(item);
    }
  }

  return entries.sort((a, b) =>
    a.plugin === b.plugin
      ? (a.skillspace ?? a.name ?? "") === (b.skillspace ?? b.name ?? "")
        ? 0
        : (a.skillspace ?? a.name ?? "").localeCompare(b.skillspace ?? b.name ?? "")
      : a.plugin.localeCompare(b.plugin),
  );
};

const collectUsedTraits = (
  manifest: CompileManifest,
): CompileManifestTrait[] => {
  const entries: CompileManifestTrait[] = [];
  const seen = new Set<string>();

  const trRec = manifest.traits;
  if (trRec && Object.keys(trRec).length > 0) {
    for (const entry of Object.values(trRec)) {
      const k = entry.id;
      if (!seen.has(k)) {
        seen.add(k);
        entries.push({ id: entry.id, ref: entry.ref });
      }
    }
  } else {
    // Fallback: derive from agent.traits (manifest is source of truth either way)
    for (const agent of Object.values(manifest.agents)) {
      for (const t of agent.traits) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          entries.push({ id: t.id, ref: t.ref });
        }
      }
    }
  }

  return entries.sort((a, b) =>
    a.id === b.id
      ? (a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1)
      : a.id < b.id ? -1 : 1,
  );
};

const agentInstalls = (agent: CompileManifestAgent): string[] =>
  Object.keys(agent.composed.perTarget).sort();

const renderAgentRef = (options: {
  readonly agent: CompileManifestAgent;
}): string => {
  const modelBindings = options.agent.composed.modelBindings;
  let modelTargets: Record<string, Record<string, unknown>> = {};
  if (modelBindings.modelspace && modelBindings.profile) {
    for (const [harness, slice] of Object.entries(options.agent.composed.perTarget)) {
      if (slice.model !== null) modelTargets[harness] = slice.model;
    }
  }
  const model =
    modelBindings.modelspace || modelBindings.profile
      ? `,
      model: ${JSON.stringify({ ...modelBindings, targets: modelTargets })}`
      : "";

  return `{
      kind: "agent-ref",
      plugin: ${JSON.stringify(options.agent.plugin)},
      name: ${JSON.stringify(options.agent.name)},
      description: ${JSON.stringify(options.agent.description)},
      sourceHash: ${JSON.stringify(options.agent.sourceHash)},
      manifestHash: ${JSON.stringify(options.agent.manifestHash)}${model},
      installs: ${JSON.stringify(agentInstalls(options.agent))}
    }`;
};

const renderAgentsNamespace = (options: {
  readonly manifest: CompileManifest;
  readonly pluginName: string;
}): string => {
  const entries = pluginAgents(options.manifest, options.pluginName).map((agent) =>
    `    ${JSON.stringify(camelKey(agent.name))}: ${renderAgentRef({ agent })}`,
  );
  return entries.length > 0 ? entries.join(",\n") : "";
};

export const renderWorkflowAgentsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const namespaces = pluginNames(options.manifest).map((pluginName) => {
    const pluginKey = camelKey(pluginName);
    const body = renderAgentsNamespace({
      manifest: options.manifest,
      pluginName,
    });
    return `  ${JSON.stringify(pluginKey)}: {
${body}
  }`;
  });

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

export interface WorkflowModelRef {
  readonly modelspace?: string;
  readonly profile?: string;
  readonly targets?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface WorkflowAgentRef {
  readonly kind: "agent-ref";
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly model?: WorkflowModelRef;
  readonly installs: ReadonlyArray<string>;
}

export const agents = {
${namespaces.join(",\n")}
} as const satisfies Record<string, Record<string, WorkflowAgentRef>>;
`;
};

export const renderWorkflowModelsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const profiles = collectUsedModelProfiles(options.manifest);

  const byPlugin: Record<string, Record<string, Record<string, EmittedModelProfileRef>>> = {};
  for (const { plugin, modelspace, profile, targets } of profiles) {
    const pk = camelKey(plugin);
    const msk = camelKey(modelspace);
    const profk = camelKey(profile);
    if (!byPlugin[pk]) byPlugin[pk] = {};
    if (!byPlugin[pk][msk]) byPlugin[pk][msk] = {};
    byPlugin[pk][msk][profk] = {
      kind: "model-profile-ref",
      plugin,
      modelspace,
      profile,
      targets,
    };
  }

  const pluginBlocks = Object.keys(byPlugin)
    .sort()
    .map((pk) => {
      const msGroup = byPlugin[pk]!;
      const msBlocks = Object.keys(msGroup)
        .sort()
        .map((msk) => {
          const profGroup = msGroup[msk]!;
          const profLines = Object.keys(profGroup)
            .sort()
            .map((profk) => {
              const ref = profGroup[profk];
              return `      ${JSON.stringify(profk)}: ${JSON.stringify(ref)}`;
            })
            .join(",\n");
          return `    ${JSON.stringify(msk)}: {\n${profLines}\n    }`;
        })
        .join(",\n");
      return `  ${JSON.stringify(pk)}: {\n${msBlocks}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

export interface WorkflowModelspaceRef {
  readonly kind: "modelspace-ref";
  readonly plugin: string;
  readonly modelspace: string;
}

export interface WorkflowModelProfileRef {
  readonly kind: "model-profile-ref";
  readonly plugin: string;
  readonly modelspace: string;
  readonly profile: string;
  readonly targets: Readonly<Record<string, Record<string, unknown>>>;
}

export const models = {
${body}
} as const satisfies Record<string, Record<string, Record<string, WorkflowModelProfileRef>>>;
`;
};

export const renderWorkflowSkillsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const used = collectUsedSkills(options.manifest);

  const byPlugin: Record<string, Record<string, EmittedManagedSkillRef | EmittedSkillspaceRef>> = {};
  for (const entry of used) {
    const pk = camelKey(entry.plugin);
    if (!byPlugin[pk]) byPlugin[pk] = {};
    if (entry.skillspace) {
      const sk = camelKey(entry.skillspace);
      byPlugin[pk][sk] = {
        kind: "skillspace-ref",
        plugin: entry.plugin,
        skillspace: entry.skillspace,
        skills: entry.skills ?? [],
      };
    } else if (entry.name) {
      const nk = camelKey(entry.name);
      byPlugin[pk][nk] = {
        kind: "managed-skill-ref",
        plugin: entry.plugin,
        name: entry.name,
      };
    }
  }

  const pluginBlocks = Object.keys(byPlugin)
    .sort()
    .map((pk) => {
      const group = byPlugin[pk]!;
      const lines = Object.keys(group)
        .sort()
        .map((k) => {
          const ref = group[k];
          return `    ${JSON.stringify(k)}: ${JSON.stringify(ref)}`;
        })
        .join(",\n");
      return `  ${JSON.stringify(pk)}: {\n${lines}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

export interface WorkflowManagedSkillRef {
  readonly kind: "managed-skill-ref";
  readonly plugin: string;
  readonly name: string;
}

export interface WorkflowSkillspaceRef {
  readonly kind: "skillspace-ref";
  readonly plugin: string;
  readonly skillspace: string;
  readonly skills: ReadonlyArray<string>;
}

export const skills = {
${body}
} as const satisfies Record<string, Record<string, WorkflowManagedSkillRef | WorkflowSkillspaceRef>>;
`;
};

export const renderWorkflowTraitsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const used = collectUsedTraits(options.manifest);

  const byPlugin: Record<string, Record<string, EmittedTraitRef>> = {};
  for (const entry of used) {
    // group by owner plugin from id prefix (e.g. "forge:foo" -> "forge")
    const colon = entry.id.indexOf(":");
    const owner = colon !== -1 ? entry.id.slice(0, colon) : entry.id;
    const local = colon !== -1 ? entry.id.slice(colon + 1) : entry.id;
    const pk = camelKey(owner);
    if (!byPlugin[pk]) byPlugin[pk] = {};
    const lk = camelKey(local);
    byPlugin[pk][lk] = {
      kind: "trait-ref",
      id: entry.id,
      ref: entry.ref,
    };
  }

  const pluginBlocks = Object.keys(byPlugin)
    .sort()
    .map((pk) => {
      const group = byPlugin[pk]!;
      const lines = Object.keys(group)
        .sort()
        .map((k) => {
          const ref = group[k];
          return `    ${JSON.stringify(k)}: ${JSON.stringify(ref)}`;
        })
        .join(",\n");
      return `  ${JSON.stringify(pk)}: {\n${lines}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

export interface WorkflowTraitRef {
  readonly kind: "trait-ref";
  readonly id: string;
  readonly ref: string;
}

export const traits = {
${body}
} as const satisfies Record<string, Record<string, WorkflowTraitRef>>;
`;
};

const collectUsedTools = (
  manifest: CompileManifest,
): UsedToolEntry[] => {
  const entries: UsedToolEntry[] = [];
  const seen = new Set<string>();

  const tRec = manifest.tools;
  if (tRec && Object.keys(tRec).length > 0) {
    for (const entry of Object.values(tRec)) {
      const k = "toolspace" in entry && entry.toolspace !== undefined
        ? `${entry.plugin}:${entry.toolspace}/${entry.name}`
        : `${entry.plugin}:${entry.name}`;
      if (!seen.has(k)) {
        seen.add(k);
        entries.push(entry);
      }
    }
  } else {
    // Fallback: derive from agent grants.tools + perTarget.toolGrants (manifest source of truth)
    const toolAccum: Record<
      string,
      { plugin: string; name?: string; toolspace?: string }
    > = {};
    for (const agent of Object.values(manifest.agents)) {
      const allRefs = new Set<string>([
        ...agent.composed.grants.tools,
        ...Object.values(agent.composed.perTarget).flatMap((slice) => slice.toolGrants),
      ]);
      for (const ref of allRefs) {
        const named = parseNamedRef(ref);
        const space = parseSpaceItemRef(ref, "/");
        let owner = named.pluginPrefix ?? agent.plugin;
        if (space) {
          owner = space.pluginPrefix ?? agent.plugin;
          const key = `${owner}:${space.space}/${space.name}`;
          if (!toolAccum[key]) {
            toolAccum[key] = { plugin: owner, toolspace: space.space, name: space.name };
          }
        } else {
          const key = `${owner}:${named.name}`;
          if (!toolAccum[key]) {
            toolAccum[key] = { plugin: owner, name: named.name };
          }
        }
      }
    }
    for (const [_key, acc] of Object.entries(toolAccum)) {
      if (acc.toolspace && acc.name) {
        entries.push({ plugin: acc.plugin, toolspace: acc.toolspace, name: acc.name });
      } else if (acc.name) {
        entries.push({ plugin: acc.plugin, name: acc.name });
      }
    }
  }

  return entries.sort((a, b) =>
    a.plugin === b.plugin
      ? toolSortKey(a) === toolSortKey(b)
        ? 0
        : toolSortKey(a).localeCompare(toolSortKey(b))
      : a.plugin.localeCompare(b.plugin),
  );
};

export const renderWorkflowOrbitsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const orbits = collectManifestOrbits(options.manifest);
  const byPlugin = new Map<string, CompileManifestOrbit[]>();
  for (const orbit of orbits) {
    const pluginKey = camelKey(orbit.plugin);
    const group = byPlugin.get(pluginKey) ?? [];
    group.push(orbit);
    byPlugin.set(pluginKey, group);
  }

  const pluginBlocks = [...byPlugin.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginKey, pluginOrbits]) => {
      const orbitBlocks = pluginOrbits
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((orbit) =>
          renderOrbit({
            manifest: options.manifest,
            orbit,
          }),
        )
        .join(",\n");
      return `  ${JSON.stringify(pluginKey)}: {\n${orbitBlocks}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";
  const typeAliases = orbits
    .flatMap((orbit) =>
      orbit.phases
        .filter((phase) => phase.agents.length > 0)
        .map((phase) =>
          phaseAgentTypeAlias({
            plugin: orbit.plugin,
            orbitName: orbit.name,
            phaseName: phase.name,
          }),
        ),
    )
    .join("\n");

  const typeAliasBlock = typeAliases.length > 0 ? `\n${typeAliases}\n` : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

import { Schema } from "effect";
import { agents, type WorkflowAgentRef } from "./agents.ts";

export interface WorkflowOrbitPhaseIo {
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
}

export interface WorkflowOrbitPhaseFraming {
  readonly telos?: string;
  readonly when?: string;
  readonly coordination?: string;
  readonly escalation?: string;
}

export interface WorkflowOrbitPhaseContract {
  readonly input?: Schema.Schema.Any;
  readonly output?: Schema.Schema.Any;
}

export interface WorkflowOrbitPhase {
  readonly name: string;
  readonly orbit: string;
  readonly plugin: string;
  readonly agents: Readonly<Record<string, WorkflowAgentRef>>;
  readonly criteria: ReadonlyArray<string>;
  readonly io: WorkflowOrbitPhaseIo;
  readonly framing: WorkflowOrbitPhaseFraming;
  readonly notes?: Readonly<Record<string, string>>;
  readonly contract?: WorkflowOrbitPhaseContract;
}

export interface WorkflowOrbit {
  readonly plugin: string;
  readonly name: string;
  readonly sequence: ReadonlyArray<string>;
  readonly phases: Readonly<Record<string, WorkflowOrbitPhase>>;
}

export const orbits = {
${body}
} as const satisfies Record<string, Record<string, WorkflowOrbit>>;
${typeAliasBlock}`;
};

export const renderWorkflowToolsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const used = collectUsedTools(options.manifest);

  const byPlugin: Record<string, Record<string, EmittedToolGroupValue>> = {};
  for (const entry of used) {
    const pk = camelKey(entry.plugin);
    if (!byPlugin[pk]) byPlugin[pk] = {};
    if ("toolspace" in entry && entry.toolspace !== undefined) {
      const tsk = camelKey(entry.toolspace);
      const toolspaceGroup = byPlugin[pk][tsk];
      const nested: Record<string, EmittedToolspaceToolRef> =
        toolspaceGroup && !("kind" in toolspaceGroup)
          ? toolspaceGroup
          : {};
      if (!toolspaceGroup || "kind" in toolspaceGroup) {
        byPlugin[pk][tsk] = nested;
      }
      const nk = camelKey(entry.name);
      nested[nk] = {
        kind: "toolspace-tool-ref",
        plugin: entry.plugin,
        toolspace: entry.toolspace,
        name: entry.name,
      };
    } else {
      const nk = camelKey(entry.name);
      byPlugin[pk][nk] = {
        kind: "canonical-tool-ref",
        plugin: entry.plugin,
        name: entry.name,
      };
    }
  }

  const pluginBlocks = Object.keys(byPlugin)
    .sort()
    .map((pk) => {
      const group = byPlugin[pk]!;
      const lines = Object.keys(group)
        .sort()
        .map((k) => {
          const val = group[k];
          if (val && typeof val === "object" && !("kind" in val)) {
            // toolspace sub-namespace: 3-level nesting
            const innerLines = Object.keys(val)
              .sort()
              .map((nk) => `      ${JSON.stringify(nk)}: ${JSON.stringify(val[nk])}`)
              .join(",\n");
            return `    ${JSON.stringify(k)}: {\n${innerLines}\n    }`;
          } else {
            return `    ${JSON.stringify(k)}: ${JSON.stringify(val)}`;
          }
        })
        .join(",\n");
      return `  ${JSON.stringify(pk)}: {\n${lines}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

export interface WorkflowCanonicalToolRef {
  readonly kind: "canonical-tool-ref";
  readonly plugin: string;
  readonly name: string;
}

export interface WorkflowToolspaceToolRef {
  readonly kind: "toolspace-tool-ref";
  readonly plugin: string;
  readonly toolspace: string;
  readonly name: string;
}

export const tools = {
${body}
} as const satisfies Record<string, Record<string, WorkflowCanonicalToolRef | Record<string, WorkflowToolspaceToolRef>>>;
`;
};

export const planWorkflowRefsEmit = (options: {
  readonly prismHome: string;
  readonly projectKey: string;
  readonly manifest: CompileManifest;
}): DesiredRoot => {
  const root = workflowRefsRoot(options.prismHome, options.projectKey);
  return {
    harness: WORKFLOW_REFS_HARNESS,
    root,
    files: [
      {
        targetPath: workflowAgentsPath(options.prismHome, options.projectKey),
        content: renderWorkflowAgentsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowModelsPath(options.prismHome, options.projectKey),
        content: renderWorkflowModelsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowSkillsPath(options.prismHome, options.projectKey),
        content: renderWorkflowSkillsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowTraitsPath(options.prismHome, options.projectKey),
        content: renderWorkflowTraitsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowOrbitsPath(options.prismHome, options.projectKey),
        content: renderWorkflowOrbitsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowToolsPath(options.prismHome, options.projectKey),
        content: renderWorkflowToolsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
    ],
    regions: [],
  };
};

import { join } from "node:path";
import type {
  CompileManifest,
  CompileManifestSop,
  CompileManifestSopPhase,
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

export const workflowModelsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "models.ts");

export const workflowSopsPath = (prismHome: string, projectKey: string): string =>
  join(workflowRefsRoot(prismHome, projectKey), "sops.ts");

const camelKey = (value: string): string => {
  const parts = value
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0);
  const [first, ...rest] = parts;
  if (!first) return "item";
  const normalizedFirst = first[0]!.toLowerCase() + first.slice(1);
  return [
    normalizedFirst,
    ...rest.map((part) => part[0]!.toUpperCase() + part.slice(1)),
  ].join("");
};

export class WorkflowRefsEmitError extends Error {
  override readonly name = "WorkflowRefsEmitError";
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

  throw new WorkflowRefsEmitError(
    `unsupported JSON Schema at ${path}: ${JSON.stringify(schema)}`,
  );
};

const sortStrings = (values: Iterable<string>): string[] => [...values].sort();

type EmittedModelProfileRef = {
  readonly kind: "model-profile-ref";
  readonly plugin: string;
  readonly modelspace: string;
  readonly profile: string;
  readonly targets: Readonly<Record<string, Record<string, unknown>>>;
};

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

const collectManifestSops = (manifest: CompileManifest): CompileManifestSop[] =>
  Object.values(manifest.sops ?? {}).sort((left, right) =>
    left.plugin === right.plugin
      ? left.name.localeCompare(right.name)
      : left.plugin.localeCompare(right.plugin),
  );

const renderSopPhaseContractSides = (
  phase: CompileManifestSopPhase,
  context: string,
): string => {
  const sides: string[] = [];
  if (phase.input) {
    sides.push(
      `        input: ${jsonSchemaToEffectSchemaSource(phase.input as JsonSchemaObject, `${context}.input`)},`,
    );
  }
  if (phase.output) {
    sides.push(
      `        output: ${jsonSchemaToEffectSchemaSource(phase.output as JsonSchemaObject, `${context}.output`)},`,
    );
  }
  return sides.length > 0 ? `\n${sides.join("\n")}` : "";
};

const renderSopPhaseFraming = (
  phase: CompileManifestSopPhase,
): string => {
  const lines: string[] = [];
  if (phase.purpose.length > 0) lines.push(`          purpose: ${JSON.stringify(phase.purpose)},`);
  if (phase.escalation !== undefined) lines.push(`          escalation: ${JSON.stringify(phase.escalation)},`);
  if (lines.length === 0) return "";
  return `\n        framing: {\n${lines.join("\n")}\n        },`;
};

const renderSopPhase = (options: {
  readonly sop: CompileManifestSop;
  readonly phase: CompileManifestSopPhase;
}): string => {
  const phaseKey = camelKey(options.phase.name);
  const context = `${options.sop.plugin}:${options.sop.name}.${phaseKey}`;
  const criteria = options.phase.acceptanceCriteria.length > 0
    ? `\n        criteria: ${JSON.stringify(options.phase.acceptanceCriteria)},`
    : "";
  return `      ${JSON.stringify(phaseKey)}: {
        name: ${JSON.stringify(options.phase.name)},
        sop: ${JSON.stringify(options.sop.name)},
        plugin: ${JSON.stringify(options.sop.plugin)},${renderSopPhaseContractSides(options.phase, context)}${criteria}${renderSopPhaseFraming(options.phase)}
      }`;
};

const renderSop = (sop: CompileManifestSop): string => {
  const sopKey = camelKey(sop.name);
  const phaseBlocks = sop.phases
    .map((phase) => renderSopPhase({ sop, phase }))
    .join(",\n");
  return `    ${JSON.stringify(sopKey)}: {
      plugin: ${JSON.stringify(sop.plugin)},
      name: ${JSON.stringify(sop.name)},
      phases: {
${phaseBlocks}
      }
    }`;
};

/**
 * Generated SOP refs module. Phases carry live Effect Schema values for typed
 * input/output contracts; there are no agent cross-imports because a SOP never
 * names an executor.
 */
export const renderWorkflowSopsModule = (options: {
  readonly manifest: CompileManifest;
}): string => {
  const sops = collectManifestSops(options.manifest);
  const byPlugin = new Map<string, CompileManifestSop[]>();
  for (const sop of sops) {
    const pluginKey = camelKey(sop.plugin);
    const group = byPlugin.get(pluginKey) ?? [];
    group.push(sop);
    byPlugin.set(pluginKey, group);
  }

  const pluginBlocks = [...byPlugin.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginKey, pluginSops]) => {
      const sopBlocks = pluginSops
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((sop) => renderSop(sop))
        .join(",\n");
      return `  ${JSON.stringify(pluginKey)}: {\n${sopBlocks}\n  }`;
    });

  const body = pluginBlocks.length > 0 ? pluginBlocks.join(",\n") : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: compile manifest ${options.manifest.manifestHash}
 */

import { Schema } from "effect";

export interface WorkflowSopPhaseFraming {
  readonly purpose?: string;
  readonly when?: string;
  readonly escalation?: string;
}

export interface WorkflowSopPhase {
  readonly name: string;
  readonly sop: string;
  readonly plugin: string;
  readonly input?: Schema.Schema.AnyNoContext;
  readonly output?: Schema.Schema.AnyNoContext;
  readonly criteria?: ReadonlyArray<string>;
  readonly framing?: WorkflowSopPhaseFraming;
}

export interface WorkflowSop {
  readonly plugin: string;
  readonly name: string;
  readonly phases: Readonly<Record<string, WorkflowSopPhase>>;
}

export const sops = {
${body}
} as const satisfies Record<string, Record<string, WorkflowSop>>;
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
        targetPath: workflowModelsPath(options.prismHome, options.projectKey),
        content: renderWorkflowModelsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowSopsPath(options.prismHome, options.projectKey),
        content: renderWorkflowSopsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
    ],
    regions: [],
  };
};

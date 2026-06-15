import { join } from "node:path";
import { parseNamedRef, parseSpaceItemRef } from "@skastr0/prism-core/refs";
import type { CompileManifest, CompileManifestAgent, CompileManifestTrait } from "./compile-manifest.js";
import type { DesiredRoot } from "../sync/desired.js";

export const WORKFLOW_REFS_HARNESS = "prism-workflows";

export const workflowRefsRoot = (projectPath: string): string => join(projectPath, ".prism");

export const workflowAgentsPath = (projectPath: string): string =>
  join(workflowRefsRoot(projectPath), "generated", "workflows", "agents.ts");

export const workflowModelsPath = (projectPath: string): string =>
  join(workflowRefsRoot(projectPath), "generated", "workflows", "models.ts");

export const workflowSkillsPath = (projectPath: string): string =>
  join(workflowRefsRoot(projectPath), "generated", "workflows", "skills.ts");

export const workflowTraitsPath = (projectPath: string): string =>
  join(workflowRefsRoot(projectPath), "generated", "workflows", "traits.ts");

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

const sortStrings = (values: Iterable<string>): string[] => [...values].sort();

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
): Array<{ plugin: string; modelspace: string; profile: string }> => {
  const entries: Array<{ plugin: string; modelspace: string; profile: string }> = [];
  const seen = new Set<string>();

  const msRec = manifest.modelspaces;
  if (msRec && Object.keys(msRec).length > 0) {
    for (const entry of Object.values(msRec)) {
      for (const profile of entry.profiles ?? []) {
        const k = `${entry.plugin}:${entry.modelspace}:${profile}`;
        if (!seen.has(k)) {
          seen.add(k);
          entries.push({ plugin: entry.plugin, modelspace: entry.modelspace, profile });
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
          entries.push({ plugin: p, modelspace: ms, profile: mb.profile });
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
  const model =
    modelBindings.modelspace || modelBindings.profile
      ? `,
      model: ${JSON.stringify(modelBindings)}`
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

  const byPlugin: Record<string, Record<string, Record<string, any>>> = {};
  for (const { plugin, modelspace, profile } of profiles) {
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

  const byPlugin: Record<string, Record<string, any>> = {};
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

  const byPlugin: Record<string, Record<string, any>> = {};
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

export const planWorkflowRefsEmit = (options: {
  readonly projectPath: string;
  readonly manifest: CompileManifest;
}): DesiredRoot => {
  const root = workflowRefsRoot(options.projectPath);
  return {
    harness: WORKFLOW_REFS_HARNESS,
    root,
    files: [
      {
        targetPath: workflowAgentsPath(options.projectPath),
        content: renderWorkflowAgentsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowModelsPath(options.projectPath),
        content: renderWorkflowModelsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowSkillsPath(options.projectPath),
        content: renderWorkflowSkillsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
      {
        targetPath: workflowTraitsPath(options.projectPath),
        content: renderWorkflowTraitsModule({
          manifest: options.manifest,
        }),
        plugin: WORKFLOW_REFS_HARNESS,
      },
    ],
    regions: [],
  };
};

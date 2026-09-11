import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  computeAgentManifestHash,
  computeCompileManifestHash,
  decodeCompileManifest,
  emptyCompileManifest,
  encodeCompileManifest,
  HarnessIdSchema,
  verifyAgentManifestHash,
  verifyCompileManifestHash,
  type CompileManifest,
  type CompileManifestAgent,
  type CompileManifestManagedSkill,
  type CompileManifestModelspace,
  type CompileManifestSkillspace,
  type CompileManifestSop,
  type CompileManifestCanonicalTool,
  type HarnessId,
  type HarnessScope,
} from "@skastr0/prism-sdk/compile-manifest";
import { parseNamedRef, parseSpaceItemRef } from "@skastr0/prism-sdk/refs";
import { stableJsonHash, type StableJsonValue } from "@skastr0/prism-sdk/stable-json";
import { ensureDir, exists, readFile, writeFile } from "../fs.js";
import { projectCompileManifestPath } from "../project-key.js";
import { withSnapshotLock } from "../state/lock.js";
import type { AgentCacheDescriptor, CacheInputFile } from "./cache.js";
import type { ComposedAgent } from "./compose.js";
import { collectPluginRegistries, type PluginRegistry } from "./registry.js";

export * from "@skastr0/prism-sdk/compile-manifest";

/**
 * The per-project compile manifest partition
 * (~/.prism/state/projects/<key>/compile-manifest.json). The project key
 * dimension fixes the clobbering bug: two projects with a same-named local
 * plugin no longer stomp each other in a single flat global manifest.
 */
export const compileManifestPath = (prismHome: string, projectKey: string): string =>
  projectCompileManifestPath(prismHome, projectKey);

export const isCompileManifestHarnessId = (value: string): value is HarnessId =>
  Schema.is(HarnessIdSchema)(value);

export interface CompileManifestReadResult {
  readonly manifest: CompileManifest;
  readonly quarantinedPath?: string;
}

const verifyManifestIntegrity = (manifest: CompileManifest): boolean =>
  verifyCompileManifestHash(manifest) &&
  Object.values(manifest.agents).every((agent) => verifyAgentManifestHash(agent));

export const readCompileManifest = async (
  prismHome: string,
  projectKey: string,
): Promise<CompileManifestReadResult> => {
  const path = compileManifestPath(prismHome, projectKey);
  if (!(await exists(path))) return { manifest: emptyCompileManifest() };

  const decoded = decodeCompileManifest(await readFile(path));
  if (decoded && typeof decoded === "object" && "_tag" in decoded && decoded._tag === "Right") {
    if (verifyManifestIntegrity(decoded.right)) {
      return { manifest: decoded.right };
    }
  }

  const quarantinedPath = `${path}.corrupt-${Date.now()}.json`;
  await rename(path, quarantinedPath);
  return { manifest: emptyCompileManifest(), quarantinedPath };
};

export const commitCompileManifest = async (options: {
  readonly prismHome: string;
  readonly projectKey: string;
  readonly manifest: CompileManifest;
}): Promise<void> => {
  const path = compileManifestPath(options.prismHome, options.projectKey);
  await ensureDir(dirname(path));
  await writeFile(path, encodeCompileManifest(options.manifest));
};

const agentManifestId = (pluginName: string, agentName: string): string =>
  `${pluginName}:${agentName}`;

const sortStrings = (values: Iterable<string>): string[] => [...values].sort();

const stableInputKey = (input: CacheInputFile): string => `${input.plugin}:${input.path}`;

const computePluginSourceHashes = (
  descriptors: ReadonlyMap<string, AgentCacheDescriptor>,
): Map<string, string> => {
  const grouped = new Map<string, Map<string, CacheInputFile>>();
  for (const descriptor of descriptors.values()) {
    for (const input of descriptor.inputs) {
      const pluginInputs = grouped.get(input.plugin) ?? new Map<string, CacheInputFile>();
      pluginInputs.set(stableInputKey(input), input);
      grouped.set(input.plugin, pluginInputs);
    }
  }

  return new Map(
    [...grouped.entries()].map(([pluginName, inputs]) => [
      pluginName,
      stableJsonHash(sortStrings(inputs.keys()).map((key) => inputs.get(key)!) as unknown as StableJsonValue),
    ]),
  );
};

const manifestAgentFromComposed = (options: {
  readonly registry: PluginRegistry;
  readonly agent: ComposedAgent;
  readonly descriptor: AgentCacheDescriptor;
  readonly existing?: CompileManifestAgent;
  readonly target: HarnessId;
  readonly scope: HarnessScope;
}): CompileManifestAgent => {
  const manifest = options.agent.manifest ?? { modelBindings: {} };
  const perTarget = {
    ...(options.existing?.composed.perTarget ?? {}),
    [options.target]: {
      scope: options.scope,
      model: options.agent.model ?? null,
    },
  };
  const next: CompileManifestAgent = {
    name: options.agent.name,
    plugin: options.registry.pluginName,
    description: options.agent.description,
    sourceHash: options.descriptor.sourceHash,
    skills: [...options.agent.skills],
    composed: {
      modelBindings: manifest.modelBindings,
      perTarget,
    },
    manifestHash: "",
  };
  return { ...next, manifestHash: computeAgentManifestHash(next) };
};

const withTopHash = (manifest: Omit<CompileManifest, "manifestHash">): CompileManifest => {
  const next: CompileManifest = { ...manifest, manifestHash: "" };
  return { ...next, manifestHash: computeCompileManifestHash(next) };
};

const recomputeCoverage = (
  agents: Readonly<Record<string, CompileManifestAgent>>,
): CompileManifest["compileTargets"] => {
  const keys = new Set<string>();
  for (const agent of Object.values(agents)) {
    for (const [harness, slice] of Object.entries(agent.composed.perTarget)) {
      if (!isCompileManifestHarnessId(harness)) continue;
      keys.add(`${harness}:${slice.scope}`);
    }
  }
  return sortStrings(keys).map((key) => {
    const split = key.indexOf(":");
    return {
      harness: key.slice(0, split) as HarnessId,
      scope: key.slice(split + 1) as HarnessScope,
    };
  });
};

type ModelspaceProfilesData = Record<string, Record<string, Record<string, unknown>>>;

type ModelspaceAccum = {
  plugin: string;
  modelspace: string;
  profiles: Set<string>;
  profilesData: ModelspaceProfilesData;
};

const seedModelspaceAccumFromBase = (
  base: CompileManifest,
  loadedRegistryNames: ReadonlySet<string>,
): Record<string, ModelspaceAccum> => {
  const accum: Record<string, ModelspaceAccum> = {};
  for (const [key, entry] of Object.entries(base.modelspaces ?? {})) {
    if (loadedRegistryNames.has(entry.plugin)) continue;
    accum[key] = {
      plugin: entry.plugin,
      modelspace: entry.modelspace,
      profiles: new Set(entry.profiles ?? []),
      profilesData: { ...(entry.profilesData ?? {}) },
    };
  }
  return accum;
};

const addLoadedModelspaces = (
  accum: Record<string, ModelspaceAccum>,
  registries: ReadonlyMap<string, PluginRegistry>,
): void => {
  for (const registry of registries.values()) {
    for (const modelspace of registry.modelspaces.values()) {
      const key = `${registry.pluginName}:${modelspace.name}`;
      const existing = accum[key] ?? {
        plugin: registry.pluginName,
        modelspace: modelspace.name,
        profiles: new Set<string>(),
        profilesData: {},
      };
      for (const [profileName, profile] of Object.entries(modelspace.profiles)) {
        existing.profiles.add(profileName);
        existing.profilesData[profileName] = profile.targets as Record<string, Record<string, unknown>>;
      }
      accum[key] = existing;
    }
  }
};

const addAgentModelBindings = (
  accum: Record<string, ModelspaceAccum>,
  agents: Readonly<Record<string, CompileManifestAgent>>,
): void => {
  for (const agent of Object.values(agents)) {
    const mb = agent.composed.modelBindings;
    if (!mb.modelspace || !mb.profile) continue;
    let owner = agent.plugin;
    let local = mb.modelspace;
    const colon = mb.modelspace.indexOf(":");
    if (colon !== -1) {
      owner = mb.modelspace.slice(0, colon);
      local = mb.modelspace.slice(colon + 1);
    }
    const key = `${owner}:${local}`;
    accum[key] ??= { plugin: owner, modelspace: local, profiles: new Set(), profilesData: {} };
    accum[key].profiles.add(mb.profile);
  }
};

const materializeModelspaces = (
  accum: Record<string, ModelspaceAccum>,
): Record<string, CompileManifestModelspace> => {
  const modelspaces: Record<string, CompileManifestModelspace> = {};
  for (const [key, acc] of Object.entries(accum)) {
    modelspaces[key] = {
      plugin: acc.plugin,
      modelspace: acc.modelspace,
      profiles: sortStrings([...acc.profiles]),
      ...(Object.keys(acc.profilesData).length > 0 ? { profilesData: acc.profilesData } : {}),
    };
  }
  return modelspaces;
};

const deriveModelspacesForManifest = (options: {
  readonly base: CompileManifest;
  readonly registry: PluginRegistry;
  readonly agents: Readonly<Record<string, CompileManifestAgent>>;
}): Record<string, CompileManifestModelspace> => {
  const registries = collectPluginRegistries(options.registry);
  const loadedRegistryNames = new Set(registries.keys());
  const accum = seedModelspaceAccumFromBase(options.base, loadedRegistryNames);
  addLoadedModelspaces(accum, registries);
  addAgentModelBindings(accum, options.agents);
  return materializeModelspaces(accum);
};

const deriveSkillsForManifest = (
  agents: Readonly<Record<string, CompileManifestAgent>>,
): Record<string, CompileManifestManagedSkill | CompileManifestSkillspace> => {
  const skillAccum: Record<
    string,
    { plugin: string; name?: string; skillspace?: string; skills?: Set<string> }
  > = {};
  for (const agent of Object.values(agents)) {
    const allSkillRefs = new Set<string>(agent.skills);
    for (const ref of allSkillRefs) {
      const named = parseNamedRef(ref);
      const space = parseSpaceItemRef(ref, "/");
      if (space) {
        const owner = space.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${space.space}`;
        skillAccum[key] ??= { plugin: owner, skillspace: space.space, skills: new Set() };
        skillAccum[key].skills!.add(space.name);
      } else {
        const owner = named.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${named.name}`;
        skillAccum[key] ??= { plugin: owner, name: named.name };
      }
    }
  }

  const skills: Record<string, CompileManifestManagedSkill | CompileManifestSkillspace> = {};
  for (const [key, acc] of Object.entries(skillAccum)) {
    if (acc.skillspace) {
      skills[key] = {
        plugin: acc.plugin,
        skillspace: acc.skillspace,
        skills: sortStrings([...acc.skills!]),
      };
    } else if (acc.name) {
      skills[key] = {
        plugin: acc.plugin,
        name: acc.name,
      };
    }
  }
  return skills;
};

const deriveToolsForManifest = (options: {
  readonly base: CompileManifest;
  readonly registry: PluginRegistry;
}): Record<string, CompileManifestCanonicalTool> => {
  const registries = collectPluginRegistries(options.registry);
  const loadedPluginNames = new Set(registries.keys());
  const tools: Record<string, CompileManifestCanonicalTool> = {};
  for (const [key, entry] of Object.entries(options.base.tools)) {
    if (loadedPluginNames.has(entry.plugin)) continue;
    tools[key] = entry;
  }
  for (const registry of registries.values()) {
    for (const tool of registry.tools.values()) {
      const key = `${registry.pluginName}:${tool.name}`;
      tools[key] = {
        plugin: registry.pluginName,
        name: tool.name,
        // PQ-075: project the declared side-effect authority, when the
        // source registry declares one. Undeclared tools omit the field
        // (default-then-require migration — see ToolAuthoritySchema) so
        // existing plugins that predate this field are unaffected.
        ...(tool.authority ? { authority: tool.authority } : {}),
      };
    }
  }
  return tools;
};

export interface CompileManifestSopProjectionInput {
  readonly name: string;
  readonly phases: CompileManifestSop["phases"];
}

/**
 * A sop compile pass is always authoritative for the source plugin's sop
 * entries: passing projections replaces every existing entry for that plugin
 * (including the empty set), so stale sops cannot be stranded. There is no
 * declared/undeclared "authoritative pass" split here.
 */
const deriveSopsForManifest = (options: {
  readonly base: CompileManifest;
  readonly registryPluginName: string;
  readonly sops?: ReadonlyArray<CompileManifestSopProjectionInput>;
}): Record<string, CompileManifestSop> => {
  const sopsRecord: Record<string, CompileManifestSop> = {
    ...options.base.sops,
  };
  if (options.sops !== undefined) {
    for (const key of Object.keys(sopsRecord)) {
      if (sopsRecord[key]!.plugin === options.registryPluginName) {
        delete sopsRecord[key];
      }
    }
    for (const sop of options.sops) {
      const id = `${options.registryPluginName}:${sop.name}`;
      sopsRecord[id] = {
        plugin: options.registryPluginName,
        name: sop.name,
        phases: [...sop.phases],
      };
    }
  }
  return sopsRecord;
};

const derivePluginsForManifest = (options: {
  readonly base: CompileManifest;
  readonly registry: PluginRegistry;
  readonly agents: Readonly<Record<string, CompileManifestAgent>>;
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
}): CompileManifest["plugins"] => {
  const registries = collectPluginRegistries(options.registry);
  const currentPluginHashes = computePluginSourceHashes(options.cacheDescriptors);
  const livePluginNames = new Set(Object.values(options.agents).map((agent) => agent.plugin));
  for (const pluginName of currentPluginHashes.keys()) livePluginNames.add(pluginName);

  const plugins: Record<string, CompileManifest["plugins"][string]> = {};
  for (const pluginName of sortStrings(livePluginNames)) {
    const sourceHash = currentPluginHashes.get(pluginName) ?? options.base.plugins[pluginName]?.sourceHash;
    if (!sourceHash) continue;
    const version = registries.get(pluginName)?.pluginVersion ?? options.base.plugins[pluginName]?.version;
    plugins[pluginName] = {
      ...(version ? { version } : {}),
      sourceHash,
    };
  }
  return plugins;
};

export const buildCompileManifestForTarget = (options: {
  readonly base: CompileManifest;
  readonly registry: PluginRegistry;
  readonly target: HarnessId;
  readonly scope: HarnessScope;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
  /** When provided, this compile pass replaces every sop entry for the source plugin (including with the empty set). Threaded only for sop-targeting compiles. */
  readonly sops?: ReadonlyArray<CompileManifestSopProjectionInput>;
}): CompileManifest => {
  const agents: Record<string, CompileManifestAgent> = { ...options.base.agents };
  const currentIds = new Set<string>();

  for (const agent of options.composed) {
    const descriptor = options.cacheDescriptors.get(agent.name);
    if (!descriptor) continue;
    const id = agentManifestId(options.registry.pluginName, agent.name);
    currentIds.add(id);
    agents[id] = manifestAgentFromComposed({
      registry: options.registry,
      agent,
      descriptor,
      existing: agents[id],
      target: options.target,
      scope: options.scope,
    });
  }

  for (const [id, agent] of Object.entries(agents)) {
    if (agent.plugin !== options.registry.pluginName || currentIds.has(id)) continue;
    if (!agent.composed.perTarget[options.target]) continue;
    const { [options.target]: _removed, ...perTarget } = agent.composed.perTarget;
    if (Object.keys(perTarget).length === 0) {
      delete agents[id];
      continue;
    }
    const updated: CompileManifestAgent = {
      ...agent,
      composed: {
        ...agent.composed,
        perTarget,
      },
      manifestHash: "",
    };
    agents[id] = { ...updated, manifestHash: computeAgentManifestHash(updated) };
  }

  const modelspaces = deriveModelspacesForManifest({
    base: options.base,
    registry: options.registry,
    agents,
  });

  const skills = deriveSkillsForManifest(agents);

  const tools = deriveToolsForManifest({
    base: options.base,
    registry: options.registry,
  });

  const sops = deriveSopsForManifest({
    base: options.base,
    registryPluginName: options.registry.pluginName,
    ...(options.sops ? { sops: options.sops } : {}),
  });

  const plugins = derivePluginsForManifest({
    base: options.base,
    registry: options.registry,
    agents,
    cacheDescriptors: options.cacheDescriptors,
  });

  return withTopHash({
    version: 1,
    plugins,
    compileTargets: recomputeCoverage(agents),
    agents,
    modelspaces,
    skills,
    tools,
    sops,
  });
};

export const updateCompileManifestForTarget = async (options: {
  readonly prismHome: string;
  readonly projectKey: string;
  readonly registry: PluginRegistry;
  readonly target: HarnessId;
  readonly scope: HarnessScope;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
  /** Forwarded from surfaces.sops pass in compilePluginForTarget; undefined carries base, [] clears the plugin's sop entries. */
  readonly sops?: ReadonlyArray<CompileManifestSopProjectionInput>;
}): Promise<void> =>
  withSnapshotLock(options.prismHome, async () => {
    const { manifest } = await readCompileManifest(options.prismHome, options.projectKey);
    await commitCompileManifest({
      prismHome: options.prismHome,
      projectKey: options.projectKey,
      manifest: buildCompileManifestForTarget({
        base: manifest,
        registry: options.registry,
        target: options.target,
        scope: options.scope,
        composed: options.composed,
        cacheDescriptors: options.cacheDescriptors,
        ...(options.sops ? { sops: options.sops } : {}),
      }),
    });
  });

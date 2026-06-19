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
  type CompileManifestOrbit,
  type CompileManifestTrait,
  type CompileManifestCanonicalTool,
  type CompileManifestToolspaceTool,
  type HarnessId,
  type HarnessScope,
} from "@skastr0/prism-core/compile-manifest";
import { parseNamedRef, parseSpaceItemRef } from "@skastr0/prism-core/refs";
import { stableJsonHash, type StableJsonValue } from "@skastr0/prism-core/stable-json";
import { ensureDir, exists, readFile, writeFile } from "../fs.js";
import { projectCompileManifestPath } from "../project-key.js";
import { withSnapshotLock } from "../state/lock.js";
import type { AgentCacheDescriptor, CacheInputFile } from "./cache.js";
import type { ComposedAgent } from "./compose.js";
import { collectPluginRegistries, type PluginRegistry } from "./registry.js";

export * from "@skastr0/prism-core/compile-manifest";

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

const canonicalToolRef = (binding: ComposedAgent["toolBindings"][number]): string =>
  `${binding.toolPluginName}:${binding.toolName}`;

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
  const manifest = options.agent.manifest ?? { traits: [], modelBindings: {} };
  const currentToolGrants = [...new Set(options.agent.toolBindings.map(canonicalToolRef))];
  const perTarget = {
    ...(options.existing?.composed.perTarget ?? {}),
    [options.target]: {
      scope: options.scope,
      model: options.agent.model ?? null,
      toolGrants: currentToolGrants,
      allowedTools: [...options.agent.allowedTools],
      allowedSkills: [...options.agent.allowedSkills],
    },
  };
  const grantTools = sortStrings(
    new Set(Object.values(perTarget).flatMap((slice) => slice.toolGrants)),
  );
  const grantSkills = sortStrings(
    new Set(Object.values(perTarget).flatMap((slice) => slice.allowedSkills)),
  );
  const next: CompileManifestAgent = {
    name: options.agent.name,
    plugin: options.registry.pluginName,
    description: options.agent.description,
    sourceHash: options.descriptor.sourceHash,
    traits: [...manifest.traits],
    skills: [...options.agent.skills],
    composed: {
      grants: {
        tools: grantTools,
        skills: grantSkills,
      },
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

export const buildCompileManifestForTarget = (options: {
  readonly base: CompileManifest;
  readonly registry: PluginRegistry;
  readonly target: HarnessId;
  readonly scope: HarnessScope;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
  /** When provided, this compile pass is authoritative for the source plugin's orbit identities (from prepareTargetOrbits, non-templates only). Threaded only for orbit-targeting compiles to avoid clearing on other targets. Minimal {name} shape (no sourcePath/phases/body). */
  readonly orbits?: ReadonlyArray<{ readonly name: string }>;
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
        grants: {
          tools: sortStrings(new Set(Object.values(perTarget).flatMap((slice) => slice.toolGrants))),
          skills: sortStrings(new Set(Object.values(perTarget).flatMap((slice) => slice.allowedSkills))),
        },
        perTarget,
      },
      manifestHash: "",
    };
    agents[id] = { ...updated, manifestHash: computeAgentManifestHash(updated) };
  }

  // Derive top-level modelspaces collection from agent composed.modelBindings.
  // Smallest additive surface for workflow refs; populated only from already-composed
  // bindings (no plugin source reads). Keyed by "ownerPlugin:localModelspace" for
  // collision-free stable lookup. Profiles collected per (plugin, modelspace).
  const registries = collectPluginRegistries(options.registry);
  const modelspaceAccum: Record<string, { plugin: string; modelspace: string; profiles: Set<string> }> = {};
  for (const agent of Object.values(agents)) {
    const mb = agent.composed.modelBindings;
    if (mb.modelspace && mb.profile) {
      let owner = mb.modelspace;
      let local = mb.modelspace;
      const colon = mb.modelspace.indexOf(":");
      if (colon !== -1) {
        owner = mb.modelspace.slice(0, colon);
        local = mb.modelspace.slice(colon + 1);
      } else {
        owner = agent.plugin;
        local = mb.modelspace;
      }
      const key = `${owner}:${local}`;
      if (!modelspaceAccum[key]) {
        modelspaceAccum[key] = { plugin: owner, modelspace: local, profiles: new Set() };
      }
      modelspaceAccum[key].profiles.add(mb.profile);
    }
  }
  const modelspaces: Record<string, CompileManifestModelspace> = {};
  for (const [key, acc] of Object.entries(modelspaceAccum)) {
    const msSource = registries.get(acc.plugin)?.modelspaces.get(acc.modelspace);
    const profilesData: Record<string, Record<string, Record<string, unknown>>> = {};
    if (msSource) {
      for (const profileName of acc.profiles) {
        const profile = msSource.profiles[profileName];
        if (profile) {
          profilesData[profileName] = profile.targets as Record<string, Record<string, unknown>>;
        }
      }
    }
    modelspaces[key] = {
      plugin: acc.plugin,
      modelspace: acc.modelspace,
      profiles: sortStrings([...acc.profiles]),
      ...(Object.keys(profilesData).length > 0 ? { profilesData } : {}),
    };
  }

  // Derive top-level skills collection (managed + skillspaces) post-merge from
  // the agent skills/grants/allowedSkills strings (manifest truth only; no source
  // paths, no registry scans). Uses parseNamedRef/parseSpaceItemRef to classify
  // bare/prefixed managed vs p:space/name skillspace refs. Keyed "owner:local"
  // for collision-free lookup. Parallel to modelspaces derivation.
  const skillAccum: Record<
    string,
    { plugin: string; name?: string; skillspace?: string; skills?: Set<string> }
  > = {};
  for (const agent of Object.values(agents)) {
    const allSkillRefs = new Set<string>([
      ...agent.skills,
      ...agent.composed.grants.skills,
      ...Object.values(agent.composed.perTarget).flatMap((slice) => slice.allowedSkills),
    ]);
    for (const ref of allSkillRefs) {
      const named = parseNamedRef(ref);
      const space = parseSpaceItemRef(ref, "/");
      if (space) {
        const owner = space.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${space.space}`;
        if (!skillAccum[key]) {
          skillAccum[key] = { plugin: owner, skillspace: space.space, skills: new Set() };
        }
        skillAccum[key].skills!.add(space.name);
      } else {
        const owner = named.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${named.name}`;
        if (!skillAccum[key]) {
          skillAccum[key] = { plugin: owner, name: named.name };
        }
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

  // Derive top-level traits Record keyed by id from composed agents' traits only.
  // Dedupe by id (preserve first {id,ref}); no registry scans, no source paths, no
  // plugin source reads. This provides manifest truth for workflow trait refs.
  // Inserted after skills derivation (modelspaces/skills precedent) and before any
  // registries/plugins collection.
  const traitAccum: Record<string, CompileManifestTrait> = {};
  for (const agent of Object.values(agents)) {
    for (const t of agent.traits) {
      if (!traitAccum[t.id]) {
        traitAccum[t.id] = { id: t.id, ref: t.ref };
      }
    }
  }
  const traits: Record<string, CompileManifestTrait> = traitAccum;

  // Derive top-level tools collection (canonical + toolspace tools) post-merge from
  // the agent composed.grants.tools + perTarget.toolGrants strings (manifest truth only;
  // no source paths, no registry, no input/output/handle, no permissions/MCP details).
  // Uses parseNamedRef + parseSpaceItemRef(ref, '/') to classify "plugin:name" canon vs
  // "plugin:space/name" toolspace. Keyed `${owner}:${name}` or `${owner}:${space}/${name}`.
  // Populated for workflow refs parity; identity-only.
  const toolAccum: Record<
    string,
    { plugin: string; name?: string; toolspace?: string }
  > = {};
  for (const agent of Object.values(agents)) {
    const allToolRefs = new Set<string>([
      ...agent.composed.grants.tools,
      ...Object.values(agent.composed.perTarget).flatMap((slice) => slice.toolGrants),
    ]);
    for (const ref of allToolRefs) {
      const named = parseNamedRef(ref);
      const space = parseSpaceItemRef(ref, "/");
      if (space) {
        const owner = space.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${space.space}/${space.name}`;
        if (!toolAccum[key]) {
          toolAccum[key] = { plugin: owner, toolspace: space.space, name: space.name };
        }
      } else {
        const owner = named.pluginPrefix ?? agent.plugin;
        const key = `${owner}:${named.name}`;
        if (!toolAccum[key]) {
          toolAccum[key] = { plugin: owner, name: named.name };
        }
      }
    }
  }
  const tools: Record<string, CompileManifestCanonicalTool | CompileManifestToolspaceTool> = {};
  for (const [key, acc] of Object.entries(toolAccum)) {
    if (acc.toolspace && acc.name) {
      tools[key] = {
        plugin: acc.plugin,
        toolspace: acc.toolspace,
        name: acc.name,
      };
    } else if (acc.name) {
      tools[key] = {
        plugin: acc.plugin,
        name: acc.name,
      };
    }
  }

  // Derive top-level orbits Record (keyed "plugin:name") from the authoritative
  // orbits list when passed (this target compile targeted orbits for the plugin).
  // Only plugin+name (no sourcePath, no phases/body). Prune only this plugin's
  // prior entries when authoritative; carry other plugins from base (non-clearing
  // when compile targets other surfaces only).
  const orbitsRecord: Record<string, { plugin: string; name: string }> = {
    ...(options.base as any).orbits ?? {},
  };
  if (options.orbits !== undefined) {
    for (const key of Object.keys(orbitsRecord)) {
      if (orbitsRecord[key]!.plugin === options.registry.pluginName) {
        delete orbitsRecord[key];
      }
    }
    for (const o of options.orbits) {
      const id = `${options.registry.pluginName}:${o.name}`;
      orbitsRecord[id] = { plugin: options.registry.pluginName, name: o.name };
    }
  }
  const orbits: Record<string, CompileManifestOrbit> = orbitsRecord;

  const currentPluginHashes = computePluginSourceHashes(options.cacheDescriptors);
  const livePluginNames = new Set(Object.values(agents).map((agent) => agent.plugin));
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

  return withTopHash({
    version: 1,
    plugins,
    compileTargets: recomputeCoverage(agents),
    agents,
    modelspaces,
    skills,
    tools,
    traits,
    orbits,
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
  /** Forwarded from surfaces.orbits pass in compilePluginForTarget; undefined means non-authoritative for orbits (carry base). */
  readonly orbits?: ReadonlyArray<{ readonly name: string }>;
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
        ...(options.orbits ? { orbits: options.orbits } : {}),
      }),
    });
  });

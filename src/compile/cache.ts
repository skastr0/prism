/**
 * Content-addressable cache for compiled agents.
 *
 * Cache key: hash(normalized source fingerprint + target + scope + compiler semantics)
 * Cache value: serialized ComposedAgent + primary output hashes.
 */

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { ComposedAgent } from "./compose.js";
import type {
  Agent,
  CanonicalTool,
  Identity,
  Modelspace,
  Personality,
  Skill,
  Skillspace,
  Toolspace,
  Trait,
} from "./sources.js";
import type { PluginRegistry } from "./registry.js";
import { ensureDir, exists, readFile, removeDir, writeFile } from "../fs.js";

interface CacheContext {
  readonly target: string;
  readonly scope: string;
}

export const CACHE_FORMAT_VERSION = 3;

/**
 * Bump this whenever compile/lowering semantics change without a corresponding
 * source DSL change. This prevents stale composed agents from surviving compiler
 * fixes such as generated tool naming or permission-lowering changes.
 */
export const COMPILER_SEMANTICS_VERSION =
  "2026-04-28-opencode-skill-permissions-v1";

type SourceLike =
  | Identity
  | Personality
  | Modelspace
  | Skillspace
  | Toolspace
  | Trait
  | CanonicalTool
  | Skill
  | Agent;

export interface CacheInputFile {
  readonly plugin: string;
  readonly path: string;
  readonly contentHash: string;
}

export interface AgentCacheDescriptor {
  readonly key: string;
  readonly sourceHash: string;
  readonly contextHash: string;
  readonly inputs: ReadonlyArray<CacheInputFile>;
}

export interface CacheEntry {
  readonly key: string;
  readonly sourceHash: string;
  readonly contextHash: string;
  readonly composed: ComposedAgent;
  readonly outputs: Record<string, string>;
  readonly timestamp: string;
}

interface ParsedNamedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

interface ParsedSpaceItemRef {
  readonly pluginPrefix: string | undefined;
  readonly space: string;
  readonly name: string;
}

interface CacheResolvedSource {
  readonly ref: string;
  readonly plugin: string;
  readonly path: string;
  readonly contentHash: string;
}

interface CacheMissingSource {
  readonly ref: string;
  readonly missing: true;
}

type CacheSourceDescriptor = CacheResolvedSource | CacheMissingSource;

const stableValue = (value: unknown): unknown => {
  if (value instanceof Array) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value));

const parseNamedRef = (ref: string): ParsedNamedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) {
    return { pluginPrefix: undefined, name: ref };
  }

  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

const parseSpaceItemRef = (
  ref: string,
  separator: "/" | "#",
): ParsedSpaceItemRef | undefined => {
  const parsed = parseNamedRef(ref);
  const split = parsed.name.indexOf(separator);
  if (split === -1) return undefined;
  const space = parsed.name.slice(0, split);
  const name = parsed.name.slice(split + 1);
  if (space.length === 0 || name.length === 0) return undefined;
  return { pluginPrefix: parsed.pluginPrefix, space, name };
};

const normalizeRelativePath = (from: string, to: string): string => {
  const path = relative(from, to).replace(/\\/g, "/");
  return path.length > 0 ? path : ".";
};

const compareInputFiles = (left: CacheInputFile, right: CacheInputFile): number => {
  const pluginOrder = left.plugin.localeCompare(right.plugin);
  if (pluginOrder !== 0) return pluginOrder;
  return left.path.localeCompare(right.path);
};

const getContextShape = (options: CacheContext) => ({
  cacheFormatVersion: CACHE_FORMAT_VERSION,
  compilerSemanticsVersion: COMPILER_SEMANTICS_VERSION,
  target: options.target,
  scope: options.scope,
});

const resolveRegistryForRef = (
  ref: string,
  registry: PluginRegistry,
): PluginRegistry | undefined => {
  const parsed = parseNamedRef(ref);
  if (!parsed.pluginPrefix) return registry;
  return registry.deps.get(parsed.pluginPrefix);
};

const readHashedSource = async (
  source: SourceLike,
  owner: PluginRegistry,
): Promise<CacheInputFile> => {
  const content = await readFile(source.sourcePath);
  return {
    plugin: owner.pluginName,
    path: normalizeRelativePath(owner.pluginPath, source.sourcePath),
    contentHash: computeContentHash(content),
  };
};

const resolveSourceDescriptor = async <T extends SourceLike>(
  ref: string,
  registry: PluginRegistry,
  select: (owner: PluginRegistry) => Map<string, T>,
): Promise<CacheSourceDescriptor> => {
  const owner = resolveRegistryForRef(ref, registry);
  if (!owner) {
    return { ref, missing: true };
  }

  const target = select(owner).get(parseNamedRef(ref).name);
  if (!target) {
    return { ref, missing: true };
  }

  const hashed = await readHashedSource(target, owner);
  return {
    ref,
    plugin: hashed.plugin,
    path: hashed.path,
    contentHash: hashed.contentHash,
  };
};

const resolveSpaceDescriptor = async <T extends SourceLike>(
  ref: string,
  registry: PluginRegistry,
  separator: "/" | "#",
  select: (owner: PluginRegistry) => Map<string, T>,
): Promise<CacheSourceDescriptor> => {
  const parsed = parseSpaceItemRef(ref, separator);
  if (!parsed) {
    return { ref, missing: true };
  }

  const owner = parsed.pluginPrefix ? registry.deps.get(parsed.pluginPrefix) : registry;
  if (!owner) {
    return { ref, missing: true };
  }

  const target = select(owner).get(parsed.space);
  if (!target) {
    return { ref, missing: true };
  }

  const hashed = await readHashedSource(target, owner);
  return {
    ref,
    plugin: hashed.plugin,
    path: hashed.path,
    contentHash: hashed.contentHash,
  };
};

const collectTraitDescriptors = async (
  agent: Agent,
  registry: PluginRegistry,
): Promise<
  ReadonlyArray<{
    ref: string;
    binding: Agent["traits"][number];
    source: CacheSourceDescriptor;
    trait: Trait | undefined;
    tools: ReadonlyArray<CacheSourceDescriptor>;
  }>
> =>
  Promise.all(
    agent.traits.map(async (binding) => {
      const source = await resolveSourceDescriptor(binding.ref, registry, (owner) => owner.traits);
      const owner = resolveRegistryForRef(binding.ref, registry);
      const trait = owner?.traits.get(parseNamedRef(binding.ref).name);
      const toolDescriptors: CacheSourceDescriptor[] = [];
      if (trait) {
        for (const attachment of Object.values(trait.tools)) {
          const toolSource = await resolveSourceDescriptor(
            attachment.ref,
            registry,
            (o) => o.tools,
          );
          toolDescriptors.push(toolSource);
        }
      }
      return {
        ref: binding.ref,
        binding,
        source,
        trait,
        tools: toolDescriptors,
      };
    }),
  );

const collectAccessRefs = (
  agent: Agent,
  traits: ReadonlyArray<{ trait: Trait | undefined }>,
): {
  readonly tools: ReadonlyArray<string>;
  readonly toolGroups: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
} => {
  const tools = new Set(agent.access.tools);
  const toolGroups = new Set(agent.access.toolGroups);
  const skills = new Set(agent.access.skills);

  for (const { trait } of traits) {
    if (!trait) continue;
    for (const tool of trait.access.tools) {
      tools.add(tool);
    }
    for (const toolGroup of trait.access.toolGroups) {
      toolGroups.add(toolGroup);
    }
    for (const skill of trait.access.skills) {
      skills.add(skill);
    }
  }

  return {
    tools: [...tools].sort((left, right) => left.localeCompare(right)),
    toolGroups: [...toolGroups].sort((left, right) => left.localeCompare(right)),
    skills: [...skills].sort((left, right) => left.localeCompare(right)),
  };
};

const collectSkillRefs = (
  agent: Agent,
  traits: ReadonlyArray<{ trait: Trait | undefined }>,
): ReadonlyArray<string> => {
  const skills = new Set([...agent.skills, ...agent.access.skills]);

  for (const { trait } of traits) {
    if (!trait) continue;
    for (const skill of trait.access.skills) {
      skills.add(skill);
    }
    for (const skill of trait.inject.skills) {
      skills.add(skill);
    }
    for (const skill of trait.require.skills) {
      skills.add(skill);
    }
  }

  return [...skills].sort((left, right) => left.localeCompare(right));
};

export const computeCacheKey = (
  agentSource: string,
  options: CacheContext,
): string => {
  const hash = createHash("sha256");
  hash.update(agentSource);
  hash.update(stableStringify(getContextShape(options)));
  return hash.digest("hex");
};

export const computeContentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const computeStableHash = (value: unknown): string =>
  computeContentHash(stableStringify(value));

export const computeContextHash = (options: CacheContext): string =>
  computeStableHash(getContextShape(options));

export const computeAgentCacheDescriptor = async (
  agent: Agent,
  registry: PluginRegistry,
  options: CacheContext,
): Promise<AgentCacheDescriptor> => {
  const agentInput = await readHashedSource(agent, registry);
  const inputs = new Map<string, CacheInputFile>();
  inputs.set(`${agentInput.plugin}:${agentInput.path}`, agentInput);

  const identity = await resolveSourceDescriptor(agent.identity, registry, (owner) => owner.identities);
  const personality = agent.personality
    ? await resolveSourceDescriptor(agent.personality, registry, (owner) => owner.personalities)
    : undefined;
  const model = agent.model
    ? await resolveSpaceDescriptor(agent.model, registry, "/", (owner) => owner.modelspaces)
    : undefined;
  const traits = await collectTraitDescriptors(agent, registry);
  const access = collectAccessRefs(agent, traits);
  const skillRefs = collectSkillRefs(agent, traits);

  const toolspaces = await Promise.all([
    ...access.tools.map((toolRef) =>
      resolveSpaceDescriptor(toolRef, registry, "/", (owner) => owner.toolspaces),
    ),
    ...access.toolGroups.map((toolGroupRef) =>
      resolveSpaceDescriptor(toolGroupRef, registry, "#", (owner) => owner.toolspaces),
    ),
  ]);
  const skillspaces = await Promise.all(
    skillRefs
      .filter((skillRef) => parseSpaceItemRef(skillRef, "/"))
      .map((skillRef) =>
        resolveSpaceDescriptor(skillRef, registry, "/", (owner) => owner.skillspaces),
      ),
  );
  const managedSkills = await Promise.all(
    skillRefs
      .filter((skillRef) => !parseSpaceItemRef(skillRef, "/"))
      .map((skillRef) =>
        resolveSourceDescriptor(skillRef, registry, (owner) => owner.skills),
      ),
  );

  for (const descriptor of [
    identity,
    personality,
    model,
    ...traits.map((item) => item.source),
    ...traits.flatMap((item) => item.tools),
    ...toolspaces,
    ...skillspaces,
    ...managedSkills,
  ]) {
    if (!descriptor || "missing" in descriptor) continue;
    inputs.set(`${descriptor.plugin}:${descriptor.path}`, {
      plugin: descriptor.plugin,
      path: descriptor.path,
      contentHash: descriptor.contentHash,
    });
  }

  const sourceFingerprint = {
    agent: agentInput,
    references: {
      identity,
      personality,
      model,
      traits: traits.map(({ ref, binding, source, tools }) => ({ ref, binding, source, tools })),
      access,
      toolspaces,
      skillspaces,
      managedSkills,
    },
  };

  const sourceHash = computeStableHash(sourceFingerprint);
  const contextHash = computeContextHash(options);

  return {
    key: computeCacheKey(sourceHash, options),
    sourceHash,
    contextHash,
    inputs: [...inputs.values()].sort(compareInputFiles),
  };
};

export const getCacheDir = (pluginPath: string): string =>
  join(pluginPath, "dist", ".prism-cache");

export const readCacheEntry = async (
  cacheDir: string,
  key: string,
): Promise<CacheEntry | null> => {
  const path = join(cacheDir, `${key}.json`);
  if (!(await exists(path))) return null;

  try {
    const data = await readFile(path);
    const parsed = JSON.parse(data) as CacheEntry;
    return parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
};

export const writeCacheEntry = async (
  cacheDir: string,
  entry: CacheEntry,
): Promise<void> => {
  await ensureDir(cacheDir);
  const path = join(cacheDir, `${entry.key}.json`);
  await writeFile(path, JSON.stringify(entry, null, 2));
};

export const cleanCache = async (cacheDir: string): Promise<void> => {
  await removeDir(cacheDir);
};

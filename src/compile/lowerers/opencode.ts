/**
 * OpenCode lowerer.
 *
 * Takes a set of ComposedAgents + orbits and produces:
 *
 *   1. Per-agent markdown at <opencode-root>/agents/<name>.md with
 *      {name, description, permission?} frontmatter and the composed body.
 *      When the agent has generated tool bindings, the frontmatter's
 *      `permission` block enables only those generated tools and denies every
 *      other generated tool in the current inventory.
 *
 *   2. Idempotent patches to <opencode-root>/opencode.json:
 *        - agent.<name> block (compiler-owned keys only; hand-authored keys preserved)
 *        - plugin array entry for the source-plugin-owned generated plugin
 *          (for example `prism-generated-review-core`) when any agent has
 *          tool bindings
 *
 *   3. Per-orbit skills at <opencode-root>/skills/<name>/SKILL.md.
 *      Orbits remain source-language constructs; the generated skill is
 *      the runtime-facing lowering that OpenCode actually loads.
 *
 *   4. A generated OpenCode plugin directory at
 *      <opencode-root>/plugins/prism-generated-<source-plugin>/ containing:
 *        - dist/server.mjs
 *
 * The generated plugin directory is compiler-owned. Re-running compile prunes
 * stale stale raw-TypeScript generated output such as src/**, package.json,
 * lockfiles, and node_modules/.
 */

import { mkdir, mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { CanonicalTool, Contract, Hook, Orbit } from "../sources.js";
import type { PluginRegistry } from "../registry.js";
import type { HarnessScope } from "../../types.js";
import {
  collectRelativeImportSpecifiers,
  NODE_BUILTIN_EXTERNALS,
  relativeModulePath,
  rewriteBareEffectImportsForBundle,
  rewriteBareImportsForBundle,
  rewriteBarePluginDependencyImportsForBundle,
  rewriteGeneratedPluginBundleImports,
  resolveImportedSourcePath,
  resolveTsImportCandidate,
  stripToolAuthoringHelpers,
} from "../bundle-utils.js";
import {
  generatedOwnerToolName,
  generatedToolNameForBinding,
  generatedToolNamespace,
  normalizeGeneratedPluginName,
  sourceIsInside,
} from "../generated-plugin.js";
import { opencodePluginBundleImportPath } from "../runtime-deps.js";
import {
  bindingFromToolSource,
  bindingsFromCanonicalTools,
} from "../tool-bindings.js";
import {
  nativeHookEventName,
  prismOwnerMarker,
  renderGeneratedOrbitSkill,
  writeReason,
} from "./shared.js";
import {
  backupFile,
  exists as fileExists,
  readFile,
  writeFile,
  listDirRecursive,
  removeDir,
  removeFile,
} from "../../fs.js";

// Keys at agent.<name>.* that the compiler owns. Other keys on an existing
// block are preserved verbatim during patching.
const COMPILER_OWNED_KEYS = [
  "model",
  "variant",
  "mode",
  "color",
  "permission",
  "temperature",
  "top_p",
  "maxSteps",
  "disable",
] as const;

const GENERATED_PLUGIN_PREFIX = "prism-generated";
type PermissionAction = "allow" | "ask" | "deny";
type PermissionValue = PermissionAction | Record<string, PermissionAction>;

export interface OpenCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  /** Root plugin.json name for the compile invocation that owns this output. */
  readonly sourcePluginName: string;
}

const agentMdPath = (target: OpenCodeLowerTarget, name: string): string =>
  join(target.root, "agents", `${name}.md`);

const orbitSkillMdPath = (
  target: OpenCodeLowerTarget,
  name: string
): string => join(target.root, "skills", name, "SKILL.md");

const orbitSkillRelativePath = (name: string): string =>
  `skills/${name}/SKILL.md`;

const opencodeJsonPath = (target: OpenCodeLowerTarget): string =>
  join(target.root, "opencode.json");

const ownerToolName = generatedOwnerToolName;

const runtimeToolName = generatedToolNameForBinding;

const generatedPluginIdForName = (pluginName: string): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeGeneratedPluginName(pluginName)}`;

const generatedPluginId = (target: OpenCodeLowerTarget): string =>
  generatedPluginIdForName(target.sourcePluginName);

const generatedPluginRoot = (target: OpenCodeLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPluginRootForName = (
  target: OpenCodeLowerTarget,
  pluginName: string,
): string => join(target.root, "plugins", generatedPluginIdForName(pluginName));

const generatedPluginEntryForName = (
  target: OpenCodeLowerTarget,
  pluginName: string,
): string =>
  pathToFileURL(
    join(generatedPluginRootForName(target, pluginName), "dist", "server.mjs")
  ).href;

const staleGeneratedPluginSourceEntryForName = (
  target: OpenCodeLowerTarget,
  pluginName: string,
): string =>
  pathToFileURL(
    join(generatedPluginRootForName(target, pluginName), "src", "server.ts")
  ).href;

const isStaleGeneratedPluginEntry = (
  entry: unknown,
  target: OpenCodeLowerTarget,
): entry is string => {
  if (typeof entry !== "string") return false;
  if (entry.startsWith(`${GENERATED_PLUGIN_PREFIX}-`)) return true;

  let pathname: string;
  try {
    const url = new URL(entry);
    if (url.protocol !== "file:") return false;
    pathname = fileURLToPath(url);
  } catch {
    return false;
  }

  const relativePluginPath = relative(join(target.root, "plugins"), pathname).replace(/\\/g, "/");
  return (
    !relativePluginPath.startsWith("../") &&
    !relativePluginPath.startsWith("/") &&
    relativePluginPath.startsWith(`${GENERATED_PLUGIN_PREFIX}-`) &&
    relativePluginPath.endsWith("/src/server.ts")
  );
};

const generatedToolDenyPatternForName = (pluginName: string): string =>
  `${generatedToolNamespace(pluginName)}_*`;

const rewriteGeneratedOpenCodeRuntimeImportsForBundle = (source: string): string =>
  rewriteBareImportsForBundle(
    rewriteBareEffectImportsForBundle(source),
    new Map([["@opencode-ai/plugin", opencodePluginBundleImportPath()]]),
  );

// ---------------------------------------------------------------------------
// Operation shape
// ---------------------------------------------------------------------------

export type LowerOperation =
  | {
      readonly kind: "write-md";
      readonly target: string;
      readonly content: string;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "patch-json";
      readonly target: string;
      readonly agentName: string;
      readonly nextBlock: Record<string, unknown>;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "write-plugin-file";
      readonly target: string;
      readonly content: string;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "patch-opencode-plugins";
      readonly target: string;
      readonly pluginEntry: string;
      readonly desiredPresent: boolean;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "patch-opencode-permission";
      readonly target: string;
      readonly permissionKey: string;
      readonly desiredAction: "allow" | "ask" | "deny" | undefined;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "prune-plugin-path";
      readonly target: string;
      readonly targetType: "file" | "dir";
      readonly reason: "stale";
    };

// ---------------------------------------------------------------------------
// Agent markdown
// ---------------------------------------------------------------------------

interface SyntheticToolInventory {
  /** All generated/assigned tool names across every agent. */
  readonly allToolNames: ReadonlyArray<string>;
  /** Tool names owned by each agent. */
  readonly byAgent: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Synthetic tool names are `<source-plugin>_<contract>`.
 * Permission-only tool names are `<tool-owner-plugin>_<tool>`.
 *
 * The plugin namespace keeps independently generated OpenCode plugins from
 * colliding inside the harness-global tool registry. Synthetic contract names
 * are derived from filled slot schema symbols, so two agents that share one
 * schema share one harness-visible tool instead of duplicating an identical
 * surface.
 */
const buildInventory = (
  sourcePluginName: string,
  agents: ReadonlyArray<ComposedAgent>,
  extraToolNames: ReadonlyArray<string> = [],
): SyntheticToolInventory => {
  const byAgent = new Map<string, string[]>();
  const all = new Set<string>(extraToolNames);
  for (const agent of agents) {
    const own: string[] = [];
    for (const binding of agent.toolBindings) {
      const toolName = runtimeToolName(sourcePluginName, binding);
      own.push(toolName);
      all.add(toolName);
      if (binding.kind === "synthetic") {
        all.add(ownerToolName(binding.toolPluginName, binding.toolName));
      }
    }
    byAgent.set(agent.name, own);
  }
  return {
    allToolNames: [...all].sort((left, right) => left.localeCompare(right)),
    byAgent,
  };
};

const serializeFrontmatter = (
  fm: Record<string, string>,
  permissions: Record<string, PermissionValue>
): string => {
  const formatKey = (key: string): string => {
    if (key === "*" || key.includes(":") || key.includes("#") || key.includes('"')) {
      return JSON.stringify(key);
    }
    return key;
  };

  const keys = Object.keys(fm);
  const lines = ["---"];
  for (const key of keys) {
    const value = fm[key];
    if (value === undefined) continue;
    if (value.includes(":") || value.includes("#") || value.includes('"')) {
      const escaped = value.replace(/"/g, '\\"');
      lines.push(`${key}: "${escaped}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  const permissionKeys = Object.keys(permissions).sort();
  if (permissionKeys.length > 0) {
    lines.push("permission:");
    for (const key of permissionKeys) {
      const value = permissions[key];
      if (!value) continue;
      if (typeof value === "string") {
        lines.push(`  ${formatKey(key)}: ${value}`);
        continue;
      }
      lines.push(`  ${formatKey(key)}:`);
      for (const pattern of Object.keys(value).sort()) {
        const action = value[pattern];
        if (!action) continue;
        lines.push(`    ${formatKey(pattern)}: ${action}`);
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
};

const renderAgentMarkdown = (
  agent: ComposedAgent,
  inventory: SyntheticToolInventory
): string => {
  const own = new Set([
    ...(inventory.byAgent.get(agent.name) ?? []),
    ...agent.allowedTools,
  ]);
  const permissions: Record<string, PermissionValue> = {};
  for (const tool of new Set([...inventory.allToolNames, ...agent.allowedTools])) {
    permissions[tool] = own.has(tool) ? "allow" : "deny";
  }
  permissions.skill = {
    "*": "deny",
    ...Object.fromEntries(agent.allowedSkills.map((skill) => [skill, "allow"] as const)),
  };
  const frontmatter = serializeFrontmatter(
    { name: agent.name, description: agent.description },
    permissions
  );
  return `${frontmatter}\n\n${agent.body}\n`;
};

// ---------------------------------------------------------------------------
// opencode.json patching
// ---------------------------------------------------------------------------

const composeAgentBlock = (
  agent: ComposedAgent,
  existing: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};

  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!(COMPILER_OWNED_KEYS as readonly string[]).includes(key)) {
        next[key] = value;
      }
    }
  }

  if (agent.model) {
    for (const [key, value] of Object.entries(agent.model)) {
      if ((COMPILER_OWNED_KEYS as readonly string[]).includes(key)) {
        next[key] = value;
      }
    }
  }

  if (agent.color) {
    next.color = agent.color;
  }

  const override = agent.targetOverride.opencode as
    | Record<string, unknown>
    | undefined;
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      next[key] = value;
    }
  }

  return next;
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao).sort();
  const keysB = Object.keys(bo).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every((k) => deepEqual(ao[k], bo[k]));
};

const readJson = async <T>(path: string): Promise<T> => {
  return Bun.file(path).json() as Promise<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getPermissionBlock = (
  config: Record<string, unknown>,
): Record<string, unknown> =>
  isRecord(config.permission) ? config.permission : {};

const permissionPatchReason = (
  config: Record<string, unknown>,
  permissionKey: string,
  desiredAction: "allow" | "ask" | "deny" | undefined,
): "new" | "changed" | "unchanged" => {
  const permissions = getPermissionBlock(config);
  const hasKey = Object.prototype.hasOwnProperty.call(permissions, permissionKey);

  if (desiredAction === undefined) {
    return hasKey ? "changed" : "unchanged";
  }

  if (!hasKey) return "new";
  return permissions[permissionKey] === desiredAction ? "unchanged" : "changed";
};

const normalizePermissionBlockForWrite = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  if (isRecord(config.permission)) {
    return { ...config.permission };
  }
  if (
    config.permission === "allow" ||
    config.permission === "ask" ||
    config.permission === "deny"
  ) {
    return { "*": config.permission };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Orbit skill rendering
// ---------------------------------------------------------------------------

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  prismOwnerMarker("orbit-skill", sourcePluginName);

const isOwnedOrbitSkill = (
  content: string,
  sourcePluginName: string
): boolean => content.includes(orbitSkillOwnerMarker(sourcePluginName));

// ---------------------------------------------------------------------------
// Generated plugin emission
//
// Layout:
//   prism-generated-<source-plugin>/
//   └── dist/server.mjs                        (bundled native plugin)
// ---------------------------------------------------------------------------

interface PluginMirror {
  readonly pluginName: string;
  readonly pluginRoot?: string;
  readonly files: ReadonlyArray<MirrorFile>;
}

interface MirrorFile {
  readonly relativePath: string;
  readonly sourcePath?: string;
  readonly content?: string;
}

type AdapterSpec =
  | {
      readonly kind: "tool";
      readonly pluginName: string;
      readonly toolName: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "synthetic";
      readonly pluginName: string;
      readonly contractName: string;
      /**
       * Path to the contract file relative to the generated plugin's
       * src/plugins/<pluginName>/ mirror — i.e. always starts with "contracts/".
       */
      readonly contractRelativePath: string;
    };

interface PluginTree {
  readonly files: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
}

const isRuntimeManagedPluginPath = (_relativePath: string): boolean => false;

const collectPluginTree = async (root: string): Promise<PluginTree> => {
  if (!(await fileExists(root))) {
    return { files: [], dirs: [] };
  }

  const fs = await import("node:fs/promises");
  const files: string[] = [];
  const dirs: string[] = [];

  const walk = async (dir: string, prefix = ""): Promise<void> => {
    let entries: Array<{ readonly name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isRuntimeManagedPluginPath(relativePath)) continue;

      if (entry.isDirectory()) {
        dirs.push(relativePath);
        await walk(join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  };

  await walk(root);
  return { files, dirs };
};

const collectDesiredPluginDirs = (
  desiredFiles: ReadonlySet<string>
): Set<string> => {
  const dirs = new Set<string>();
  for (const file of desiredFiles) {
    const segments = file.split("/");
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current = current ? `${current}/${segments[i]}` : segments[i]!;
      dirs.add(current);
    }
  }
  return dirs;
};

const relativePathDepth = (relativePath: string): number =>
  relativePath.split("/").length;

const planPluginPruning = async (
  root: string,
  desiredFiles: ReadonlySet<string>
): Promise<LowerOperation[]> => {
  if (desiredFiles.size === 0) {
    if (!(await fileExists(root))) return [];
    return [
      {
        kind: "prune-plugin-path",
        target: root,
        targetType: "dir",
        reason: "stale",
      },
    ];
  }

  const existing = await collectPluginTree(root);
  const desiredDirs = collectDesiredPluginDirs(desiredFiles);
  const operations: LowerOperation[] = [];

  for (const relativePath of existing.files) {
    if (desiredFiles.has(relativePath)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: join(root, relativePath),
      targetType: "file",
      reason: "stale",
    });
  }

  const staleDirs = [...existing.dirs]
    .filter((relativePath) => !desiredDirs.has(relativePath))
    .sort(
      (a, b) =>
        relativePathDepth(b) - relativePathDepth(a) || b.localeCompare(a)
    );

  for (const relativePath of staleDirs) {
    operations.push({
      kind: "prune-plugin-path",
      target: join(root, relativePath),
      targetType: "dir",
      reason: "stale",
    });
  }

  return operations;
};

const planOrbitSkillPruning = async (
  target: OpenCodeLowerTarget,
  desiredSkillFiles: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const skillsRoot = join(target.root, "skills");
  if (!(await fileExists(skillsRoot))) {
    return operations;
  }

  const existingSkillFiles = await listDirRecursive(skillsRoot);
  for (const relativePath of existingSkillFiles) {
    const rootRelativePath = `skills/${relativePath}`;
    if (desiredSkillFiles.has(rootRelativePath)) continue;

    const absolutePath = join(skillsRoot, relativePath);
    const current = await readFile(absolutePath);
    if (!isOwnedOrbitSkill(current, target.sourcePluginName)) continue;

    operations.push({
      kind: "prune-plugin-path",
      target: absolutePath,
      targetType: "file",
      reason: "stale",
    });

    const skillDir = dirname(absolutePath);
    const remainingFiles = await listDirRecursive(skillDir);
    if (remainingFiles.length === 1 && remainingFiles[0] === "SKILL.md") {
      operations.push({
        kind: "prune-plugin-path",
        target: skillDir,
        targetType: "dir",
        reason: "stale",
      });
    }
  }

  return operations;
};

const normalizeRelativePath = (path: string): string => path.replace(/\\/g, "/");

const resolveMirrorImport = async (options: {
  readonly pluginRoot: string;
  readonly file: MirrorFile;
  readonly specifier: string;
}): Promise<MirrorFile | undefined> => {
  const basePath = options.file.sourcePath
    ? dirname(options.file.sourcePath)
    : dirname(join(options.pluginRoot, options.file.relativePath));
  const resolved = await resolveTsImportCandidate(resolve(basePath, options.specifier), fileExists);
  if (!resolved || !sourceIsInside(resolved, options.pluginRoot)) {
    return undefined;
  }

  return {
    relativePath: normalizeRelativePath(relative(options.pluginRoot, resolved)),
    sourcePath: resolved,
  };
};

const collectMirrorRuntimeClosure = async (
  pluginRoot: string,
  entries: ReadonlyArray<MirrorFile>,
): Promise<MirrorFile[]> => {
  const files = new Map<string, MirrorFile>();
  const queue: MirrorFile[] = [...entries];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file.relativePath)) continue;
    files.set(file.relativePath, file);

    const source = file.content ?? (file.sourcePath ? await readFile(file.sourcePath) : "");
    for (const specifier of collectRelativeImportSpecifiers(source)) {
      const imported = await resolveMirrorImport({ pluginRoot, file, specifier });
      if (!imported || files.has(imported.relativePath)) continue;
      queue.push(imported);
    }
  }

  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
};

const collectTsFilesInSubdirs = async (
  pluginRoot: string,
  subdirs: ReadonlyArray<string>,
): Promise<MirrorFile[]> => {
  const files: MirrorFile[] = [];
  for (const subdir of subdirs) {
    const subRoot = join(pluginRoot, subdir);
    const entries = await listDirRecursive(subRoot);
    for (const relativeEntry of entries) {
      if (!relativeEntry.endsWith(".ts")) continue;
      files.push({
        relativePath: `${subdir}/${relativeEntry}`,
        sourcePath: join(subRoot, relativeEntry),
      });
    }
  }
  return files;
};

const planPluginMirrors = async (
  sourcePluginName: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
  hookRegistrations: ReadonlyArray<HookRegistration> = [],
  sourcePluginRoot?: string,
): Promise<PluginMirror[]> => {
  const byPlugin = new Map<string, { pluginRoot: string }>();
  const generatedFiles = new Map<string, Map<string, string>>();
  const entryFiles = new Map<string, Map<string, MirrorFile>>();

  const addEntryFile = (pluginName: string, file: MirrorFile): void => {
    const pluginFiles = entryFiles.get(pluginName) ?? new Map<string, MirrorFile>();
    pluginFiles.set(file.relativePath, file);
    entryFiles.set(pluginName, pluginFiles);
  };

  const contracts = bindings
    .map((binding) => binding.contract)
    .filter((contract): contract is Contract => contract !== undefined);
  for (const contract of contracts) {
    if (contract.generatedFiles && contract.generatedFiles.length > 0) {
      const pluginFiles = generatedFiles.get(contract.pluginName) ?? new Map<string, string>();
      for (const file of contract.generatedFiles) {
        const existing = pluginFiles.get(file.relativePath);
        if (existing && existing !== file.content) {
          throw new Error(
            `generated contract name collision at ${contract.pluginName}:${file.relativePath}`,
          );
        }
        pluginFiles.set(file.relativePath, file.content);
      }
      generatedFiles.set(contract.pluginName, pluginFiles);
    }

    if (!byPlugin.has(contract.pluginName)) {
      // Prefer the host plugin's root when the contract is attributed to it.
      // contract.sourcePath traces back to the trait file's location, which
      // may live in a *different* plugin from the contract's owning plugin
      // (e.g. cross-plugin trait + slot binding). Using contract.sourcePath
      // unconditionally would map the host plugin to the trait plugin's root.
      const pluginRoot =
        contract.pluginName === sourcePluginName && sourcePluginRoot
          ? sourcePluginRoot
          : dirname(dirname(contract.sourcePath));
      byPlugin.set(contract.pluginName, { pluginRoot });
    }
  }

    for (const binding of bindings) {
      if (binding.kind === "synthetic") {
        if (!binding.contract) {
          throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
        }
        if (binding.toolPluginName === binding.contract.pluginName) {
          addEntryFile(binding.contract.pluginName, {
            relativePath: `tools/${binding.toolName}.tool.ts`,
            sourcePath: binding.toolSourcePath,
          });
        }
        continue;
      }
    if (binding.toolPluginName !== sourcePluginName) {
      continue;
    }
    if (!byPlugin.has(binding.toolPluginName)) {
      const toolsDir = dirname(binding.toolSourcePath);
      const pluginRoot = dirname(toolsDir);
      byPlugin.set(binding.toolPluginName, { pluginRoot });
    }
    addEntryFile(binding.toolPluginName, {
      relativePath: `tools/${binding.toolName}.tool.ts`,
      sourcePath: binding.toolSourcePath,
    });
  }

  if (hookRegistrations.length > 0 && sourcePluginRoot) {
    if (!byPlugin.has(sourcePluginName)) byPlugin.set(sourcePluginName, { pluginRoot: sourcePluginRoot });
    for (const registration of hookRegistrations) {
      addEntryFile(sourcePluginName, {
        relativePath: relative(sourcePluginRoot, registration.hook.sourcePath).replace(/\\/g, "/"),
        sourcePath: registration.hook.sourcePath,
      });
    }
  }

  const mirrors: PluginMirror[] = [];
  for (const [pluginName, { pluginRoot }] of byPlugin) {
    const files = new Map(entryFiles.get(pluginName) ?? []);
    const generated = generatedFiles.get(pluginName);
    if (generated) {
      for (const [relativePath, content] of generated) {
        files.set(relativePath, { relativePath, content });
      }
    }
    mirrors.push({
      pluginName,
      pluginRoot,
      files: await collectMirrorRuntimeClosure(pluginRoot, [...files.values()]),
    });
  }

  for (const [pluginName, files] of generatedFiles) {
    if (mirrors.some((mirror) => mirror.pluginName === pluginName)) continue;
    mirrors.push({
      pluginName,
      files: [...files.entries()].map(([relativePath, content]) => ({
        relativePath,
        content,
      })),
    });
  }

  return mirrors;
};

const planAdaptersForBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
): AdapterSpec[] => {
  const seen = new Set<string>();
  const specs: AdapterSpec[] = [];
  for (const binding of bindings) {
    if (binding.kind === "permission" && binding.toolPluginName !== sourcePluginName) {
      continue;
    }
    const key = binding.kind === "permission"
      ? `tool/${binding.toolPluginName}/${binding.toolName}`
      : `synthetic/${binding.contract!.pluginName}/${binding.contract!.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (binding.kind === "permission") {
      specs.push({
        kind: "tool",
        pluginName: binding.toolPluginName,
        toolName: binding.toolName,
        sourcePath: binding.toolSourcePath,
      });
    } else {
      specs.push({
        kind: "synthetic",
        pluginName: binding.contract!.pluginName,
        contractName: binding.contract!.name,
        contractRelativePath: `contracts/${binding.contract!.name}.contract`,
      });
    }
  }
  return specs;
};

const normalizeMirroredPluginSource = async (
  options: {
    readonly pluginName: string;
    readonly pluginRoot?: string;
    readonly relativePath: string;
    readonly sourcePath?: string;
    readonly source: string;
    readonly importPluginRoots: ReadonlyMap<string, string>;
  },
): Promise<string> => {
  const currentGeneratedPath = `plugins/${options.pluginName}/${options.relativePath}`;
  const withRewrittenImports = rewriteCrossPluginRelativeImports({
    pluginName: options.pluginName,
    pluginRoot: options.pluginRoot,
    sourcePath: options.sourcePath,
    source: options.source,
    currentGeneratedPath,
    importPluginRoots: options.importPluginRoots,
  });

  const withStandaloneImports = rewriteGeneratedPluginBundleImports(
    withRewrittenImports,
    currentGeneratedPath,
  );
  const withBundledEffectImports = rewriteBareEffectImportsForBundle(withStandaloneImports);
  const withPluginDependencyImports = await rewriteBarePluginDependencyImportsForBundle({
    source: withBundledEffectImports,
    pluginRoot: options.pluginRoot,
  });

  if (!options.relativePath.endsWith(".tool.ts")) {
    return options.relativePath.endsWith(".hook.ts")
      ? rewriteHookAuthoringImports(
          withPluginDependencyImports,
          hookAuthoringBridgeImportFor(currentGeneratedPath),
        )
      : withPluginDependencyImports;
  }

  return stripToolAuthoringHelpers(withPluginDependencyImports)
    .replace(/\bdefineTool\s*\(/g, "(")
    .replace(/\bschemaSlot\s*\(/g, "(");
};

const findSourcePlugin = (
  sourcePath: string,
  pluginRoots: ReadonlyMap<string, string>,
): { pluginName: string; pluginRoot: string } | undefined => {
  const matches = [...pluginRoots.entries()]
    .filter(([, pluginRoot]) => sourceIsInside(sourcePath, pluginRoot))
    .sort((left, right) => right[1].length - left[1].length);
  const first = matches[0];
  if (!first) return undefined;
  return { pluginName: first[0], pluginRoot: first[1] };
};

const rewriteCrossPluginRelativeImports = (options: {
  readonly pluginName: string;
  readonly pluginRoot?: string;
  readonly sourcePath?: string;
  readonly source: string;
  readonly currentGeneratedPath: string;
  readonly importPluginRoots: ReadonlyMap<string, string>;
}): string => {
  if (!options.sourcePath || !options.pluginRoot) return options.source;

  return options.source.replace(
    /(\bfrom\s+)(["'])(\.[^"']+)\2/g,
    (match, prefix: string, quote: string, specifier: string) => {
      const importedSourcePath = resolveImportedSourcePath(options.sourcePath!, specifier);
      const owner = findSourcePlugin(importedSourcePath, options.importPluginRoots);
      if (!owner || owner.pluginName === options.pluginName) return match;

      const modulePath = normalizeRelativePath(
        relative(owner.pluginRoot, importedSourcePath),
      ).replace(/\.ts$/u, "");
      const targetGeneratedPath = `plugins/${owner.pluginName}/${modulePath}`;
      return `${prefix}${quote}${relativeModulePath(
        options.currentGeneratedPath,
        targetGeneratedPath,
      )}${quote}`;
    },
  );
};

const hookAuthoringBridgeImportFor = (currentGeneratedPath: string): string =>
  relativeModulePath(currentGeneratedPath, "runtime/hook-authoring-bridge");

const rewriteHookAuthoringImports = (
  source: string,
  bridgeImport: string,
): string => {
  const helperNames = new Set(["defineHook", "hookEvent", "hookTool", "hookMatcher", "toolRef"]);
  return source.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+(["'][^"']+["']);\s*\n/gm,
    (match, specifiers: string, originalSource: string) => {
      const parsed = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .map((specifier) => ({
          raw: specifier,
          importedName: specifier.replace(/\s+as\s+.*$/u, "").trim(),
        }));
      const helpers = parsed.filter((specifier) => helperNames.has(specifier.importedName));
      if (helpers.length === 0) return match;
      const kept = parsed.filter((specifier) => !helperNames.has(specifier.importedName));
      const replacement = `import { ${helpers.map((specifier) => specifier.raw).join(", ")} } from ${JSON.stringify(bridgeImport)};\n`;
      return kept.length > 0
        ? `import { ${kept.map((specifier) => specifier.raw).join(", ")} } from ${originalSource};\n${replacement}`
        : replacement;
    },
  );
};

const GENERATED_HOOK_AUTHORING_BRIDGE = `// GENERATED by prism — do not edit.\nexport const defineHook = (hook) => hook;\nexport const hookEvent = {\n  toolBefore: "tool.before",\n  toolAfter: "tool.after",\n  sessionStart: "session.start",\n  sessionEnd: "session.end",\n};\nexport const toolRef = (first, second, third) => third === undefined\n  ? { kind: "tool-ref", toolspace: first, name: second }\n  : { kind: "tool-ref", plugin: first, toolspace: second, name: third };\nexport const hookTool = {\n  any: () => ({ kind: "hook-any-tool" }),\n  tool: (tool) => ({ kind: "hook-toolspace-tool", tool }),\n  group: (group) => ({ kind: "hook-toolspace-group", group }),\n  canonical: (ref) => ({ kind: "hook-canonical-tool", ref }),\n};\nexport const hookMatcher = { tool: hookTool };\n`;

const GENERATED_HOOK_RUNTIME = `// GENERATED by prism — do not edit.\nconst right = (value) => ({ _tag: "Right", right: value });\nconst left = (message) => ({ _tag: "Left", left: message });\nconst isObject = (value) => value !== null && typeof value === "object";\nconst decodeTarget = (payload) => isObject(payload?.target) && typeof payload.target.harness === "string" && typeof payload.target.nativeEvent === "string"\n  ? payload.target\n  : undefined;\nconst decodeSession = (payload) => payload?.session === undefined || isObject(payload.session)\n  ? payload.session\n  : undefined;\nexport const decodeNativeHookPayloadForEvent = (event, payload) => {\n  if (!isObject(payload)) return left("native hook payload must be an object");\n  const target = decodeTarget(payload);\n  if (!target) return left("native hook payload target is invalid");\n  const session = decodeSession(payload);\n  if (payload.session !== undefined && !session) return left("native hook payload session is invalid");\n  if (event === "tool.before") {\n    if (!isObject(payload.tool) || typeof payload.tool.name !== "string") return left("tool.before payload tool is invalid");\n    return right({ event, target, cwd: payload.cwd, session, tool: { logical: payload.tool.logical, nativeName: payload.tool.name, input: payload.tool.input } });\n  }\n  if (event === "tool.after") {\n    if (!isObject(payload.tool) || typeof payload.tool.name !== "string") return left("tool.after payload tool is invalid");\n    return right({ event, target, cwd: payload.cwd, session, tool: { logical: payload.tool.logical, nativeName: payload.tool.name, input: payload.tool.input, output: payload.tool.output, success: payload.tool.success } });\n  }\n  if (event === "session.start") {\n    if (!isObject(session)) return left("session.start payload session is invalid");\n    return right({ event, target, cwd: payload.cwd, session });\n  }\n  if (event === "session.end") {\n    if (!isObject(session)) return left("session.end payload session is invalid");\n    return right({ event, target, cwd: payload.cwd, session, reason: payload.reason });\n  }\n  return left("unknown hook event");\n};\nexport const decodeHookResultForEvent = (event, result) => {\n  if (!isObject(result)) return left("hook result must be an object");\n  if (event === "tool.before" && result.decision === "block" && typeof result.message === "string") return right(result);\n  if (result.decision === "continue") return right({ decision: "continue" });\n  return left("invalid hook result for " + event);\n};\n`;

const renderToolAdapter = (
  spec: AdapterSpec,
): string => {
  // adapter is at: src/adapters/<pluginName>/<name>.adapter.ts
  // synthetic contract is at: src/plugins/<pluginName>/contracts/<name>.contract.ts
  // owner tool is at: src/plugins/<pluginName>/tools/<toolName>.tool.ts
  // bridge is at:   src/runtime/schema-bridge.ts
  const surfaceImport =
    spec.kind === "synthetic"
      ? `../../plugins/${spec.pluginName}/${spec.contractRelativePath}`
      : `../../plugins/${spec.pluginName}/tools/${spec.toolName}.tool`;
  const bridgeImport = `../../runtime/schema-bridge`;
  const lines: string[] = [];
  lines.push(`// GENERATED by prism — do not edit.`);
  lines.push(
    spec.kind === "synthetic"
      ? `// Adapter for synthetic tool '${spec.pluginName}:${spec.contractName}'.`
      : `// Adapter for tool '${spec.pluginName}:${spec.toolName}'.`,
  );
  lines.push("");
  lines.push(`import { tool, type ToolContext } from "@opencode-ai/plugin";`);
  if (spec.kind === "synthetic") {
    lines.push(`import * as surface from "${surfaceImport}";`);
  } else {
    lines.push(`import surface from "${surfaceImport}";`);
  }
  lines.push(
    `import { toolArgsFromSchema, decodeInput, type ToolRuntimeContext } from "${bridgeImport}";`,
  );
  lines.push("");
  lines.push(`type SyntheticToolExecuteContext = ToolContext & {`);
  lines.push(`  sessionTitle?: ToolRuntimeContext["sessionTitle"];`);
  lines.push(`  durationMs?: ToolRuntimeContext["durationMs"];`);
  lines.push(`  cost?: ToolRuntimeContext["cost"];`);
  lines.push(`  workingDirectory?: ToolRuntimeContext["workingDirectory"];`);
  lines.push(`  repoRoot?: ToolRuntimeContext["repoRoot"];`);
  lines.push(`};`);
  lines.push("");
  lines.push(`export default tool({`);
  lines.push(`  description: (surface as any).description ?? "",`);
  lines.push(`  args: toolArgsFromSchema((surface as any).Input ?? (surface as any).input),`);
  lines.push(`  async execute(rawArgs, context) {`);
  lines.push(
    `    const input = decodeInput((surface as any).Input ?? (surface as any).input, rawArgs);`,
  );
  lines.push(`    const toolContext = context as SyntheticToolExecuteContext;`);
  lines.push(`    const runtimeContext: ToolRuntimeContext = {`);
  lines.push(`      sessionID: context.sessionID,`);
  lines.push(`      agent: context.agent,`);
  lines.push(`      timestamp: new Date().toISOString(),`);
  lines.push(`      sessionTitle: toolContext.sessionTitle,`);
  lines.push(`      durationMs: toolContext.durationMs,`);
  lines.push(`      cost: toolContext.cost,`);
  lines.push(`      workingDirectory: toolContext.workingDirectory ?? context.directory,`);
  lines.push(`      repoRoot: toolContext.repoRoot ?? context.worktree,`);
  lines.push(`    };`);
  lines.push(`    const output = await (surface as any).handle(input, runtimeContext);`);
  lines.push(`    return JSON.stringify(output, null, 2);`);
  lines.push(`  },`);
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
};

type OpenCodeNativeHookEvent =
  | "tool.execute.before"
  | "tool.execute.after"
  | "session.status";

interface HookRegistration {
  readonly hook: Hook;
  readonly hookPluginName: string;
  readonly hookPluginRoot: string;
  readonly nativeEvent: OpenCodeNativeHookEvent;
  readonly matcher?: ResolvedHookMatch;
}

const opencodeNativeHookEvent = (event: Hook["event"]): OpenCodeNativeHookEvent =>
  nativeHookEventName<OpenCodeNativeHookEvent>(event, {
    toolBefore: "tool.execute.before",
    toolAfter: "tool.execute.after",
    sessionStart: "session.status",
    sessionEnd: "session.status",
  });

const renderHookMatcher = (registration: HookRegistration, sourcePluginName: string): string => {
  const tool = registration.matcher?.tool;
  if (!tool || tool.kind === "any") return "true";
  if (tool.kind === "native-tools") return `new Set(${JSON.stringify(tool.names)}).has(toolName)`;
  return `toolName === ${JSON.stringify(ownerToolName(sourcePluginName, tool.ref))}`;
};

const hookIdentifier = (hook: Hook, index: number): string =>
  `hook_${index}_${hook.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

const renderOpenCodeHookRuntime = (registrations: ReadonlyArray<HookRegistration>): string[] => {
  if (registrations.length === 0) return [];
  const lines: string[] = [];
  lines.push(`const unwrapDecode = (decoded: any, label: string) => {`);
  lines.push(`  if (decoded && decoded._tag === "Right") return decoded.right;`);
  lines.push(`  throw new Error("prism hook " + label + " validation failed");`);
  lines.push(`};`);
  lines.push(`const toPromise = (value: any) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);`);
  lines.push(`const handlePrismHook = async (hook: any, event: any, nativePayload: any) => {`);
  lines.push(`  const payload = unwrapDecode(decodeNativeHookPayloadForEvent(event, nativePayload), "native payload");`);
  lines.push(`  const raw = await toPromise(hook.handle(payload));`);
  lines.push(`  const decoded = decodeHookResultForEvent(event, raw ?? { decision: "continue" });`);
  lines.push(`  const result = unwrapDecode(decoded, "result");`);
  lines.push(`  if (event === "tool.before" && result.decision === "block") throw new Error(result.message);`);
  lines.push(`};`);
  return lines;
};

const renderOpenCodeHookHandlers = (registrations: ReadonlyArray<HookRegistration>): string[] => {
  const before = registrations.filter((registration) => registration.nativeEvent === "tool.execute.before");
  const after = registrations.filter((registration) => registration.nativeEvent === "tool.execute.after");
  const sessionStart = registrations.filter(
    (registration) =>
      registration.nativeEvent === "session.status" && registration.hook.event === "session.start",
  );
  const sessionEnd = registrations.filter(
    (registration) =>
      registration.nativeEvent === "session.status" && registration.hook.event === "session.end",
  );
  const lines: string[] = [];
  if (before.length > 0) {
    lines.push(`  "tool.execute.before": async (input, output) => {`);
    lines.push(`    const toolName = String(input.tool ?? "");`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "tool.execute.before" }, tool: { name: toolName, input: output.args }, cwd: context.directory, session: { id: input.sessionID } };`);
    before.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    if (${renderHookMatcher(registration, registration.hookPluginName)}) await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "tool.before", nativePayload);`);
    });
    lines.push(`  },`);
  }
  if (after.length > 0) {
    lines.push(`  "tool.execute.after": async (input, output) => {`);
    lines.push(`    const toolName = String(input.tool ?? "");`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "tool.execute.after" }, tool: { name: toolName, input: input.args, output: output.output, success: output.metadata?.success }, cwd: context.directory, session: { id: input.sessionID } };`);
    after.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    if (${renderHookMatcher(registration, registration.hookPluginName)}) await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "tool.after", nativePayload);`);
    });
    lines.push(`  },`);
  }
  if (sessionStart.length > 0 || sessionEnd.length > 0) {
    lines.push(`  event: async ({ event }) => {`);
    lines.push(`    const eventType = String(event.type ?? "");`);
    lines.push(`    const properties = event.properties ?? {};`);
    if (sessionStart.length > 0) {
      lines.push(`    if (eventType === "session.status" && properties.status?.type === "busy") {`);
      lines.push(`      const nativePayload = { target: { harness: "opencode", nativeEvent: "session.status" }, cwd: context.directory, session: { id: String(properties.sessionID ?? "opencode") } };`);
      sessionStart.forEach((registration) => {
        const registrationIndex = registrations.indexOf(registration);
        lines.push(`      await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "session.start", nativePayload);`);
      });
      lines.push(`    }`);
    }
    if (sessionEnd.length > 0) {
      lines.push(`    if ((eventType === "session.status" && properties.status?.type === "idle") || eventType === "session.idle") {`);
      lines.push(`      const nativePayload = { target: { harness: "opencode", nativeEvent: eventType }, cwd: context.directory, session: { id: String(properties.sessionID ?? "opencode") } };`);
      sessionEnd.forEach((registration) => {
        const registrationIndex = registrations.indexOf(registration);
        lines.push(`      await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "session.end", nativePayload);`);
      });
      lines.push(`    }`);
    }
    lines.push(`  },`);
  }
  return lines;
};

const renderGeneratedServerTsForBindings = (
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
  sourcePluginName: string,
  pluginId: string,
  adapters: ReadonlyArray<AdapterSpec>,
  hookRegistrations: ReadonlyArray<HookRegistration>,
): string => {
  const importEntries = adapters.map((a, idx) => {
    const name = a.kind === "synthetic" ? a.contractName : a.toolName;
    const ident = `adapter_${idx}_${a.pluginName.replace(/[^a-zA-Z0-9_]/g, "_")}_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const importPath = `./adapters/${a.pluginName}/${name}.adapter`;
    return { ident, importPath, spec: a };
  });

  const toolEntries: string[] = [];
  const emittedToolNames = new Set<string>();
  for (const binding of bindings) {
    const toolName = runtimeToolName(sourcePluginName, binding);
    const entry = importEntries.find((e) => {
      if (binding.kind === "permission") {
        return (
          e.spec.kind === "tool" &&
          e.spec.pluginName === binding.toolPluginName &&
          e.spec.toolName === binding.toolName
        );
      }
      return (
        e.spec.kind === "synthetic" &&
        e.spec.pluginName === binding.contract!.pluginName &&
        e.spec.contractName === binding.contract!.name
      );
    });
    if (!entry) continue;
    if (emittedToolNames.has(toolName)) continue;
    emittedToolNames.add(toolName);
    toolEntries.push(`    ${JSON.stringify(toolName)}: ${entry.ident},`);
  }

  const lines: string[] = [];
  lines.push("// GENERATED by prism — do not edit.");
  lines.push("// Re-run `prism compile` to regenerate.");
  lines.push("");
  lines.push(
    'import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";',
  );
  if (hookRegistrations.length > 0) {
    lines.push('import { Effect } from "effect";');
    lines.push(`import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from "./runtime/hook-runtime";`);
  }
  for (const e of importEntries) {
    lines.push(`import ${e.ident} from "${e.importPath}";`);
  }
  hookRegistrations.forEach((registration, index) => {
    lines.push(`import ${hookIdentifier(registration.hook, index)} from ${JSON.stringify(`./plugins/${registration.hookPluginName}/${relative(registration.hookPluginRoot, registration.hook.sourcePath).replace(/\\/g, "/").replace(/\.ts$/u, "")}`)};`);
  });
  lines.push("");
  lines.push(...renderOpenCodeHookRuntime(hookRegistrations));
  if (hookRegistrations.length > 0) lines.push("");
  lines.push("const server: Plugin = async (context) => ({");
  lines.push("  tool: {");
  lines.push(...toolEntries);
  lines.push("  },");
  lines.push(...renderOpenCodeHookHandlers(hookRegistrations));
  lines.push("} satisfies Hooks);");
  lines.push("");
  lines.push(
    `export default { id: "${pluginId}", server } satisfies PluginModule;`,
  );
  lines.push("");
  return lines.join("\n");
};

declare const SCHEMA_BRIDGE_SOURCE: string | undefined;

const getSchemaBridgeSource = async (): Promise<string> => {
  if (typeof SCHEMA_BRIDGE_SOURCE === "string") {
    return SCHEMA_BRIDGE_SOURCE;
  }

  const sourcePath = new URL("../runtime/schema-bridge.ts", import.meta.url).pathname;
  return readFile(sourcePath);
};

const pluginRootFromToolSource = (toolSourcePath: string): string =>
  dirname(dirname(toolSourcePath));

const bindingsFromPluginToolFiles = async (
  pluginName: string,
  pluginRoot: string,
): Promise<ReadonlyArray<ComposedAgent["toolBindings"][number]>> => {
  const toolsRoot = join(pluginRoot, "tools");
  const entries = await listDirRecursive(toolsRoot);
  return entries
    .filter((entry) => !entry.includes("/") && entry.endsWith(".tool.ts"))
    .map((entry) => bindingFromToolSource(pluginName, join(toolsRoot, entry)))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
};

const planRuntimePluginMirrors = async (
  pluginName: string,
  pluginRoot: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
): Promise<PluginMirror> => {
  const entries = [
    ...bindings.map((binding): MirrorFile => ({
      sourcePath: binding.toolSourcePath,
      relativePath: `tools/${binding.toolName}.tool.ts`,
    })),
    ...(await collectTsFilesInSubdirs(pluginRoot, ["contracts", "schemas"])),
  ];
  return {
    pluginName,
    pluginRoot,
    files: await collectMirrorRuntimeClosure(pluginRoot, entries),
  };
};

const mergePluginMirrors = (
  mirrors: ReadonlyArray<PluginMirror>,
): PluginMirror[] => {
  const byPlugin = new Map<
    string,
    {
      pluginRoot?: string;
      files: Map<string, MirrorFile>;
    }
  >();

  for (const mirror of mirrors) {
    const current = byPlugin.get(mirror.pluginName) ?? {
      pluginRoot: mirror.pluginRoot,
      files: new Map<string, MirrorFile>(),
    };
    current.pluginRoot ??= mirror.pluginRoot;
    for (const file of mirror.files) {
      current.files.set(file.relativePath, file);
    }
    byPlugin.set(mirror.pluginName, current);
  }

  return [...byPlugin.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginName, mirror]) => ({
      pluginName,
      pluginRoot: mirror.pluginRoot,
      files: [...mirror.files.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      ),
    }));
};

const collectRegistryDependencyPluginRoots = (
  registry: PluginRegistry | undefined,
): Map<string, string> => {
  const roots = new Map<string, string>();
  const visit = (current: PluginRegistry): void => {
    for (const dep of current.deps.values()) {
      if (!roots.has(dep.pluginName)) roots.set(dep.pluginName, dep.pluginPath);
      visit(dep);
    }
  };

  if (registry) visit(registry);
  return roots;
};

const expandBundleMirrors = async (
  mirrors: ReadonlyArray<PluginMirror>,
  importPluginRoots: ReadonlyMap<string, string>,
): Promise<PluginMirror[]> => {
  const existing = new Set(mirrors.map((mirror) => mirror.pluginName));
  const supplemental: PluginMirror[] = [];

  for (const [pluginName, pluginRoot] of [...importPluginRoots.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (existing.has(pluginName)) continue;
    const entries = await collectTsFilesInSubdirs(pluginRoot, ["tools", "contracts", "schemas"]);
    if (entries.length === 0) continue;
    supplemental.push({
      pluginName,
      pluginRoot,
      files: await collectMirrorRuntimeClosure(pluginRoot, entries),
    });
  }

  return mergePluginMirrors([...mirrors, ...supplemental]);
};

const writeTempSource = async (
  tempRoot: string,
  relativePath: string,
  content: string,
): Promise<string> => {
  const target = join(tempRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await nodeWriteFile(target, content);
  return target;
};

const writeTempGeneratedPluginSources = async (options: {
  readonly tempRoot: string;
  readonly pluginId: string;
  readonly runtimeToolNamespace: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>;
  readonly hookRegistrations?: ReadonlyArray<HookRegistration>;
}): Promise<string> => {
  await writeTempSource(
    options.tempRoot,
    "runtime/schema-bridge.ts",
    rewriteGeneratedOpenCodeRuntimeImportsForBundle(await getSchemaBridgeSource()),
  );

  if ((options.hookRegistrations?.length ?? 0) > 0) {
    await writeTempSource(
      options.tempRoot,
      "runtime/hook-authoring-bridge.ts",
      GENERATED_HOOK_AUTHORING_BRIDGE,
    );
    await writeTempSource(
      options.tempRoot,
      "runtime/hook-runtime.ts",
      GENERATED_HOOK_RUNTIME,
    );
  }

  for (const mirror of options.mirrors) {
    for (const file of mirror.files) {
      const raw = file.content ?? (await readFile(file.sourcePath!));
      const normalized = await normalizeMirroredPluginSource({
        pluginName: mirror.pluginName,
        pluginRoot: mirror.pluginRoot,
        relativePath: file.relativePath,
        sourcePath: file.sourcePath,
        source: raw,
        importPluginRoots: options.importPluginRoots,
      });
      await writeTempSource(
        options.tempRoot,
        `plugins/${mirror.pluginName}/${file.relativePath}`,
        normalized,
      );
    }
  }

  for (const spec of options.adapters) {
    const adapterName = spec.kind === "synthetic" ? spec.contractName : spec.toolName;
    await writeTempSource(
      options.tempRoot,
      `adapters/${spec.pluginName}/${adapterName}.adapter.ts`,
      rewriteGeneratedOpenCodeRuntimeImportsForBundle(renderToolAdapter(spec)),
    );
  }

  return writeTempSource(
    options.tempRoot,
    "server.ts",
    rewriteGeneratedOpenCodeRuntimeImportsForBundle(
      renderGeneratedServerTsForBindings(
        options.serverBindings,
        options.runtimeToolNamespace,
        options.pluginId,
        options.adapters,
        options.hookRegistrations ?? [],
      ),
    ),
  );
};

const validateBuiltOpenCodeGeneratedPluginBundle = async (
  builtPath: string,
  pluginId: string,
): Promise<void> => {
  const moduleUrl = `${pathToFileURL(builtPath).href}?prism=${Date.now()}`;
  const loaded = await import(moduleUrl) as { readonly default?: unknown };
  const plugin = loaded.default as { readonly id?: unknown; readonly server?: unknown } | undefined;
  if (!plugin || plugin.id !== pluginId || typeof plugin.server !== "function") {
    throw new Error(
      `built OpenCode plugin bundle '${pluginId}' does not export a valid PluginModule`,
    );
  }
};

const normalizeBuiltOpenCodeGeneratedPluginBundle = (content: string): string =>
  content.replace(/^\/\/ .*prism-opencode-plugin-[^\n]*\n/gm, "");

const buildGeneratedOpenCodePluginBundle = async (options: {
  readonly root: string;
  readonly pluginId: string;
  readonly runtimeToolNamespace: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>;
  readonly hookRegistrations?: ReadonlyArray<HookRegistration>;
}): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-opencode-plugin-"));
  try {
    const mirrors = await expandBundleMirrors(options.mirrors, options.importPluginRoots);
    const entryPath = await writeTempGeneratedPluginSources({
      tempRoot,
      pluginId: options.pluginId,
      runtimeToolNamespace: options.runtimeToolNamespace,
      mirrors,
      importPluginRoots: options.importPluginRoots,
      adapters: options.adapters,
      serverBindings: options.serverBindings,
      hookRegistrations: options.hookRegistrations,
    });
    const outdir = join(tempRoot, "dist");
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir,
      target: "bun",
      format: "esm",
      packages: "bundle",
      external: NODE_BUILTIN_EXTERNALS,
      naming: "server.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new Error(`failed to build OpenCode generated plugin '${options.pluginId}': ${diagnostics}`);
    }

    const builtPath = join(outdir, "server.mjs");
    await validateBuiltOpenCodeGeneratedPluginBundle(builtPath, options.pluginId);
    return normalizeBuiltOpenCodeGeneratedPluginBundle(await readFile(builtPath));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const planGeneratedPluginFiles = async (options: {
  readonly root: string;
  readonly pluginId: string;
  readonly runtimeToolNamespace: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>;
  readonly hookRegistrations?: ReadonlyArray<HookRegistration>;
}): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredPluginFiles = new Set<string>(["dist/server.mjs"]);
  const bundleTarget = join(options.root, "dist", "server.mjs");
  const desiredBundle = await buildGeneratedOpenCodePluginBundle(options);
  let bundleReason: "new" | "changed" | "unchanged";
  if (await fileExists(bundleTarget)) {
    const current = await readFile(bundleTarget);
    bundleReason = current === desiredBundle ? "unchanged" : "changed";
  } else {
    bundleReason = "new";
  }
  operations.push({
    kind: "write-plugin-file",
    target: bundleTarget,
    content: desiredBundle,
    reason: bundleReason,
  });

  operations.push(...(await planPluginPruning(options.root, desiredPluginFiles)));
  return operations;
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools: ReadonlyArray<CanonicalTool>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: OpenCodeLowerTarget;
}

const planOpenCodeHookRegistrations = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
): Promise<ReadonlyArray<HookRegistration>> => {
  if (hooks.length === 0) return [];
  if (!registry) throw new Error("OpenCode hook lowering requires a plugin registry");

  const registrations: HookRegistration[] = [];
  for (const hook of [...hooks].sort((left, right) => left.name.localeCompare(right.name))) {
    const nativeEvent = opencodeNativeHookEvent(hook.event);
    if (!nativeEvent) {
      throw new Error(
        `OpenCode cannot map portable ${hook.event} hook '${hook.name}' to a native plugin hook.`,
      );
    }
    registrations.push({
      hook,
      hookPluginName: registry.pluginName,
      hookPluginRoot: registry.pluginPath,
      nativeEvent,
      matcher: await Effect.runPromise(resolveHookMatchForTarget(hook, registry, "opencode")),
    });
  }
  return registrations;
};

type ToolBinding = ComposedAgent["toolBindings"][number];

interface OwnerRuntimePlugin {
  readonly pluginRoot: string;
  readonly bindings: ReadonlyArray<ToolBinding>;
}

interface OpenCodeRuntimeContext {
  readonly hookRegistrations: ReadonlyArray<HookRegistration>;
  readonly hasAnyHook: boolean;
  readonly referencedBindings: ReadonlyArray<ToolBinding>;
  readonly hasAnyTool: boolean;
  readonly sourceCanonicalToolBindings: ReadonlyArray<ToolBinding>;
  readonly ownerPlugins: ReadonlyMap<string, OwnerRuntimePlugin>;
  readonly inventory: SyntheticToolInventory;
  readonly ownedGeneratedPluginId: string;
  readonly ownedGeneratedPluginEntry: string;
}

interface GeneratedRuntimePluginState {
  readonly desiredGeneratedPluginEntries: Set<string>;
  readonly staleGeneratedPluginEntriesToPrune: Set<string>;
  readonly desiredGeneratedPermissionNamespaces: Set<string>;
  readonly generatedPermissionNamespacesToTouch: Set<string>;
}

const readOpenCodeConfig = async (jsonTarget: string): Promise<Record<string, unknown>> =>
  await fileExists(jsonTarget) ? await readJson<Record<string, unknown>>(jsonTarget) : {};

const collectOwnerRuntimePlugins = async (
  input: LowerInput,
  referencedBindings: ReadonlyArray<ToolBinding>,
): Promise<ReadonlyMap<string, OwnerRuntimePlugin>> => {
  const ownerPluginRoots = new Map<string, string>();
  for (const binding of referencedBindings) {
    if (binding.toolPluginName === input.target.sourcePluginName) continue;
    ownerPluginRoots.set(
      binding.toolPluginName,
      pluginRootFromToolSource(binding.toolSourcePath),
    );
  }

  const ownerPlugins = new Map<string, OwnerRuntimePlugin>();
  for (const [pluginName, pluginRoot] of [...ownerPluginRoots.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    ownerPlugins.set(pluginName, {
      pluginRoot,
      bindings: await bindingsFromPluginToolFiles(pluginName, pluginRoot),
    });
  }
  return ownerPlugins;
};

const collectOpenCodeRuntimeContext = async (
  input: LowerInput,
): Promise<OpenCodeRuntimeContext> => {
  const hookRegistrations = await planOpenCodeHookRegistrations(input.hooks ?? [], input.registry);
  const referencedBindings = input.agents.flatMap((agent) => agent.toolBindings);
  const sourceCanonicalToolBindings = bindingsFromCanonicalTools(
    input.target.sourcePluginName,
    input.tools,
  );
  const ownerPlugins = await collectOwnerRuntimePlugins(input, referencedBindings);
  const generatedOwnerToolNames = [
    ...sourceCanonicalToolBindings.map((binding) =>
      ownerToolName(binding.toolPluginName, binding.toolName),
    ),
    ...[...ownerPlugins.values()].flatMap((owner) =>
      owner.bindings.map((binding) =>
        ownerToolName(binding.toolPluginName, binding.toolName),
      ),
    ),
  ];

  return {
    hookRegistrations,
    hasAnyHook: hookRegistrations.length > 0,
    referencedBindings,
    hasAnyTool: referencedBindings.length > 0,
    sourceCanonicalToolBindings,
    ownerPlugins,
    inventory: buildInventory(
      input.target.sourcePluginName,
      input.agents,
      generatedOwnerToolNames,
    ),
    ownedGeneratedPluginId: generatedPluginId(input.target),
    ownedGeneratedPluginEntry: generatedPluginEntryForName(
      input.target,
      input.target.sourcePluginName,
    ),
  };
};

const planAgentMarkdownWrites = async (
  input: LowerInput,
  inventory: SyntheticToolInventory,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  for (const agent of input.agents) {
    const target = agentMdPath(input.target, agent.name);
    const content = renderAgentMarkdown(agent, inventory);
    operations.push({
      kind: "write-md",
      target,
      content,
      reason: await writeReason(target, content),
    });
  }
  return operations;
};

const planAgentJsonPatches = (
  input: LowerInput,
  jsonTarget: string,
  config: Record<string, unknown>,
): LowerOperation[] => {
  const agentsMap = (config.agent as Record<string, unknown> | undefined) || {};
  return input.agents.map((agent) => {
    const existingBlock = agentsMap[agent.name] as Record<string, unknown> | undefined;
    const nextBlock = composeAgentBlock(agent, existingBlock);
    const reason = !existingBlock
      ? "new"
      : deepEqual(existingBlock, nextBlock)
        ? "unchanged"
        : "changed";
    return {
      kind: "patch-json",
      target: jsonTarget,
      agentName: agent.name,
      nextBlock,
      reason,
    };
  });
};

const planOrbitSkillWrites = async (input: LowerInput): Promise<LowerOperation[]> => {
  const desiredOrbitSkillFiles = new Set<string>();
  const operations: LowerOperation[] = [];

  for (const orbit of input.orbits) {
    const target = orbitSkillMdPath(input.target, orbit.name);
    desiredOrbitSkillFiles.add(orbitSkillRelativePath(orbit.name));
    const content = renderGeneratedOrbitSkill({
      orbit,
      sourcePluginName: input.target.sourcePluginName,
      registry: input.registry,
      ownerKind: "orbit-skill",
      trailingNewline: false,
      renderFrontmatter: (values) => serializeFrontmatter(values, {}),
    });
    operations.push({
      kind: "write-md",
      target,
      content,
      reason: await writeReason(target, content),
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      const referenceRelative = `skills/${orbit.name}/references/${reference.filename}`;
      const referenceTarget = join(input.target.root, referenceRelative);
      desiredOrbitSkillFiles.add(referenceRelative);
      operations.push({
        kind: "write-md",
        target: referenceTarget,
        content: reference.content,
        reason: await writeReason(referenceTarget, reference.content),
      });
    }
  }

  operations.push(
    ...(await planOrbitSkillPruning(input.target, desiredOrbitSkillFiles)),
  );
  return operations;
};

const createGeneratedRuntimePluginState = (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  config: Record<string, unknown>,
): GeneratedRuntimePluginState => {
  const staleGeneratedPluginEntriesToPrune = new Set<string>([
    runtime.ownedGeneratedPluginId,
    staleGeneratedPluginSourceEntryForName(input.target, input.target.sourcePluginName),
  ]);
  for (const pluginEntry of Array.isArray(config.plugin) ? config.plugin : []) {
    if (isStaleGeneratedPluginEntry(pluginEntry, input.target)) {
      staleGeneratedPluginEntriesToPrune.add(pluginEntry);
    }
  }

  return {
    desiredGeneratedPluginEntries: new Set<string>(),
    staleGeneratedPluginEntriesToPrune,
    desiredGeneratedPermissionNamespaces: new Set<string>(),
    generatedPermissionNamespacesToTouch: new Set<string>([
      input.target.sourcePluginName,
    ]),
  };
};

const rememberDesiredGeneratedPlugin = (
  input: LowerInput,
  state: GeneratedRuntimePluginState,
  pluginName: string,
): void => {
  state.desiredGeneratedPluginEntries.add(generatedPluginEntryForName(input.target, pluginName));
  state.staleGeneratedPluginEntriesToPrune.add(generatedPluginIdForName(pluginName));
  state.staleGeneratedPluginEntriesToPrune.add(
    staleGeneratedPluginSourceEntryForName(input.target, pluginName),
  );
  state.desiredGeneratedPermissionNamespaces.add(pluginName);
  state.generatedPermissionNamespacesToTouch.add(pluginName);
};

const collectGeneratedPluginImportRoots = (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  mirrors: ReadonlyArray<PluginMirror>,
  sourceCanonicalMirror?: PluginMirror,
): Map<string, string> => {
  const importPluginRoots = new Map<string, string>();
  for (const mirror of sourceCanonicalMirror
    ? mergePluginMirrors([...mirrors, sourceCanonicalMirror])
    : mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
  }
  for (const [pluginName, owner] of runtime.ownerPlugins) {
    importPluginRoots.set(pluginName, owner.pluginRoot);
  }
  for (const [pluginName, pluginRoot] of collectRegistryDependencyPluginRoots(input.registry)) {
    if (!importPluginRoots.has(pluginName)) importPluginRoots.set(pluginName, pluginRoot);
  }
  return importPluginRoots;
};

const planSourceGeneratedRuntimePlugin = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
  options: {
    readonly mirrors: ReadonlyArray<PluginMirror>;
    readonly sourceCanonicalMirror?: PluginMirror;
    readonly importPluginRoots: ReadonlyMap<string, string>;
    readonly sourceRuntimeBindings: ReadonlyArray<ToolBinding>;
  },
): Promise<LowerOperation[]> => {
  if (options.sourceRuntimeBindings.length > 0 || runtime.hasAnyHook) {
    rememberDesiredGeneratedPlugin(input, state, input.target.sourcePluginName);
    return planGeneratedPluginFiles({
      root: generatedPluginRoot(input.target),
      pluginId: runtime.ownedGeneratedPluginId,
      runtimeToolNamespace: input.target.sourcePluginName,
      mirrors: options.sourceCanonicalMirror
        ? mergePluginMirrors([...options.mirrors, options.sourceCanonicalMirror])
        : options.mirrors,
      importPluginRoots: options.importPluginRoots,
      adapters: planAdaptersForBindings(
        input.target.sourcePluginName,
        options.sourceRuntimeBindings,
      ),
      serverBindings: options.sourceRuntimeBindings,
      hookRegistrations: runtime.hookRegistrations,
    });
  }

  return planPluginPruning(generatedPluginRoot(input.target), new Set<string>());
};

const planOwnerGeneratedRuntimePlugins = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
  importPluginRoots: ReadonlyMap<string, string>,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  for (const [pluginName, owner] of runtime.ownerPlugins) {
    rememberDesiredGeneratedPlugin(input, state, pluginName);
    const ownerMirror = await planRuntimePluginMirrors(
      pluginName,
      owner.pluginRoot,
      owner.bindings,
    );
    operations.push(
      ...(await planGeneratedPluginFiles({
        root: generatedPluginRootForName(input.target, pluginName),
        pluginId: generatedPluginIdForName(pluginName),
        runtimeToolNamespace: pluginName,
        mirrors: [ownerMirror],
        importPluginRoots,
        adapters: planAdaptersForBindings(pluginName, owner.bindings),
        serverBindings: owner.bindings,
        hookRegistrations: [],
      })),
    );
  }
  return operations;
};

const planGeneratedRuntimePlugins = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
): Promise<LowerOperation[]> => {
  if (
    !runtime.hasAnyTool &&
    runtime.sourceCanonicalToolBindings.length === 0 &&
    !runtime.hasAnyHook
  ) {
    return [];
  }

  const mirrors = await planPluginMirrors(
    input.target.sourcePluginName,
    runtime.referencedBindings,
    runtime.hookRegistrations,
    input.registry?.pluginPath,
  );
  const ownedRuntimeBindings = runtime.referencedBindings.filter(
    (binding) =>
      binding.kind === "synthetic" ||
      binding.toolPluginName === input.target.sourcePluginName,
  );
  const sourceRuntimeBindings = [
    ...runtime.sourceCanonicalToolBindings,
    ...ownedRuntimeBindings,
  ];
  const sourceCanonicalMirror =
    runtime.sourceCanonicalToolBindings.length > 0
      ? await planRuntimePluginMirrors(
          input.target.sourcePluginName,
          pluginRootFromToolSource(
            runtime.sourceCanonicalToolBindings[0]!.toolSourcePath,
          ),
          runtime.sourceCanonicalToolBindings,
        )
      : undefined;
  const importPluginRoots = collectGeneratedPluginImportRoots(
    input,
    runtime,
    mirrors,
    sourceCanonicalMirror,
  );

  return [
    ...(await planSourceGeneratedRuntimePlugin(input, runtime, state, {
      mirrors,
      sourceCanonicalMirror,
      importPluginRoots,
      sourceRuntimeBindings,
    })),
    ...(await planOwnerGeneratedRuntimePlugins(input, runtime, state, importPluginRoots)),
  ];
};

const planGeneratedPluginConfigPatches = (
  input: LowerInput,
  jsonTarget: string,
  config: Record<string, unknown>,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
): LowerOperation[] => {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return [...new Set([
    runtime.ownedGeneratedPluginId,
    runtime.ownedGeneratedPluginEntry,
    ...state.desiredGeneratedPluginEntries,
    ...state.staleGeneratedPluginEntriesToPrune,
  ])].map((pluginEntry) => {
    const desiredPresent = state.desiredGeneratedPluginEntries.has(pluginEntry);
    const already = plugins.includes(pluginEntry);
    const reason = desiredPresent
      ? already
        ? "unchanged"
        : "new"
      : already
        ? "changed"
        : "unchanged";
    return {
      kind: "patch-opencode-plugins",
      target: jsonTarget,
      pluginEntry,
      desiredPresent,
      reason,
    };
  });
};

const planGeneratedPermissionPatches = (
  input: LowerInput,
  jsonTarget: string,
  config: Record<string, unknown>,
  state: GeneratedRuntimePluginState,
): LowerOperation[] =>
  [...state.generatedPermissionNamespacesToTouch]
    .sort((left, right) => left.localeCompare(right))
    .map((pluginName) => {
      const desiredAction = state.desiredGeneratedPermissionNamespaces.has(pluginName)
        ? "deny"
        : undefined;
      const permissionKey = generatedToolDenyPatternForName(pluginName);
      return {
        kind: "patch-opencode-permission",
        target: jsonTarget,
        permissionKey,
        desiredAction,
        reason: permissionPatchReason(config, permissionKey, desiredAction),
      };
    });

export const planLowering = async (
  input: LowerInput
): Promise<LowerOperation[]> => {
  const jsonTarget = opencodeJsonPath(input.target);
  const config = await readOpenCodeConfig(jsonTarget);
  const runtime = await collectOpenCodeRuntimeContext(input);
  const generatedRuntimeState = createGeneratedRuntimePluginState(input, runtime, config);

  return [
    ...(await planAgentMarkdownWrites(input, runtime.inventory)),
    ...planAgentJsonPatches(input, jsonTarget, config),
    ...(await planOrbitSkillWrites(input)),
    ...(await planGeneratedRuntimePlugins(input, runtime, generatedRuntimeState)),
    ...planGeneratedPluginConfigPatches(input, jsonTarget, config, runtime, generatedRuntimeState),
    ...planGeneratedPermissionPatches(input, jsonTarget, config, generatedRuntimeState),
  ];
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type OpenCodeJsonPatchOperation = Extract<
  LowerOperation,
  | { readonly kind: "patch-json" }
  | { readonly kind: "patch-opencode-plugins" }
  | { readonly kind: "patch-opencode-permission" }
>;

type ExecuteLoweringOptions = {
  readonly backup: boolean;
  readonly dryRun: boolean;
};

const isOpenCodeJsonPatchOperation = (
  operation: LowerOperation,
): operation is OpenCodeJsonPatchOperation =>
  operation.kind === "patch-json" ||
  operation.kind === "patch-opencode-plugins" ||
  operation.kind === "patch-opencode-permission";

const shouldApplyLowerOperation = (operation: LowerOperation): boolean =>
  operation.reason !== "unchanged";

const collectOpenCodeJsonPatchOperations = (
  operations: ReadonlyArray<LowerOperation>,
): OpenCodeJsonPatchOperation[] =>
  operations.filter(
    (operation): operation is OpenCodeJsonPatchOperation =>
      shouldApplyLowerOperation(operation) && isOpenCodeJsonPatchOperation(operation),
  );

const executeWriteOperation = async (
  operation: Extract<LowerOperation, { readonly kind: "write-md" | "write-plugin-file" }>,
  options: ExecuteLoweringOptions,
  backups: string[],
): Promise<void> => {
  if (options.backup && operation.kind === "write-md") {
    const backup = await backupFile(operation.target);
    if (backup) backups.push(backup);
  }
  await writeFile(operation.target, operation.content);
};

const executePruneOperation = async (
  operation: Extract<LowerOperation, { readonly kind: "prune-plugin-path" }>,
): Promise<void> => {
  if (operation.targetType === "dir") {
    await removeDir(operation.target);
  } else {
    await removeFile(operation.target);
  }
};

const executeNonJsonLoweringOperations = async (
  operations: ReadonlyArray<LowerOperation>,
  options: ExecuteLoweringOptions,
  backups: string[],
): Promise<void> => {
  for (const operation of operations) {
    if (!shouldApplyLowerOperation(operation)) continue;
    if (isOpenCodeJsonPatchOperation(operation)) continue;

    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      await executeWriteOperation(operation, options, backups);
      continue;
    }

    if (operation.kind === "prune-plugin-path") {
      await executePruneOperation(operation);
    }
  }
};

const readOpenCodeConfigForWrite = async (
  jsonTarget: string,
): Promise<Record<string, unknown>> =>
  (await fileExists(jsonTarget)) ? await readJson<Record<string, unknown>>(jsonTarget) : {};

const agentConfigMapForWrite = (
  config: Record<string, unknown>,
): Record<string, unknown> =>
  (config.agent as Record<string, unknown> | undefined) || {};

const applyOpenCodePluginPatch = (
  config: Record<string, unknown>,
  operation: Extract<LowerOperation, { readonly kind: "patch-opencode-plugins" }>,
): void => {
  const hadPluginKey = Object.prototype.hasOwnProperty.call(config, "plugin");
  const plugins = Array.isArray(config.plugin) ? [...(config.plugin as unknown[])] : [];

  if (operation.desiredPresent) {
    if (!plugins.includes(operation.pluginEntry)) {
      plugins.push(operation.pluginEntry);
    }
  } else {
    const nextPlugins = plugins.filter(
      (pluginEntry) => pluginEntry !== operation.pluginEntry,
    );
    plugins.length = 0;
    plugins.push(...nextPlugins);
  }

  if (plugins.length > 0 || hadPluginKey) {
    config.plugin = plugins;
  } else {
    delete config.plugin;
  }
};

const applyOpenCodePermissionPatch = (
  config: Record<string, unknown>,
  operation: Extract<LowerOperation, { readonly kind: "patch-opencode-permission" }>,
): void => {
  const permissions = normalizePermissionBlockForWrite(config);
  if (operation.desiredAction === undefined) {
    delete permissions[operation.permissionKey];
  } else {
    permissions[operation.permissionKey] = operation.desiredAction;
  }

  if (Object.keys(permissions).length > 0) {
    config.permission = permissions;
  } else {
    delete config.permission;
  }
};

const applyOpenCodeJsonPatchOperation = (
  config: Record<string, unknown>,
  agentsMap: Record<string, unknown>,
  operation: OpenCodeJsonPatchOperation,
): void => {
  if (operation.kind === "patch-json") {
    agentsMap[operation.agentName] = operation.nextBlock;
  } else if (operation.kind === "patch-opencode-plugins") {
    applyOpenCodePluginPatch(config, operation);
  } else {
    applyOpenCodePermissionPatch(config, operation);
  }
};

const executeOpenCodeJsonPatchOperations = async (
  operations: ReadonlyArray<OpenCodeJsonPatchOperation>,
  options: ExecuteLoweringOptions,
  backups: string[],
): Promise<void> => {
  if (operations.length === 0) return;

  const jsonTarget = operations[0]!.target;
  if (options.backup) {
    const backup = await backupFile(jsonTarget);
    if (backup) backups.push(backup);
  }

  const config = await readOpenCodeConfigForWrite(jsonTarget);
  const agentsMap = agentConfigMapForWrite(config);

  for (const operation of operations) {
    applyOpenCodeJsonPatchOperation(config, agentsMap, operation);
  }
  config.agent = agentsMap;

  const serialized = JSON.stringify(config, null, 2) + "\n";
  await writeFile(jsonTarget, serialized);
};

export const executeLowering = async (
  operations: LowerOperation[],
  options: ExecuteLoweringOptions,
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  await executeNonJsonLoweringOperations(operations, options, backups);
  await executeOpenCodeJsonPatchOperations(
    collectOpenCodeJsonPatchOperations(operations),
    options,
    backups,
  );

  return { backups };
};

export const describeOperation = (op: LowerOperation): string => {
  switch (op.kind) {
    case "write-md":
      return `${op.reason.padEnd(9)} md     ${op.target}`;
    case "patch-json":
      return `${op.reason.padEnd(9)} json   ${op.target} [agent.${op.agentName}]`;
    case "write-plugin-file":
      return `${op.reason.padEnd(9)} plugin ${op.target}`;
    case "patch-opencode-plugins":
      return `${op.reason.padEnd(9)} json   ${op.target} [plugin ${op.desiredPresent ? "+=" : "-="} ${op.pluginEntry}]`;
    case "patch-opencode-permission":
      return `${op.reason.padEnd(9)} json   ${op.target} [permission ${op.desiredAction === undefined ? "-=" : "="} ${op.permissionKey}]`;
    case "prune-plugin-path":
      return `${op.reason.padEnd(9)} prune  ${op.target}${op.targetType === "dir" ? " [dir]" : ""}`;
  }
};

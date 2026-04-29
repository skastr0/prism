/**
 * OpenCode lowerer.
 *
 * Takes a set of ComposedAgents + lifecycles and produces:
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
 *          (for example `agentpkg-generated-review-core`) when any agent has
 *          tool bindings
 *
 *   3. Per-lifecycle skills at <opencode-root>/skills/<name>/SKILL.md.
 *      Lifecycles remain source-language constructs; the generated skill is
 *      the runtime-facing lowering that OpenCode actually loads.
 *
 *   4. A generated OpenCode plugin directory at
 *      <opencode-root>/plugins/agentpkg-generated-<source-plugin>/ containing:
 *        - package.json
 *        - src/server.ts
 *        - src/runtime/schema-bridge.ts
 *        - src/adapters/<source-plugin>/<name>.adapter.ts
 *        - src/plugins/<source-plugin>/{contracts,schemas}/...
 *
 * The generated plugin tree is compiler-owned except for runtime-managed
 * entries like node_modules/ and lockfiles, which are preserved across syncs.
 */

import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import {
  composeLifecyclePhaseReference,
  type ComposedAgent,
} from "../compose.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { CanonicalTool, Contract, Hook, Lifecycle } from "../sources.js";
import type { PluginRegistry } from "../registry.js";
import type { HarnessScope } from "../../types.js";
import {
  backupFile,
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

const GENERATED_PLUGIN_PREFIX = "agentpkg-generated";
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

const lifecycleSkillMdPath = (
  target: OpenCodeLowerTarget,
  name: string
): string => join(target.root, "skills", name, "SKILL.md");

const lifecycleSkillRelativePath = (name: string): string =>
  `skills/${name}/SKILL.md`;

const opencodeJsonPath = (target: OpenCodeLowerTarget): string =>
  join(target.root, "opencode.json");

const normalizeGeneratedPluginSourcePluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

const sanitizeSyntheticToolSegment = (
  value: string,
  fallback: string
): string => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const syntheticToolNamespace = (sourcePluginName: string): string =>
  sanitizeSyntheticToolSegment(
    normalizeGeneratedPluginSourcePluginName(sourcePluginName),
    "plugin"
  );

const syntheticToolName = (
  sourcePluginName: string,
  contractName: string,
): string =>
  `${syntheticToolNamespace(sourcePluginName)}_${sanitizeSyntheticToolSegment(contractName, "tool")}`;

const ownerToolName = (toolPluginName: string, toolName: string): string =>
  `${syntheticToolNamespace(toolPluginName)}_${sanitizeSyntheticToolSegment(toolName, "tool")}`;

const runtimeToolName = (
  sourcePluginName: string,
  binding: ComposedAgent["toolBindings"][number],
): string => {
  if (binding.kind === "permission") {
    return ownerToolName(binding.toolPluginName, binding.toolName);
  }
  if (!binding.contract) {
    throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
  }
  return syntheticToolName(sourcePluginName, binding.contract.name);
};

const generatedPluginIdForName = (pluginName: string): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeGeneratedPluginSourcePluginName(pluginName)}`;

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
    join(generatedPluginRootForName(target, pluginName), "src", "server.ts")
  ).href;

const generatedPluginEntry = (target: OpenCodeLowerTarget): string =>
  generatedPluginEntryForName(target, target.sourcePluginName);

const generatedToolDenyPatternForName = (pluginName: string): string =>
  `${syntheticToolNamespace(pluginName)}_*`;

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

const fileExists = async (path: string): Promise<boolean> => {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
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
// Lifecycle skill rendering
// ---------------------------------------------------------------------------

const lifecycleSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- agentpkg:lifecycle-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const isOwnedLifecycleSkill = (
  content: string,
  sourcePluginName: string
): boolean => content.includes(lifecycleSkillOwnerMarker(sourcePluginName));

const renderLifecycleSkill = (
  lifecycle: Lifecycle,
  sourcePluginName: string
): string => {
  const lines: string[] = [];
  lines.push(
    serializeFrontmatter(
      { name: lifecycle.name, description: lifecycle.description },
      {},
    ),
  );
  lines.push("");
  lines.push(lifecycleSkillOwnerMarker(sourcePluginName));
  lines.push("");
  lines.push(`# ${lifecycle.name}`);
  lines.push("");
  lines.push(lifecycle.description);
  lines.push("");
  lines.push(
    "_Runtime-facing lowering of a concrete lifecycle instance. Parameterized lifecycle templates remain source-only until another lifecycle binds them._",
  );
  lines.push("");

  if (lifecycle.produces) {
    lines.push("## Produces");
    lines.push("");
    lines.push(lifecycle.produces);
    lines.push("");
  }

  lines.push("## Phases");
  lines.push("");
  let i = 1;
  for (const phase of lifecycle.phases) {
    const reference = composeLifecyclePhaseReference(phase);
    lines.push(`### ${i}. ${phase.name} — ${reference.label}`);
    lines.push("");
    for (const detail of reference.detailLines) {
      lines.push(detail);
    }
    if (phase.notes) {
      for (const [name, value] of Object.entries(phase.notes)) {
        lines.push(`- **${name}**: ${value}`);
      }
    }
    lines.push("");
    i++;
  }

  if (lifecycle.taste_checkpoints.length > 0) {
    lines.push("## Taste Checkpoints");
    lines.push("");
    for (const cp of lifecycle.taste_checkpoints) {
      const parts: string[] = [];
      if (cp.after) parts.push(`after: ${cp.after}`);
      if (cp.before) parts.push(`before: ${cp.before}`);
      if (cp.note) parts.push(`note: ${cp.note}`);
      lines.push(`- ${parts.join(" — ")}`);
    }
    lines.push("");
  }

  if (lifecycle.evolution) {
    lines.push("## Evolution");
    lines.push("");
    lines.push(lifecycle.evolution.trim());
    lines.push("");
  }

  const body = lifecycle.body.trim();
  if (body.length > 0) {
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Generated plugin emission
//
// Layout:
//   agentpkg-generated-<source-plugin>/
//   ├── package.json
//   └── src/
//       ├── server.ts                          (imports adapters)
//       ├── runtime/schema-bridge.ts           (Effect Schema → tool.schema)
//       ├── adapters/<plugin>/<name>.adapter.ts
//       └── plugins/<plugin>/                  (mirrored source plugin tree)
//           ├── contracts/*.contract.ts
//           └── schemas/*.ts
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

const RUNTIME_MANAGED_PLUGIN_DIRS = new Set(["node_modules"]);
const RUNTIME_MANAGED_PLUGIN_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

interface PluginTree {
  readonly files: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
}

const isRuntimeManagedPluginPath = (relativePath: string): boolean => {
  const [first] = relativePath.split("/");
  if (!first) return false;
  if (RUNTIME_MANAGED_PLUGIN_DIRS.has(first)) return true;
  return !relativePath.includes("/") && RUNTIME_MANAGED_PLUGIN_FILES.has(first);
};

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

const planLifecycleSkillPruning = async (
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
    if (!isOwnedLifecycleSkill(current, target.sourcePluginName)) continue;

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

const SOURCE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

const normalizeRelativePath = (path: string): string => path.replace(/\\/g, "/");

const resolveTsImportCandidate = async (
  absoluteWithoutQuery: string,
): Promise<string | undefined> => {
  const candidates = extname(absoluteWithoutQuery)
    ? [absoluteWithoutQuery]
    : [`${absoluteWithoutQuery}.ts`, join(absoluteWithoutQuery, "index.ts")];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
};

const collectRelativeImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(SOURCE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
};

const resolveMirrorImport = async (options: {
  readonly pluginRoot: string;
  readonly file: MirrorFile;
  readonly specifier: string;
}): Promise<MirrorFile | undefined> => {
  const basePath = options.file.sourcePath
    ? dirname(options.file.sourcePath)
    : dirname(join(options.pluginRoot, options.file.relativePath));
  const resolved = await resolveTsImportCandidate(resolve(basePath, options.specifier));
  if (!resolved || !sourceIsInsidePlugin(resolved, options.pluginRoot)) {
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
      const contractsDir = dirname(contract.sourcePath);
      const pluginRoot = dirname(contractsDir);
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

const normalizeMirroredPluginSource = (
  options: {
    readonly pluginName: string;
    readonly pluginRoot?: string;
    readonly relativePath: string;
    readonly sourcePath?: string;
    readonly source: string;
    readonly importPluginRoots: ReadonlyMap<string, string>;
  },
): string => {
  const currentGeneratedPath = `src/plugins/${options.pluginName}/${options.relativePath}`;
  const withRewrittenImports = rewriteCrossPluginRelativeImports({
    pluginName: options.pluginName,
    pluginRoot: options.pluginRoot,
    sourcePath: options.sourcePath,
    source: options.source,
    currentGeneratedPath,
    importPluginRoots: options.importPluginRoots,
  });

  if (!options.relativePath.endsWith(".tool.ts")) {
    return options.relativePath.endsWith(".hook.ts")
      ? rewriteHookAuthoringImports(
          withRewrittenImports,
          hookAuthoringBridgeImportFor(currentGeneratedPath),
        )
      : withRewrittenImports;
  }

  return stripToolAuthoringHelpers(withRewrittenImports)
    .replace(/\bdefineTool\s*\(/g, "(")
    .replace(/\bschemaSlot\s*\(/g, "(");
};

const sourceIsInsidePlugin = (sourcePath: string, pluginRoot: string): boolean => {
  const rel = relative(pluginRoot, sourcePath);
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const resolveImportedSourcePath = (
  sourcePath: string,
  source: string,
): string => {
  const absolute = resolve(dirname(sourcePath), source);
  if (extname(absolute)) return absolute;
  return `${absolute}.ts`;
};

const findSourcePlugin = (
  sourcePath: string,
  pluginRoots: ReadonlyMap<string, string>,
): { pluginName: string; pluginRoot: string } | undefined => {
  const matches = [...pluginRoots.entries()]
    .filter(([, pluginRoot]) => sourceIsInsidePlugin(sourcePath, pluginRoot))
    .sort((left, right) => right[1].length - left[1].length);
  const first = matches[0];
  if (!first) return undefined;
  return { pluginName: first[0], pluginRoot: first[1] };
};

const siblingGeneratedPluginModulePath = (
  currentGeneratedPath: string,
  pluginName: string,
  modulePath: string,
): string => {
  const currentDir = dirname(currentGeneratedPath).replace(/\\/g, "/");
  const depth = currentDir.split("/").filter(Boolean).length;
  const prefix = "../".repeat(depth + 1);
  return `${prefix}${generatedPluginIdForName(pluginName)}/src/plugins/${pluginName}/${modulePath.replace(/\.ts$/, "")}`;
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

      const modulePath = relative(owner.pluginRoot, importedSourcePath).replace(/\\/g, "/");
      return `${prefix}${quote}${siblingGeneratedPluginModulePath(
        options.currentGeneratedPath,
        owner.pluginName,
        modulePath,
      )}${quote}`;
    },
  );
};

const stripToolAuthoringHelpers = (source: string): string => {
  return source.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+["'][^"']+["'];\s*\n/gm,
    (match, specifiers: string) => {
      const kept = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .filter((specifier) => {
          const importedName = specifier
            .replace(/\s+as\s+.*$/u, "")
            .trim();
          return importedName !== "defineTool" && importedName !== "schemaSlot";
        });
      if (kept.length === specifiers.split(",").map((s) => s.trim()).filter(Boolean).length) {
        return match;
      }
      return kept.length > 0
        ? match.replace(`{${specifiers}}`, `{ ${kept.join(", ")} }`)
        : "";
    },
  );
};

const hookAuthoringBridgeImportFor = (currentGeneratedPath: string): string => {
  const currentDir = dirname(currentGeneratedPath).replace(/\\/g, "/");
  const depth = currentDir.split("/").filter(Boolean).length;
  return `${"../".repeat(Math.max(0, depth - 1))}runtime/hook-authoring-bridge`;
};

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

const GENERATED_HOOK_AUTHORING_BRIDGE = `// GENERATED by agentpkg — do not edit.\nexport const defineHook = (hook) => hook;\nexport const hookEvent = {\n  toolBefore: "tool.before",\n  toolAfter: "tool.after",\n  sessionStart: "session.start",\n  sessionEnd: "session.end",\n};\nexport const toolRef = (first, second, third) => third === undefined\n  ? { kind: "tool-ref", toolspace: first, name: second }\n  : { kind: "tool-ref", plugin: first, toolspace: second, name: third };\nexport const hookTool = {\n  any: () => ({ kind: "hook-any-tool" }),\n  tool: (tool) => ({ kind: "hook-toolspace-tool", tool }),\n  group: (group) => ({ kind: "hook-toolspace-group", group }),\n  canonical: (ref) => ({ kind: "hook-canonical-tool", ref }),\n};\nexport const hookMatcher = { tool: hookTool };\n`;

const GENERATED_HOOK_RUNTIME = `// GENERATED by agentpkg — do not edit.\nconst right = (value) => ({ _tag: "Right", right: value });\nconst left = (message) => ({ _tag: "Left", left: message });\nconst isObject = (value) => value !== null && typeof value === "object";\nconst decodeTarget = (payload) => isObject(payload?.target) && typeof payload.target.harness === "string" && typeof payload.target.nativeEvent === "string"\n  ? payload.target\n  : undefined;\nconst decodeSession = (payload) => payload?.session === undefined || isObject(payload.session)\n  ? payload.session\n  : undefined;\nexport const decodeNativeHookPayloadForEvent = (event, payload) => {\n  if (!isObject(payload)) return left("native hook payload must be an object");\n  const target = decodeTarget(payload);\n  if (!target) return left("native hook payload target is invalid");\n  const session = decodeSession(payload);\n  if (payload.session !== undefined && !session) return left("native hook payload session is invalid");\n  if (event === "tool.before") {\n    if (!isObject(payload.tool) || typeof payload.tool.name !== "string") return left("tool.before payload tool is invalid");\n    return right({ event, target, cwd: payload.cwd, session, tool: { logical: payload.tool.logical, nativeName: payload.tool.name, input: payload.tool.input } });\n  }\n  if (event === "tool.after") {\n    if (!isObject(payload.tool) || typeof payload.tool.name !== "string") return left("tool.after payload tool is invalid");\n    return right({ event, target, cwd: payload.cwd, session, tool: { logical: payload.tool.logical, nativeName: payload.tool.name, input: payload.tool.input, output: payload.tool.output, success: payload.tool.success } });\n  }\n  if (event === "session.start") {\n    if (!isObject(session)) return left("session.start payload session is invalid");\n    return right({ event, target, cwd: payload.cwd, session });\n  }\n  if (event === "session.end") {\n    if (!isObject(session)) return left("session.end payload session is invalid");\n    return right({ event, target, cwd: payload.cwd, session, reason: payload.reason });\n  }\n  return left("unknown hook event");\n};\nexport const decodeHookResultForEvent = (event, result) => {\n  if (!isObject(result)) return left("hook result must be an object");\n  if (event === "tool.before" && result.decision === "block" && typeof result.message === "string") return right(result);\n  if (result.decision === "continue") return right({ decision: "continue" });\n  return left("invalid hook result for " + event);\n};\n`;

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
  lines.push(`// GENERATED by agentpkg — do not edit.`);
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
  | "session.created"
  | "session.deleted";

interface HookRegistration {
  readonly hook: Hook;
  readonly hookPluginName: string;
  readonly hookPluginRoot: string;
  readonly nativeEvent: OpenCodeNativeHookEvent;
  readonly matcher?: ResolvedHookMatch;
}

const opencodeNativeHookEvent = (event: Hook["event"]): OpenCodeNativeHookEvent | undefined => {
  switch (event) {
    case "tool.before":
      return "tool.execute.before";
    case "tool.after":
      return "tool.execute.after";
    case "session.start":
      return "session.created";
    case "session.end":
      return "session.deleted";
  }
};

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
  lines.push(`  throw new Error("agentpkg hook " + label + " validation failed");`);
  lines.push(`};`);
  lines.push(`const toPromise = (value: any) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);`);
  lines.push(`const handleAgentpkgHook = async (hook: any, event: any, nativePayload: any) => {`);
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
  const sessionStart = registrations.filter((registration) => registration.nativeEvent === "session.created");
  const sessionEnd = registrations.filter((registration) => registration.nativeEvent === "session.deleted");
  const lines: string[] = [];
  if (before.length > 0) {
    lines.push(`  "tool.execute.before": async (input, output) => {`);
    lines.push(`    const toolName = String(input.tool ?? "");`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "tool.execute.before" }, tool: { name: toolName, input: output.args }, cwd: context.directory, session: { id: input.sessionID } };`);
    before.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    if (${renderHookMatcher(registration, registration.hookPluginName)}) await handleAgentpkgHook(${hookIdentifier(registration.hook, registrationIndex)}, "tool.before", nativePayload);`);
    });
    lines.push(`  },`);
  }
  if (after.length > 0) {
    lines.push(`  "tool.execute.after": async (input, output) => {`);
    lines.push(`    const toolName = String(input.tool ?? "");`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "tool.execute.after" }, tool: { name: toolName, input: input.args, output: output.output, success: output.metadata?.success }, cwd: context.directory, session: { id: input.sessionID } };`);
    after.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    if (${renderHookMatcher(registration, registration.hookPluginName)}) await handleAgentpkgHook(${hookIdentifier(registration.hook, registrationIndex)}, "tool.after", nativePayload);`);
    });
    lines.push(`  },`);
  }
  if (sessionStart.length > 0 || sessionEnd.length > 0) {
    lines.push(`  event: async ({ event }) => {`);
    lines.push(`    const eventType = String(event.type ?? "");`);
    lines.push(`    const properties = event.properties ?? {};`);
    if (sessionStart.length > 0) {
      lines.push(`    if (eventType === "session.created") {`);
      lines.push(`      const nativePayload = { target: { harness: "opencode", nativeEvent: "session.created" }, cwd: context.directory, session: { id: String(properties.sessionID ?? properties.info?.id ?? "opencode") } };`);
      sessionStart.forEach((registration) => {
        const registrationIndex = registrations.indexOf(registration);
        lines.push(`      await handleAgentpkgHook(${hookIdentifier(registration.hook, registrationIndex)}, "session.start", nativePayload);`);
      });
      lines.push(`    }`);
    }
    if (sessionEnd.length > 0) {
      lines.push(`    if (eventType === "session.deleted") {`);
      lines.push(`      const nativePayload = { target: { harness: "opencode", nativeEvent: "session.deleted" }, cwd: context.directory, session: { id: String(properties.sessionID ?? properties.info?.id ?? "opencode") }, reason: "deleted" };`);
      sessionEnd.forEach((registration) => {
        const registrationIndex = registrations.indexOf(registration);
        lines.push(`      await handleAgentpkgHook(${hookIdentifier(registration.hook, registrationIndex)}, "session.end", nativePayload);`);
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
  lines.push("// GENERATED by agentpkg — do not edit.");
  lines.push("// Re-run `agentpkg compile` to regenerate.");
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

const GENERATED_PACKAGE_JSON = (pluginId: string): string =>
  JSON.stringify(
    {
      name: pluginId,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/server.ts",
      exports: {
        "./server": "./src/server.ts",
      },
      dependencies: {
        "@opencode-ai/plugin": "^1.4.6",
        effect: "^3.21.0",
      },
    },
    null,
    2,
  ) + "\n";

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

const bindingFromToolSource = (
  pluginName: string,
  sourcePath: string,
): ComposedAgent["toolBindings"][number] => {
  const toolName = basename(sourcePath, ".tool.ts");
  return {
    kind: "permission",
    logicalName: toolName,
    toolPluginName: pluginName,
    toolName,
    toolSourcePath: sourcePath,
  };
};

const bindingsFromCanonicalTools = (
  pluginName: string,
  tools: ReadonlyArray<CanonicalTool>,
): ReadonlyArray<ComposedAgent["toolBindings"][number]> =>
  tools
    .map((tool) => bindingFromToolSource(pluginName, tool.sourcePath))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));

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
  const desiredPluginFiles = new Set<string>();

  desiredPluginFiles.add("package.json");
  const pkgTarget = join(options.root, "package.json");
  const desiredPkg = GENERATED_PACKAGE_JSON(options.pluginId);
  let pkgReason: "new" | "changed" | "unchanged";
  if (await fileExists(pkgTarget)) {
    const current = await readFile(pkgTarget);
    pkgReason = current === desiredPkg ? "unchanged" : "changed";
  } else {
    pkgReason = "new";
  }
  operations.push({
    kind: "write-plugin-file",
    target: pkgTarget,
    content: desiredPkg,
    reason: pkgReason,
  });

  desiredPluginFiles.add("src/runtime/schema-bridge.ts");
  const bridgeTarget = join(options.root, "src", "runtime", "schema-bridge.ts");
  const desiredBridge = await getSchemaBridgeSource();
  let bridgeReason: "new" | "changed" | "unchanged";
  if (await fileExists(bridgeTarget)) {
    const current = await readFile(bridgeTarget);
    bridgeReason = current === desiredBridge ? "unchanged" : "changed";
  } else {
    bridgeReason = "new";
  }
  operations.push({
    kind: "write-plugin-file",
    target: bridgeTarget,
    content: desiredBridge,
    reason: bridgeReason,
  });

  if ((options.hookRegistrations?.length ?? 0) > 0) {
    desiredPluginFiles.add("src/runtime/hook-authoring-bridge.ts");
    const hookBridgeTarget = join(options.root, "src", "runtime", "hook-authoring-bridge.ts");
    let hookBridgeReason: "new" | "changed" | "unchanged";
    if (await fileExists(hookBridgeTarget)) {
      const current = await readFile(hookBridgeTarget);
      hookBridgeReason = current === GENERATED_HOOK_AUTHORING_BRIDGE ? "unchanged" : "changed";
    } else {
      hookBridgeReason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target: hookBridgeTarget,
      content: GENERATED_HOOK_AUTHORING_BRIDGE,
      reason: hookBridgeReason,
    });

    desiredPluginFiles.add("src/runtime/hook-runtime.ts");
    const hookRuntimeTarget = join(options.root, "src", "runtime", "hook-runtime.ts");
    let hookRuntimeReason: "new" | "changed" | "unchanged";
    if (await fileExists(hookRuntimeTarget)) {
      const current = await readFile(hookRuntimeTarget);
      hookRuntimeReason = current === GENERATED_HOOK_RUNTIME ? "unchanged" : "changed";
    } else {
      hookRuntimeReason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target: hookRuntimeTarget,
      content: GENERATED_HOOK_RUNTIME,
      reason: hookRuntimeReason,
    });
  }

  for (const mirror of options.mirrors) {
    for (const file of mirror.files) {
      const relativeTarget = `src/plugins/${mirror.pluginName}/${file.relativePath}`;
      desiredPluginFiles.add(relativeTarget);
      const target = join(
        options.root,
        "src",
        "plugins",
        mirror.pluginName,
        file.relativePath,
      );
      const raw = file.content ?? (await readFile(file.sourcePath!));
      const desired = normalizeMirroredPluginSource({
        pluginName: mirror.pluginName,
        pluginRoot: mirror.pluginRoot,
        relativePath: file.relativePath,
        sourcePath: file.sourcePath,
        source: raw,
        importPluginRoots: options.importPluginRoots,
      });
      let reason: "new" | "changed" | "unchanged";
      if (await fileExists(target)) {
        const current = await readFile(target);
        reason = current === desired ? "unchanged" : "changed";
      } else {
        reason = "new";
      }
      operations.push({
        kind: "write-plugin-file",
        target,
        content: desired,
        reason,
      });
    }
  }

  for (const spec of options.adapters) {
    const adapterName = spec.kind === "synthetic" ? spec.contractName : spec.toolName;
    const relativeTarget = `src/adapters/${spec.pluginName}/${adapterName}.adapter.ts`;
    desiredPluginFiles.add(relativeTarget);
    const target = join(
      options.root,
      "src",
      "adapters",
      spec.pluginName,
      `${adapterName}.adapter.ts`,
    );
    const desired = renderToolAdapter(spec);
    let reason: "new" | "changed" | "unchanged";
    if (await fileExists(target)) {
      const current = await readFile(target);
      reason = current === desired ? "unchanged" : "changed";
    } else {
      reason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target,
      content: desired,
      reason,
    });
  }

  desiredPluginFiles.add("src/server.ts");
  const serverTarget = join(options.root, "src", "server.ts");
  const desiredServer = renderGeneratedServerTsForBindings(
    options.serverBindings,
    options.runtimeToolNamespace,
    options.pluginId,
    options.adapters,
    options.hookRegistrations ?? [],
  );
  let serverReason: "new" | "changed" | "unchanged";
  if (await fileExists(serverTarget)) {
    const current = await readFile(serverTarget);
    serverReason = current === desiredServer ? "unchanged" : "changed";
  } else {
    serverReason = "new";
  }
  operations.push({
    kind: "write-plugin-file",
    target: serverTarget,
    content: desiredServer,
    reason: serverReason,
  });

  operations.push(...(await planPluginPruning(options.root, desiredPluginFiles)));
  return operations;
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly lifecycles: ReadonlyArray<Lifecycle>;
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

export const planLowering = async (
  input: LowerInput
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const hookRegistrations = await planOpenCodeHookRegistrations(input.hooks ?? [], input.registry);
  const hasAnyHook = hookRegistrations.length > 0;
  const referencedBindings = input.agents.flatMap((a) => a.toolBindings);
  const hasAnyTool = referencedBindings.length > 0;
  const sourceCanonicalToolBindings = bindingsFromCanonicalTools(
    input.target.sourcePluginName,
    input.tools,
  );
  const ownerPluginRoots = new Map<string, string>();
  for (const binding of referencedBindings) {
    if (binding.toolPluginName === input.target.sourcePluginName) continue;
    ownerPluginRoots.set(
      binding.toolPluginName,
      pluginRootFromToolSource(binding.toolSourcePath),
    );
  }
  const ownerPlugins = new Map<
    string,
    {
      pluginRoot: string;
      bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>;
    }
  >();
  for (const [pluginName, pluginRoot] of [...ownerPluginRoots.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    ownerPlugins.set(pluginName, {
      pluginRoot,
      bindings: await bindingsFromPluginToolFiles(pluginName, pluginRoot),
    });
  }
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
  const inventory = buildInventory(
    input.target.sourcePluginName,
    input.agents,
    generatedOwnerToolNames,
  );
  const desiredLifecycleSkillFiles = new Set<string>();
  const ownedGeneratedPluginId = generatedPluginId(input.target);
  const ownedGeneratedPluginEntry = generatedPluginEntry(input.target);

  // ---- Per-agent markdown
  for (const agent of input.agents) {
    const mdTarget = agentMdPath(input.target, agent.name);
    const desiredMd = renderAgentMarkdown(agent, inventory);
    let reason: "new" | "changed" | "unchanged";
    if (await fileExists(mdTarget)) {
      const current = await readFile(mdTarget);
      reason = current === desiredMd ? "unchanged" : "changed";
    } else {
      reason = "new";
    }
    operations.push({
      kind: "write-md",
      target: mdTarget,
      content: desiredMd,
      reason,
    });
  }

  // ---- opencode.json agent.<name> patches
  const jsonTarget = opencodeJsonPath(input.target);
  let config: Record<string, unknown> = {};
  if (await fileExists(jsonTarget)) {
    config = await readJson<Record<string, unknown>>(jsonTarget);
  }
  const agentsMap =
    (config.agent as Record<string, unknown> | undefined) || {};

  for (const agent of input.agents) {
    const existingBlock = agentsMap[agent.name] as
      | Record<string, unknown>
      | undefined;
    const nextBlock = composeAgentBlock(agent, existingBlock);
    let reason: "new" | "changed" | "unchanged";
    if (!existingBlock) reason = "new";
    else if (deepEqual(existingBlock, nextBlock)) reason = "unchanged";
    else reason = "changed";
    operations.push({
      kind: "patch-json",
      target: jsonTarget,
      agentName: agent.name,
      nextBlock,
      reason,
    });
  }

  // ---- Lifecycle lowering (source lifecycles -> runtime skills)
  for (const lifecycle of input.lifecycles) {
    const target = lifecycleSkillMdPath(input.target, lifecycle.name);
    desiredLifecycleSkillFiles.add(lifecycleSkillRelativePath(lifecycle.name));
    const desired = renderLifecycleSkill(
      lifecycle,
      input.target.sourcePluginName,
    );
    let reason: "new" | "changed" | "unchanged";
    if (await fileExists(target)) {
      const current = await readFile(target);
      reason = current === desired ? "unchanged" : "changed";
    } else {
      reason = "new";
    }
    operations.push({
      kind: "write-md",
      target,
      content: desired,
      reason,
    });
  }

  operations.push(
    ...(await planLifecycleSkillPruning(
      input.target,
      desiredLifecycleSkillFiles,
    )),
  );

  // ---- Generated plugin emission
  const desiredGeneratedPluginEntries = new Set<string>();
  const legacyGeneratedPluginEntriesToPrune = new Set<string>([
    ownedGeneratedPluginId,
  ]);
  const desiredGeneratedPermissionNamespaces = new Set<string>();
  const generatedPermissionNamespacesToTouch = new Set<string>([
    input.target.sourcePluginName,
  ]);
  const rememberDesiredGeneratedPlugin = (pluginName: string): void => {
    const pluginEntry = generatedPluginEntryForName(input.target, pluginName);
    desiredGeneratedPluginEntries.add(pluginEntry);
    legacyGeneratedPluginEntriesToPrune.add(
      generatedPluginIdForName(pluginName)
    );
    desiredGeneratedPermissionNamespaces.add(pluginName);
    generatedPermissionNamespacesToTouch.add(pluginName);
  };

  if (hasAnyTool || sourceCanonicalToolBindings.length > 0 || hasAnyHook) {
    const mirrors = await planPluginMirrors(
      input.target.sourcePluginName,
      referencedBindings,
      hookRegistrations,
      input.registry?.pluginPath,
    );
    const ownedRuntimeBindings = referencedBindings.filter(
      (binding) =>
        binding.kind === "synthetic" ||
        binding.toolPluginName === input.target.sourcePluginName,
    );
    const sourceRuntimeBindings = [
      ...sourceCanonicalToolBindings,
      ...ownedRuntimeBindings,
    ];
    const sourceCanonicalMirror =
      sourceCanonicalToolBindings.length > 0
        ? await planRuntimePluginMirrors(
            input.target.sourcePluginName,
            pluginRootFromToolSource(
              sourceCanonicalToolBindings[0]!.toolSourcePath,
            ),
            sourceCanonicalToolBindings,
          )
        : undefined;

    const importPluginRoots = new Map<string, string>();
    for (const mirror of sourceCanonicalMirror
      ? mergePluginMirrors([...mirrors, sourceCanonicalMirror])
      : mirrors) {
      if (mirror.pluginRoot) {
        importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
      }
    }
    for (const [pluginName, owner] of ownerPlugins) {
      importPluginRoots.set(pluginName, owner.pluginRoot);
    }

    if (sourceRuntimeBindings.length > 0 || hasAnyHook) {
      rememberDesiredGeneratedPlugin(input.target.sourcePluginName);
      operations.push(
        ...(await planGeneratedPluginFiles({
          root: generatedPluginRoot(input.target),
          pluginId: ownedGeneratedPluginId,
          runtimeToolNamespace: input.target.sourcePluginName,
          mirrors: sourceCanonicalMirror
            ? mergePluginMirrors([...mirrors, sourceCanonicalMirror])
            : mirrors,
          importPluginRoots,
          adapters: planAdaptersForBindings(
            input.target.sourcePluginName,
            sourceRuntimeBindings,
          ),
          serverBindings: sourceRuntimeBindings,
          hookRegistrations,
        })),
      );
    } else {
      operations.push(
        ...(await planPluginPruning(
          generatedPluginRoot(input.target),
          new Set<string>(),
        )),
      );
    }

    for (const [pluginName, owner] of ownerPlugins) {
      const pluginId = generatedPluginIdForName(pluginName);
      rememberDesiredGeneratedPlugin(pluginName);
      const ownerMirror = await planRuntimePluginMirrors(
        pluginName,
        owner.pluginRoot,
        owner.bindings,
      );
      operations.push(
        ...(await planGeneratedPluginFiles({
          root: generatedPluginRootForName(input.target, pluginName),
          pluginId,
          runtimeToolNamespace: pluginName,
          mirrors: [ownerMirror],
          importPluginRoots,
          adapters: planAdaptersForBindings(pluginName, owner.bindings),
          serverBindings: owner.bindings,
          hookRegistrations: [],
        })),
      );
    }
  }

  // ---- opencode.json plugin array entries for every generated runtime plugin
  const plugins = (config.plugin as unknown) instanceof Array
    ? (config.plugin as unknown[])
    : [];
  for (const pluginEntry of new Set([
    ownedGeneratedPluginId,
    ownedGeneratedPluginEntry,
    ...desiredGeneratedPluginEntries,
    ...legacyGeneratedPluginEntriesToPrune,
  ])) {
    const desiredPresent = desiredGeneratedPluginEntries.has(pluginEntry);
    const already = plugins.includes(pluginEntry);
    const pluginReason: "new" | "changed" | "unchanged" = desiredPresent
      ? already
        ? "unchanged"
        : "new"
      : already
        ? "changed"
        : "unchanged";
    operations.push({
      kind: "patch-opencode-plugins",
      target: jsonTarget,
      pluginEntry,
      desiredPresent,
      reason: pluginReason,
    });
  }

  // ---- opencode.json global permission defaults for generated tools
  //
  // OpenCode loads plugin tools into the harness-wide registry. Without a
  // global deny, any non-compiled Markdown agent with no explicit permission
  // block inherits default access to generated agentpkg tools. The generated
  // agent frontmatter then allows its assigned tools explicitly.
  for (const pluginName of [...generatedPermissionNamespacesToTouch].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const desiredAction = desiredGeneratedPermissionNamespaces.has(pluginName)
      ? "deny"
      : undefined;
    const permissionKey = generatedToolDenyPatternForName(pluginName);
    operations.push({
      kind: "patch-opencode-permission",
      target: jsonTarget,
      permissionKey,
      desiredAction,
      reason: permissionPatchReason(config, permissionKey, desiredAction),
    });
  }

  return operations;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const executeLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean }
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  // Apply non-JSON operations first, JSON last so we aggregate agent + plugin
  // patches into a single read-modify-write-of opencode.json.

  for (const op of operations) {
    if (op.reason === "unchanged") continue;
    if (
      op.kind === "patch-json" ||
      op.kind === "patch-opencode-plugins" ||
      op.kind === "patch-opencode-permission"
    ) continue;

    if (op.kind === "write-md" || op.kind === "write-plugin-file") {
      if (options.backup && op.kind === "write-md") {
        const b = await backupFile(op.target);
        if (b) backups.push(b);
      }
      await writeFile(op.target, op.content);
      continue;
    }

    if (op.kind === "prune-plugin-path") {
      if (op.targetType === "dir") {
        await removeDir(op.target);
      } else {
        await removeFile(op.target);
      }
      continue;
    }
  }

  // Aggregate all JSON patches into one write.
  const jsonOps = operations.filter(
    (op) =>
      (op.kind === "patch-json" ||
        op.kind === "patch-opencode-plugins" ||
        op.kind === "patch-opencode-permission") &&
      op.reason !== "unchanged"
  );
  if (jsonOps.length > 0) {
    const jsonTarget = jsonOps[0]!.target;
    if (options.backup) {
      const b = await backupFile(jsonTarget);
      if (b) backups.push(b);
    }

    let config: Record<string, unknown> = {};
    if (await fileExists(jsonTarget)) {
      config = await readJson<Record<string, unknown>>(jsonTarget);
    }

    const agentsMap =
      (config.agent as Record<string, unknown> | undefined) || {};

    for (const op of jsonOps) {
      if (op.kind === "patch-json") {
        agentsMap[op.agentName] = op.nextBlock;
      } else if (op.kind === "patch-opencode-plugins") {
        const hadPluginKey = Object.prototype.hasOwnProperty.call(config, "plugin");
        const plugins = Array.isArray(config.plugin)
          ? [...(config.plugin as unknown[])]
          : [];

        if (op.desiredPresent) {
          if (!plugins.includes(op.pluginEntry)) {
            plugins.push(op.pluginEntry);
          }
        } else {
          const nextPlugins = plugins.filter(
            (pluginEntry) => pluginEntry !== op.pluginEntry
          );
          plugins.length = 0;
          plugins.push(...nextPlugins);
        }

        if (plugins.length > 0 || hadPluginKey) {
          config.plugin = plugins;
        } else {
          delete config.plugin;
        }
      } else if (op.kind === "patch-opencode-permission") {
        const permissions = normalizePermissionBlockForWrite(config);
        if (op.desiredAction === undefined) {
          delete permissions[op.permissionKey];
        } else {
          permissions[op.permissionKey] = op.desiredAction;
        }

        if (Object.keys(permissions).length > 0) {
          config.permission = permissions;
        } else {
          delete config.permission;
        }
      }
    }
    config.agent = agentsMap;

    const serialized = JSON.stringify(config, null, 2) + "\n";
    await writeFile(jsonTarget, serialized);
  }

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

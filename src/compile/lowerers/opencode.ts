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
 *          module (for example
 *          `plugins/prism-generated-review-core/dist/server.mjs`) when any
 *          agent has tool bindings
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

import { stripBundlerPathComments } from "../bundle-normalize.js";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { CanonicalTool, Contract, Hook, Orbit } from "../sources.js";
import type { PluginRegistry } from "../registry.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
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
  makeTempBuildRoot,
  removeTempBuildRoot,
  writeTempBuildFile,
} from "../temp-build-fs.js";
import {
  bindingFromToolSource,
  bindingsFromCanonicalTools,
} from "../tool-bindings.js";
import {
  nativeHookEventName,
  pushDesiredFile,
  renderGeneratedOrbitSkill,
  type LowerOutput,
} from "./shared.js";
import {
  exists as fileExists,
  readFile,
  listDirRecursive,
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

const generatedToolDenyPatternForName = (pluginName: string): string =>
  `${generatedToolNamespace(pluginName)}_*`;

const rewriteGeneratedOpenCodeRuntimeImportsForBundle = (source: string): string =>
  rewriteBareImportsForBundle(
    rewriteBareEffectImportsForBundle(source),
    new Map([["@opencode-ai/plugin", opencodePluginBundleImportPath()]]),
  );

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
// opencode.json regions
//
// opencode.json is user-shared. Prism owns:
//  - per compiled agent, each compiler-owned key at agent.<name>.<key>
//    (one json-key region per key — hand-authored sibling keys are never
//    touched, and a key the compiler stops emitting is removed as an
//    orphaned region),
//  - the generated-plugin entries inside the `plugin` array (one
//    json-array-member region per entry),
//  - the deny-by-default `permission."<ns>_*"` keys for generated tool
//    namespaces (one json-key region per namespace).
// ---------------------------------------------------------------------------

/** Compiler-owned agent config keys, derived purely from the composed agent. */
const composeAgentOwnedBlock = (agent: ComposedAgent): Record<string, unknown> => {
  const next: Record<string, unknown> = {};

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

interface PluginMirrorPlanningState {
  readonly rootsByPlugin: Map<string, { pluginRoot: string }>;
  readonly generatedFilesByPlugin: Map<string, Map<string, string>>;
  readonly entryFilesByPlugin: Map<string, Map<string, MirrorFile>>;
}

const createPluginMirrorPlanningState = (): PluginMirrorPlanningState => ({
  rootsByPlugin: new Map(),
  generatedFilesByPlugin: new Map(),
  entryFilesByPlugin: new Map(),
});

const addMirrorEntryFile = (
  state: PluginMirrorPlanningState,
  pluginName: string,
  file: MirrorFile,
): void => {
  const pluginFiles =
    state.entryFilesByPlugin.get(pluginName) ?? new Map<string, MirrorFile>();
  pluginFiles.set(file.relativePath, file);
  state.entryFilesByPlugin.set(pluginName, pluginFiles);
};

const addGeneratedMirrorFile = (
  state: PluginMirrorPlanningState,
  contract: Contract,
  file: { readonly relativePath: string; readonly content: string },
): void => {
  const pluginFiles =
    state.generatedFilesByPlugin.get(contract.pluginName) ?? new Map<string, string>();
  const existing = pluginFiles.get(file.relativePath);
  if (existing && existing !== file.content) {
    throw new Error(
      `generated contract name collision at ${contract.pluginName}:${file.relativePath}`,
    );
  }
  pluginFiles.set(file.relativePath, file.content);
  state.generatedFilesByPlugin.set(contract.pluginName, pluginFiles);
};

const contractPluginRoot = (
  sourcePluginName: string,
  contract: Contract,
  sourcePluginRoot?: string,
): string =>
  contract.pluginName === sourcePluginName && sourcePluginRoot
    ? sourcePluginRoot
    : dirname(dirname(contract.sourcePath));

const ensureMirrorPluginRoot = (
  state: PluginMirrorPlanningState,
  pluginName: string,
  pluginRoot: string,
): void => {
  if (!state.rootsByPlugin.has(pluginName)) {
    state.rootsByPlugin.set(pluginName, { pluginRoot });
  }
};

const registerContractMirrorInputs = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  contract: Contract,
  sourcePluginRoot?: string,
): void => {
  for (const file of contract.generatedFiles ?? []) {
    addGeneratedMirrorFile(state, contract, file);
  }

  // Prefer the host plugin's root when the contract is attributed to it.
  // contract.sourcePath traces back to the trait file's location, which
  // may live in a *different* plugin from the contract's owning plugin
  // (e.g. cross-plugin trait + slot binding). Using contract.sourcePath
  // unconditionally would map the host plugin to the trait plugin's root.
  ensureMirrorPluginRoot(
    state,
    contract.pluginName,
    contractPluginRoot(sourcePluginName, contract, sourcePluginRoot),
  );
};

const registerContractsMirrorInputs = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
  sourcePluginRoot?: string,
): void => {
  const contracts = bindings
    .map((binding) => binding.contract)
    .filter((contract): contract is Contract => contract !== undefined);
  for (const contract of contracts) {
    registerContractMirrorInputs(state, sourcePluginName, contract, sourcePluginRoot);
  }
};

const registerSyntheticBindingMirrorEntry = (
  state: PluginMirrorPlanningState,
  binding: ComposedAgent["toolBindings"][number],
): void => {
  if (binding.kind !== "synthetic") return;
  if (!binding.contract) {
    throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
  }
  if (binding.toolPluginName !== binding.contract.pluginName) return;

  addMirrorEntryFile(state, binding.contract.pluginName, {
    relativePath: `tools/${binding.toolName}.tool.ts`,
    sourcePath: binding.toolSourcePath,
  });
};

const registerSourceBindingMirrorEntry = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  binding: ComposedAgent["toolBindings"][number],
): void => {
  if (binding.kind === "synthetic") return;
  if (binding.toolPluginName !== sourcePluginName) return;

  const toolsDir = dirname(binding.toolSourcePath);
  ensureMirrorPluginRoot(state, binding.toolPluginName, dirname(toolsDir));
  addMirrorEntryFile(state, binding.toolPluginName, {
    relativePath: `tools/${binding.toolName}.tool.ts`,
    sourcePath: binding.toolSourcePath,
  });
};

const registerBindingMirrorEntries = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
): void => {
  for (const binding of bindings) {
    if (binding.kind === "synthetic") {
      registerSyntheticBindingMirrorEntry(state, binding);
    } else {
      registerSourceBindingMirrorEntry(state, sourcePluginName, binding);
    }
  }
};

const registerHookMirrorEntries = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  hookRegistrations: ReadonlyArray<HookRegistration>,
  sourcePluginRoot?: string,
): void => {
  if (hookRegistrations.length === 0 || !sourcePluginRoot) return;

  ensureMirrorPluginRoot(state, sourcePluginName, sourcePluginRoot);
  for (const registration of hookRegistrations) {
    addMirrorEntryFile(state, sourcePluginName, {
      relativePath: normalizeRelativePath(
        relative(sourcePluginRoot, registration.hook.sourcePath),
      ),
      sourcePath: registration.hook.sourcePath,
    });
  }
};

const mirrorFilesForPlugin = (
  state: PluginMirrorPlanningState,
  pluginName: string,
): Map<string, MirrorFile> => {
  const files = new Map(state.entryFilesByPlugin.get(pluginName) ?? []);
  for (const [relativePath, content] of state.generatedFilesByPlugin.get(pluginName) ?? []) {
    files.set(relativePath, { relativePath, content });
  }
  return files;
};

const buildRuntimeClosureMirrors = async (
  state: PluginMirrorPlanningState,
): Promise<PluginMirror[]> => {
  const mirrors: PluginMirror[] = [];
  for (const [pluginName, { pluginRoot }] of state.rootsByPlugin) {
    mirrors.push({
      pluginName,
      pluginRoot,
      files: await collectMirrorRuntimeClosure(
        pluginRoot,
        [...mirrorFilesForPlugin(state, pluginName).values()],
      ),
    });
  }
  return mirrors;
};

const buildGeneratedOnlyMirrors = (
  state: PluginMirrorPlanningState,
  runtimeMirrors: ReadonlyArray<PluginMirror>,
): PluginMirror[] => {
  const mirroredPlugins = new Set(runtimeMirrors.map((mirror) => mirror.pluginName));
  const mirrors: PluginMirror[] = [];
  for (const [pluginName, files] of state.generatedFilesByPlugin) {
    if (mirroredPlugins.has(pluginName)) continue;
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

const buildPluginMirrors = async (
  state: PluginMirrorPlanningState,
): Promise<PluginMirror[]> => {
  const runtimeMirrors = await buildRuntimeClosureMirrors(state);
  return [
    ...runtimeMirrors,
    ...buildGeneratedOnlyMirrors(state, runtimeMirrors),
  ];
};

const planPluginMirrors = async (
  sourcePluginName: string,
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
  hookRegistrations: ReadonlyArray<HookRegistration> = [],
  sourcePluginRoot?: string,
): Promise<PluginMirror[]> => {
  const state = createPluginMirrorPlanningState();
  registerContractsMirrorInputs(state, sourcePluginName, bindings, sourcePluginRoot);
  registerBindingMirrorEntries(state, sourcePluginName, bindings);
  registerHookMirrorEntries(state, sourcePluginName, hookRegistrations, sourcePluginRoot);
  return buildPluginMirrors(state);
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

const GENERATED_HOOK_AUTHORING_BRIDGE = `// GENERATED by prism — do not edit.\nexport const defineHook = (hook) => hook;\nexport const hookEvent = {\n  toolBefore: "tool.before",\n  toolAfter: "tool.after",\n  promptSubmit: "prompt.submit",\n  permissionRequest: "permission.request",\n  sessionStart: "session.start",\n  sessionEnd: "session.end",\n};\nexport const toolRef = (first, second, third) => third === undefined\n  ? { kind: "tool-ref", toolspace: first, name: second }\n  : { kind: "tool-ref", plugin: first, toolspace: second, name: third };\nexport const hookTool = {\n  any: () => ({ kind: "hook-any-tool" }),\n  tool: (tool) => ({ kind: "hook-toolspace-tool", tool }),\n  group: (group) => ({ kind: "hook-toolspace-group", group }),\n  canonical: (ref) => ({ kind: "hook-canonical-tool", ref }),\n};\nexport const hookMatcher = { tool: hookTool };\n`;

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
  | "chat.message"
  | "permission.ask"
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
    promptSubmit: "chat.message",
    permissionRequest: "permission.ask",
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
  lines.push(`  return result;`);
  lines.push(`};`);
  lines.push(`const appendPromptContext = (input: any, output: any, hookName: string, result: any) => {`);
  lines.push(`  if (result.systemMessage) output.message.system = [output.message.system, result.systemMessage].filter(Boolean).join("\\n\\n");`);
  lines.push(`  if (!result.additionalContext) return;`);
  lines.push(`  const messageID = input.messageID ?? output.message?.id ?? "prism";`);
  lines.push(`  output.parts.push({`);
  lines.push(`    id: "prism-" + hookName + "-context",`);
  lines.push(`    sessionID: input.sessionID,`);
  lines.push(`    messageID,`);
  lines.push(`    type: "text",`);
  lines.push(`    text: result.additionalContext,`);
  lines.push(`    synthetic: true,`);
  lines.push(`    metadata: { prism: { hook: hookName, kind: "additionalContext" } },`);
  lines.push(`  });`);
  lines.push(`};`);
  lines.push(`const promptText = (output: any) => (output.parts ?? []).filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\\n\\n");`);
  lines.push(`const permissionToolName = (input: any) => String(input.type ?? input.title ?? input.id ?? "permission");`);
  return lines;
};

const renderOpenCodeHookHandlers = (registrations: ReadonlyArray<HookRegistration>): string[] => {
  const before = registrations.filter((registration) => registration.nativeEvent === "tool.execute.before");
  const after = registrations.filter((registration) => registration.nativeEvent === "tool.execute.after");
  const promptSubmit = registrations.filter(
    (registration) => registration.nativeEvent === "chat.message",
  );
  const permissionRequest = registrations.filter(
    (registration) => registration.nativeEvent === "permission.ask",
  );
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
  if (promptSubmit.length > 0) {
    lines.push(`  "chat.message": async (input, output) => {`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "chat.message" }, prompt: promptText(output), cwd: context.directory, session: { id: input.sessionID }, native: { input, output } };`);
    promptSubmit.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    appendPromptContext(input, output, ${JSON.stringify(registration.hook.name)}, await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "prompt.submit", nativePayload));`);
    });
    lines.push(`  },`);
  }
  if (permissionRequest.length > 0) {
    lines.push(`  "permission.ask": async (input, output) => {`);
    lines.push(`    const toolName = permissionToolName(input);`);
    lines.push(`    const nativePayload = { target: { harness: "opencode", nativeEvent: "permission.ask" }, tool: { logical: input.type, name: toolName, input: { id: input.id, type: input.type, title: input.title, pattern: input.pattern, metadata: input.metadata, callID: input.callID } }, cwd: context.directory, session: { id: input.sessionID }, native: { input, output } };`);
    permissionRequest.forEach((registration) => {
      const registrationIndex = registrations.indexOf(registration);
      lines.push(`    if (${renderHookMatcher(registration, registration.hookPluginName)}) {`);
      lines.push(`      const result = await handlePrismHook(${hookIdentifier(registration.hook, registrationIndex)}, "permission.request", nativePayload);`);
      lines.push(`      if (result.decision === "block") output.status = "deny";`);
      lines.push(`      if (result.decision === "allow") output.status = "allow";`);
      lines.push(`    }`);
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
  lines.push("// Re-run `prism refresh --compile-only` to regenerate.");
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
    await writeTempBuildFile(
      options.tempRoot,
      "runtime/schema-bridge.ts",
      rewriteGeneratedOpenCodeRuntimeImportsForBundle(await getSchemaBridgeSource()),
  );

  if ((options.hookRegistrations?.length ?? 0) > 0) {
    await writeTempBuildFile(
      options.tempRoot,
      "runtime/hook-authoring-bridge.ts",
      GENERATED_HOOK_AUTHORING_BRIDGE,
    );
    await writeTempBuildFile(
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
      await writeTempBuildFile(
        options.tempRoot,
        `plugins/${mirror.pluginName}/${file.relativePath}`,
        normalized,
      );
    }
  }

  for (const spec of options.adapters) {
    const adapterName = spec.kind === "synthetic" ? spec.contractName : spec.toolName;
    await writeTempBuildFile(
      options.tempRoot,
      `adapters/${spec.pluginName}/${adapterName}.adapter.ts`,
      rewriteGeneratedOpenCodeRuntimeImportsForBundle(renderToolAdapter(spec)),
    );
  }

  return writeTempBuildFile(
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

const normalizeBuiltOpenCodeGeneratedPluginBundle = stripBundlerPathComments;

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
  const tempRootPrefix = ["prism", "opencode", "plugin", ""].join("-");
  const tempRoot = await makeTempBuildRoot(tempRootPrefix);
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
    await removeTempBuildRoot(tempRoot);
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
  readonly plugin: string;
}): Promise<DesiredFile[]> => [
  {
    targetPath: join(options.root, "dist", "server.mjs"),
    content: await buildGeneratedOpenCodePluginBundle(options),
    plugin: options.plugin,
  },
];

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
}

interface GeneratedRuntimePluginState {
  /** Source-plugin names whose generated runtime plugin is desired. */
  readonly desiredGeneratedPluginNames: Set<string>;
}

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
  };
};

const planAgentMarkdownWrites = (
  input: LowerInput,
  inventory: SyntheticToolInventory,
  files: DesiredFile[],
): void => {
  for (const agent of input.agents) {
    pushDesiredFile(files, {
      targetPath: agentMdPath(input.target, agent.name),
      content: renderAgentMarkdown(agent, inventory),
      plugin: input.target.sourcePluginName,
    });
  }
};

const planAgentConfigRegions = (
  input: LowerInput,
  jsonTarget: string,
): DesiredRegion[] => {
  const regions: DesiredRegion[] = [];
  for (const agent of input.agents) {
    const owned = composeAgentOwnedBlock(agent);
    for (const [key, value] of Object.entries(owned).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      regions.push({
        kind: "json-key",
        targetPath: jsonTarget,
        regionKey: `agent.${agent.name}.${key}`,
        jsonPath: ["agent", agent.name, key],
        value,
        plugin: input.target.sourcePluginName,
      });
    }
  }
  return regions;
};

const planOrbitSkillWrites = (
  input: LowerInput,
  files: DesiredFile[],
): void => {
  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: orbitSkillMdPath(input.target, orbit.name),
      content: renderGeneratedOrbitSkill({
        orbit,
        registry: input.registry,
        trailingNewline: false,
        renderFrontmatter: (values) => serializeFrontmatter(values, {}),
      }),
      plugin: input.target.sourcePluginName,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(
          input.target.root,
          `skills/${orbit.name}/references/${reference.filename}`,
        ),
        content: reference.content,
        plugin: input.target.sourcePluginName,
      });
    }
  }
};

const createGeneratedRuntimePluginState = (): GeneratedRuntimePluginState => ({
  desiredGeneratedPluginNames: new Set<string>(),
});

const rememberDesiredGeneratedPlugin = (
  state: GeneratedRuntimePluginState,
  pluginName: string,
): void => {
  state.desiredGeneratedPluginNames.add(pluginName);
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
): Promise<DesiredFile[]> => {
  if (options.sourceRuntimeBindings.length > 0 || runtime.hasAnyHook) {
    rememberDesiredGeneratedPlugin(state, input.target.sourcePluginName);
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
      plugin: input.target.sourcePluginName,
    });
  }

  return [];
};

const planOwnerGeneratedRuntimePlugins = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
  importPluginRoots: ReadonlyMap<string, string>,
): Promise<DesiredFile[]> => {
  const files: DesiredFile[] = [];
  for (const [pluginName, owner] of runtime.ownerPlugins) {
    rememberDesiredGeneratedPlugin(state, pluginName);
    const ownerMirror = await planRuntimePluginMirrors(
      pluginName,
      owner.pluginRoot,
      owner.bindings,
    );
    files.push(
      ...(await planGeneratedPluginFiles({
        root: generatedPluginRootForName(input.target, pluginName),
        pluginId: generatedPluginIdForName(pluginName),
        runtimeToolNamespace: pluginName,
        mirrors: [ownerMirror],
        importPluginRoots,
        adapters: planAdaptersForBindings(pluginName, owner.bindings),
        serverBindings: owner.bindings,
        hookRegistrations: [],
        // Attribute this owner-mirror bundle to its true owner (pluginName),
        // never to the consumer whose compile happened to trigger it
        // (PQ-162). The content is a pure projection of the owner's own
        // tools/ directory (bindingsFromPluginToolFiles reads straight off
        // disk, unfiltered by which consumer references what), so every
        // consumer that depends on this owner — and the owner's own
        // compile, if it targets OpenCode too — converges on identical
        // bytes at this exact path. Attributing it to the consumer instead
        // (as before) meant N different consumers of the same owner each
        // recorded themselves as sole owner of that owner's bundle, so a
        // real multi-consumer corpus (prism-plugins) hit PQ-162's
        // cross-plugin conflict guard on every such fan-in — a false
        // positive on a legitimately shared, convergent artifact, not the
        // genuine two-different-authors collision the law targets.
        plugin: pluginName,
      })),
    );
  }
  return files;
};

const planGeneratedRuntimePlugins = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
): Promise<DesiredFile[]> => {
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

const planGeneratedPluginConfigRegions = (
  input: LowerInput,
  jsonTarget: string,
  state: GeneratedRuntimePluginState,
): DesiredRegion[] =>
  [...state.desiredGeneratedPluginNames]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((pluginName): DesiredRegion[] => [
      {
        kind: "json-array-member",
        targetPath: jsonTarget,
        regionKey: `plugin.${generatedPluginIdForName(pluginName)}`,
        jsonPath: ["plugin"],
        value: generatedPluginEntryForName(input.target, pluginName),
        plugin: input.target.sourcePluginName,
      },
      {
        kind: "json-key",
        targetPath: jsonTarget,
        regionKey: `permission.${generatedPluginIdForName(pluginName)}`,
        jsonPath: ["permission", generatedToolDenyPatternForName(pluginName)],
        value: "deny",
        plugin: input.target.sourcePluginName,
      },
    ]);

export const planLowering = async (
  input: LowerInput
): Promise<LowerOutput> => {
  const jsonTarget = opencodeJsonPath(input.target);
  const runtime = await collectOpenCodeRuntimeContext(input);
  const generatedRuntimeState = createGeneratedRuntimePluginState();
  const files: DesiredFile[] = [];

  planAgentMarkdownWrites(input, runtime.inventory, files);
  planOrbitSkillWrites(input, files);
  files.push(...(await planGeneratedRuntimePlugins(input, runtime, generatedRuntimeState)));

  const regions: DesiredRegion[] = [
    ...planAgentConfigRegions(input, jsonTarget),
    ...planGeneratedPluginConfigRegions(input, jsonTarget, generatedRuntimeState),
  ];

  return { files, regions };
};

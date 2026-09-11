/**
 * OpenCode lowerer.
 *
 * Takes a set of ComposedAgents + sops and produces:
 *
 *   1. Per-agent markdown at <opencode-root>/agents/<name>.md with
 *      {name, description} frontmatter and the composed body.
 *
 *   2. Idempotent patches to <opencode-root>/opencode.json:
 *        - agent.<name> block (compiler-owned keys only; hand-authored keys preserved)
 *        - plugin array entry for the source-plugin-owned generated plugin
 *          module (for example
 *          `plugins/prism-generated-review-core/dist/server.mjs`) when the
 *          plugin owns canonical tools or hooks
 *
 *   3. Per-sop skills at <opencode-root>/skills/<name>/SKILL.md.
 *      Sops remain source-language constructs; the generated skill is
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
import { renderDerivedSopPhaseReferences } from "../derived-sop-skill.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { CanonicalTool, Hook, Sop } from "../sources.js";
import type { ResolvedContractBinding } from "../resolve.js";
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
import { bindingsFromCanonicalTools } from "../tool-bindings.js";
import {
  nativeHookEventName,
  pushDesiredFile,
  renderGeneratedSopSkill,
  serializeSimpleFrontmatter,
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
export interface OpenCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  /** Root plugin.json name for the compile invocation that owns this output. */
  readonly sourcePluginName: string;
}

const agentMdPath = (target: OpenCodeLowerTarget, name: string): string =>
  join(target.root, "agents", `${name}.md`);

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

const renderAgentMarkdown = (agent: ComposedAgent): string =>
  `${serializeSimpleFrontmatter({
    name: agent.name,
    description: agent.description,
  })}\n\n${agent.body}\n`;

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

interface AdapterSpec {
  readonly pluginName: string;
  readonly toolName: string;
  readonly sourcePath: string;
}

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
  readonly entryFilesByPlugin: Map<string, Map<string, MirrorFile>>;
}

const createPluginMirrorPlanningState = (): PluginMirrorPlanningState => ({
  rootsByPlugin: new Map(),
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

const ensureMirrorPluginRoot = (
  state: PluginMirrorPlanningState,
  pluginName: string,
  pluginRoot: string,
): void => {
  if (!state.rootsByPlugin.has(pluginName)) {
    state.rootsByPlugin.set(pluginName, { pluginRoot });
  }
};

const registerBindingMirrorEntry = (
  state: PluginMirrorPlanningState,
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): void => {
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
  bindings: ReadonlyArray<ResolvedContractBinding>,
): void => {
  for (const binding of bindings) {
    registerBindingMirrorEntry(state, sourcePluginName, binding);
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
): Map<string, MirrorFile> => new Map(state.entryFilesByPlugin.get(pluginName) ?? []);

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

const planPluginMirrors = async (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
  hookRegistrations: ReadonlyArray<HookRegistration> = [],
  sourcePluginRoot?: string,
): Promise<PluginMirror[]> => {
  const state = createPluginMirrorPlanningState();
  registerBindingMirrorEntries(state, sourcePluginName, bindings);
  registerHookMirrorEntries(state, sourcePluginName, hookRegistrations, sourcePluginRoot);
  return buildRuntimeClosureMirrors(state);
};

const planAdaptersForBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): AdapterSpec[] => {
  const seen = new Set<string>();
  const specs: AdapterSpec[] = [];
  for (const binding of bindings) {
    if (binding.toolPluginName !== sourcePluginName) continue;
    const key = `tool/${binding.toolPluginName}/${binding.toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({
      pluginName: binding.toolPluginName,
      toolName: binding.toolName,
      sourcePath: binding.toolSourcePath,
    });
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
  const helperNames = new Set(["defineHook", "hookEvent", "hookTool", "hookMatcher"]);
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

const GENERATED_HOOK_AUTHORING_BRIDGE = `// GENERATED by prism — do not edit.\nexport const defineHook = (hook) => hook;\nexport const hookEvent = {\n  toolBefore: "tool.before",\n  toolAfter: "tool.after",\n  promptSubmit: "prompt.submit",\n  permissionRequest: "permission.request",\n  sessionStart: "session.start",\n  sessionEnd: "session.end",\n};\nexport const hookTool = {\n  any: () => ({ kind: "hook-any-tool" }),\n  native: (name) => ({ kind: "hook-native-tool", name }),\n  canonical: (ref) => ({ kind: "hook-canonical-tool", ref }),\n};\nexport const hookMatcher = { tool: hookTool };\n`;

const renderToolAdapter = (
  spec: AdapterSpec,
): string => {
  // adapter is at: src/adapters/<pluginName>/<name>.adapter.ts
  // owner tool is at: src/plugins/<pluginName>/tools/<toolName>.tool.ts
  // bridge is at:   src/runtime/schema-bridge.ts
  const surfaceImport = `../../plugins/${spec.pluginName}/tools/${spec.toolName}.tool`;
  const bridgeImport = `../../runtime/schema-bridge`;
  const lines: string[] = [];
  lines.push(`// GENERATED by prism — do not edit.`);
  lines.push(`// Adapter for tool '${spec.pluginName}:${spec.toolName}'.`);
  lines.push("");
  lines.push(`import { tool, type ToolContext } from "@opencode-ai/plugin";`);
  lines.push(`import surface from "${surfaceImport}";`);
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
  bindings: ReadonlyArray<ResolvedContractBinding>,
  pluginId: string,
  adapters: ReadonlyArray<AdapterSpec>,
  hookRegistrations: ReadonlyArray<HookRegistration>,
): string => {
  const importEntries = adapters.map((a, idx) => {
    const ident = `adapter_${idx}_${a.pluginName.replace(/[^a-zA-Z0-9_]/g, "_")}_${a.toolName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const importPath = `./adapters/${a.pluginName}/${a.toolName}.adapter`;
    return { ident, importPath, spec: a };
  });

  const toolEntries: string[] = [];
  const emittedToolNames = new Set<string>();
  for (const binding of bindings) {
    const toolName = runtimeToolName(binding);
    const entry = importEntries.find(
      (e) =>
        e.spec.pluginName === binding.toolPluginName &&
        e.spec.toolName === binding.toolName,
    );
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

const planRuntimePluginMirrors = async (
  pluginName: string,
  pluginRoot: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<PluginMirror> => {
  const entries = [
    ...bindings.map((binding): MirrorFile => ({
      sourcePath: binding.toolSourcePath,
      relativePath: `tools/${binding.toolName}.tool.ts`,
    })),
    ...(await collectTsFilesInSubdirs(pluginRoot, ["schemas"])),
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
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ResolvedContractBinding>;
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
    await writeTempBuildFile(
      options.tempRoot,
      `adapters/${spec.pluginName}/${spec.toolName}.adapter.ts`,
      rewriteGeneratedOpenCodeRuntimeImportsForBundle(renderToolAdapter(spec)),
    );
  }

  return writeTempBuildFile(
    options.tempRoot,
    "server.ts",
    rewriteGeneratedOpenCodeRuntimeImportsForBundle(
      renderGeneratedServerTsForBindings(
        options.serverBindings,
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
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ResolvedContractBinding>;
  readonly hookRegistrations?: ReadonlyArray<HookRegistration>;
}): Promise<string> => {
  const tempRootPrefix = ["prism", "opencode", "plugin", ""].join("-");
  const tempRoot = await makeTempBuildRoot(tempRootPrefix);
  try {
    const mirrors = await expandBundleMirrors(options.mirrors, options.importPluginRoots);
    const entryPath = await writeTempGeneratedPluginSources({
      tempRoot,
      pluginId: options.pluginId,
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
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly adapters: ReadonlyArray<AdapterSpec>;
  readonly serverBindings: ReadonlyArray<ResolvedContractBinding>;
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
  readonly sops: ReadonlyArray<Sop>;
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

interface OpenCodeRuntimeContext {
  readonly hookRegistrations: ReadonlyArray<HookRegistration>;
  readonly hasAnyHook: boolean;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly hasAnyTool: boolean;
  readonly ownedGeneratedPluginId: string;
}

interface GeneratedRuntimePluginState {
  /** Source-plugin names whose generated runtime plugin is desired. */
  readonly desiredGeneratedPluginNames: Set<string>;
}

const collectOpenCodeRuntimeContext = async (
  input: LowerInput,
): Promise<OpenCodeRuntimeContext> => {
  const hookRegistrations = await planOpenCodeHookRegistrations(input.hooks ?? [], input.registry);
  const bindings = bindingsFromCanonicalTools(
    input.target.sourcePluginName,
    input.tools,
  );

  return {
    hookRegistrations,
    hasAnyHook: hookRegistrations.length > 0,
    bindings,
    hasAnyTool: bindings.length > 0,
    ownedGeneratedPluginId: generatedPluginId(input.target),
  };
};

const planAgentMarkdownWrites = (
  input: LowerInput,
  files: DesiredFile[],
): void => {
  for (const agent of input.agents) {
    pushDesiredFile(files, {
      targetPath: agentMdPath(input.target, agent.name),
      content: renderAgentMarkdown(agent),
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

const planSopSkillWrites = (
  input: LowerInput,
  files: DesiredFile[],
): void => {
  for (const sop of input.sops) {
    pushDesiredFile(files, {
      targetPath: join(input.target.root, "skills", sop.name, "SKILL.md"),
      content: renderGeneratedSopSkill({
        sop,
        trailingNewline: false,
        renderFrontmatter: (values) => serializeSimpleFrontmatter(values),
      }),
      plugin: input.target.sourcePluginName,
    });

    for (const reference of renderDerivedSopPhaseReferences(sop)) {
      pushDesiredFile(files, {
        targetPath: join(
          input.target.root,
          `skills/${sop.name}/references/${reference.filename}`,
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
  mirrors: ReadonlyArray<PluginMirror>,
  sourceCanonicalMirror?: PluginMirror,
): Map<string, string> => {
  const importPluginRoots = new Map<string, string>();
  for (const mirror of sourceCanonicalMirror
    ? mergePluginMirrors([...mirrors, sourceCanonicalMirror])
    : mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
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
    readonly sourceRuntimeBindings: ReadonlyArray<ResolvedContractBinding>;
  },
): Promise<DesiredFile[]> => {
  if (options.sourceRuntimeBindings.length > 0 || runtime.hasAnyHook) {
    rememberDesiredGeneratedPlugin(state, input.target.sourcePluginName);
    return planGeneratedPluginFiles({
      root: generatedPluginRoot(input.target),
      pluginId: runtime.ownedGeneratedPluginId,
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

const planGeneratedRuntimePlugins = async (
  input: LowerInput,
  runtime: OpenCodeRuntimeContext,
  state: GeneratedRuntimePluginState,
): Promise<DesiredFile[]> => {
  if (!runtime.hasAnyTool && !runtime.hasAnyHook) {
    return [];
  }

  const mirrors = await planPluginMirrors(
    input.target.sourcePluginName,
    runtime.bindings,
    runtime.hookRegistrations,
    input.registry?.pluginPath,
  );
  const sourceCanonicalMirror =
    runtime.bindings.length > 0
      ? await planRuntimePluginMirrors(
          input.target.sourcePluginName,
          pluginRootFromToolSource(runtime.bindings[0]!.toolSourcePath),
          runtime.bindings,
        )
      : undefined;
  const importPluginRoots = collectGeneratedPluginImportRoots(
    input,
    mirrors,
    sourceCanonicalMirror,
  );

  return planSourceGeneratedRuntimePlugin(input, runtime, state, {
    mirrors,
    sourceCanonicalMirror,
    importPluginRoots,
    sourceRuntimeBindings: runtime.bindings,
  });
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
    ]);

export const planLowering = async (
  input: LowerInput
): Promise<LowerOutput> => {
  const jsonTarget = opencodeJsonPath(input.target);
  const runtime = await collectOpenCodeRuntimeContext(input);
  const generatedRuntimeState = createGeneratedRuntimePluginState();
  const files: DesiredFile[] = [];

  planAgentMarkdownWrites(input, files);
  planSopSkillWrites(input, files);
  files.push(...(await planGeneratedRuntimePlugins(input, runtime, generatedRuntimeState)));

  const regions: DesiredRegion[] = [
    ...planAgentConfigRegions(input, jsonTarget),
    ...planGeneratedPluginConfigRegions(input, jsonTarget, generatedRuntimeState),
  ];

  return { files, regions };
};

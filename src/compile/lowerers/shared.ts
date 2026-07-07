/**
 * Shared lowerer plumbing (one-writer overhaul, WS5).
 *
 * Lowerers are PURE planners: `(registry, capabilities, paths) → LowerOutput`
 * — desired whole files plus desired shared-file regions. They never read
 * target state and never write harness roots; the sync engine
 * (src/sync/plan.ts + src/sync/apply.ts) classifies and applies everything,
 * deriving prunes from snapshot-vs-desired membership. Ownership is snapshot
 * manifest membership; marker-based ownership and ledgers do not live here.
 */

import { stripBundlerPathComments } from "../bundle-normalize.js";
import { join } from "node:path";
import { readFile } from "../../fs.js";
import type { HarnessId } from "../../types.js";
import type { ShimExposureContribution } from "../../state/shim-exposure.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import type { ComposedAgent } from "../compose.js";
import {
  renderDerivedOrbitPhaseReferences,
  renderDerivedOrbitSkillBody,
} from "../derived-orbit-skill.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { buildHookWrapperWithBun } from "../hook-wrapper-build.js";
import type { ResolvedHookMatch } from "../hooks.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import { effectBundleImportPath } from "../runtime-deps.js";
import { prepareHookBundleSource } from "../load.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  makeTempBuildRoot,
  removeTempBuildRoot,
  writeTempBuildFile,
} from "../temp-build-fs.js";
import {
  mcpBindingsForAgentsAndTools,
} from "../tool-bindings.js";

/** What every lowerer produces: desired whole files + shared-file regions. */
export interface LowerOutput {
  readonly files: ReadonlyArray<DesiredFile>;
  readonly regions: ReadonlyArray<DesiredRegion>;
  /**
   * The compiling plugin's OWN shared-shim contribution, present only on
   * harnesses whose stdio-shim config is one shared region per root
   * (codex-cli / hermes / cursor — see `SHARED_SHIM_HARNESSES`). The pipeline
   * persists it into the shim-exposure registry after a successful apply so
   * later compiles of OTHER plugins can render the full union. Empty arrays
   * mean "this plugin contributes nothing" (its registry entry is deleted).
   * Per-plugin-artifact harnesses (claude-code, grok, kimi, …) leave it
   * undefined — their per-compile scope is already the right scope.
   */
  readonly shimContribution?: ShimExposureContribution;
}

export type { ShimExposureContribution } from "../../state/shim-exposure.js";

/**
 * Reserved snapshot owner for the shared shim region. The region's content
 * is a cross-plugin union, so no single source plugin can own it: attributing
 * it to the compiling plugin made every per-plugin compile record its own
 * snapshot entry for the SAME fence (one manifest entry per MCP-bearing
 * plugin, all but the last stale — the `region.marker-drift` doctor storm).
 * Precedent for the reserved `#` scope suffix: `#file-router` in refresh.ts.
 */
export const SHIM_REGION_OWNER = "prism#shim";

/**
 * Harnesses whose stdio-shim MCP config is ONE shared region per harness
 * root (same region key for every plugin), rather than a per-plugin
 * generated artifact. These lowerers render the region from the shim
 * exposure union and report `shimContribution`.
 */
export const SHARED_SHIM_HARNESSES = ["codex-cli", "cursor", "hermes"] as const;
export type SharedShimHarnessId = (typeof SHARED_SHIM_HARNESSES)[number];

export const isSharedShimHarness = (target: HarnessId): target is SharedShimHarnessId =>
  (SHARED_SHIM_HARNESSES as ReadonlyArray<HarnessId>).includes(target);

/**
 * Deterministic shared-shim union: sorted + deduped member-wise, so the
 * rendered region is byte-identical regardless of which plugin compiles.
 */
export const unionedShimExposure = (
  prior: ShimExposureContribution | undefined,
  own: ShimExposureContribution,
): ShimExposureContribution => ({
  plugins: uniqueSorted([...(prior?.plugins ?? []), ...own.plugins]),
  enabledTools: uniqueSorted([...(prior?.enabledTools ?? []), ...own.enabledTools]),
});

export const uniqueSorted = (
  values: ReadonlyArray<string>,
  options?: { readonly dropEmpty?: boolean },
): string[] =>
  [
    ...new Set(
      options?.dropEmpty ? values.filter((value) => value.length > 0) : values,
    ),
  ].sort((left, right) => left.localeCompare(right));

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

export const yamlScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

export const serializeSimpleFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

export const renderGeneratedOrbitSkill = (options: {
  readonly orbit: Orbit;
  readonly registry: PluginRegistry | undefined;
  readonly trailingNewline: boolean;
  readonly renderFrontmatter?: (values: {
    readonly name: string;
    readonly description: string;
  }) => string;
}): string => {
  const frontmatter = {
    name: options.orbit.name,
    description: options.orbit.description,
  };
  const lines: string[] = [
    options.renderFrontmatter?.(frontmatter) ?? serializeSimpleFrontmatter(frontmatter),
    "",
  ];
  if (options.registry) {
    lines.push(renderDerivedOrbitSkillBody(options.orbit, options.registry));
  } else {
    lines.push(`# ${options.orbit.name}`, "", options.orbit.description, "");
    if (options.orbit.body.trim().length > 0) {
      lines.push(options.orbit.body.trim(), "");
    }
  }

  const rendered = lines.join("\n");
  return options.trailingNewline ? `${rendered.trimEnd()}\n` : rendered;
};

export const renderStandardOrbitSkill = (
  orbit: Orbit,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    registry,
    trailingNewline: false,
  });

export const regexEscape = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

export const matcherForResolvedToolHook = (
  match: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  const tool = match.tool;
  if (!tool) return undefined;
  if (tool.kind === "any") return ".*";
  if (tool.kind === "native-tools") {
    if (tool.names.length === 0) return undefined;
    if (tool.names.length === 1) return tool.names[0]!;
    return `^(?:${tool.names.map(regexEscape).join("|")})$`;
  }
  return canonicalToolNames.get(tool.ref) ?? tool.ref;
};

export const nativeHookEventName = <Name extends string>(
  event: Hook["event"],
  names: {
    readonly toolBefore: Name;
    readonly toolAfter: Name;
    readonly promptSubmit?: Name;
    readonly permissionRequest?: Name;
    readonly sessionStart: Name;
    readonly sessionEnd: Name;
  },
): Name => {
  switch (event) {
    case "tool.before":
      return names.toolBefore;
    case "tool.after":
      return names.toolAfter;
    case "prompt.submit":
      if (names.promptSubmit) return names.promptSubmit;
      throw new Error("prompt.submit hooks are not supported by this lowerer");
    case "permission.request":
      if (names.permissionRequest) return names.permissionRequest;
      throw new Error("permission.request hooks are not supported by this lowerer");
    case "session.start":
      return names.sessionStart;
    case "session.end":
      return names.sessionEnd;
  }
};

export const prePostSessionNativeHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "PreToolUse",
    toolAfter: "PostToolUse",
    sessionStart: "SessionStart",
    sessionEnd: "SessionEnd",
  });

const DEFAULT_HOOK_WRAPPER_TOOL_INPUT_EXPRESSION =
  "input?.tool?.input ?? input?.toolInput ?? input?.tool_input ?? input?.input ?? input?.args ?? input?.arguments ?? {}";

const DEFAULT_HOOK_WRAPPER_SESSION_SOURCE = `const nativeSession = (input) => {
  const id = input?.session?.id ?? input?.sessionId ?? input?.session_id;
  const transcriptPath = input?.session?.transcriptPath ?? input?.transcriptPath ?? input?.transcript_path;
  if (id === undefined && transcriptPath === undefined) return undefined;
  return {
    id: id === undefined ? undefined : String(id),
    transcriptPath: transcriptPath === undefined ? undefined : String(transcriptPath),
  };
};`;

const renderHookWrapperInputHelpers = (options?: {
  readonly nativeToolInputExpression?: string;
  readonly nativeSessionSource?: string;
}): string => `const parseInput = async () => {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return source.trim().length > 0 ? JSON.parse(source) : {};
};

const nativeToolName = (input) =>
  input?.tool?.name ?? input?.toolCall?.name ?? input?.toolName ?? input?.tool_name ?? input?.name ?? "";

const nativeToolInput = (input) =>
  ${options?.nativeToolInputExpression ?? DEFAULT_HOOK_WRAPPER_TOOL_INPUT_EXPRESSION};

${options?.nativeSessionSource ?? DEFAULT_HOOK_WRAPPER_SESSION_SOURCE}`;

const renderHookWrapperImports = (
  hookSourcePath: string,
  hookRuntimePath: string,
): string => `import { Effect } from ${JSON.stringify(effectBundleImportPath())};
import hook from ${JSON.stringify(hookSourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${JSON.stringify(hookRuntimePath.replace(/\\/g, "/"))};`;

const renderHookWrapperNormalizePayload = (options: {
  readonly event: Hook["event"];
  readonly harness: string;
  readonly nativeEvent: string;
  readonly cwdExpression: string;
  readonly fallbackSessionId: string;
  readonly toolAfterOutputExpression?: string;
  readonly nativeSessionEndReasonExpression?: string;
}): string => `const normalizePayload = (input) => {
  const target = { harness: ${JSON.stringify(options.harness)}, nativeEvent: ${JSON.stringify(options.nativeEvent)} };
  const cwd = ${options.cwdExpression};

  switch (${JSON.stringify(options.event)}) {
    case "tool.before":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input) }, cwd, session: nativeSession(input), native: input };
    case "tool.after":
      return {
        target,
        tool: {
          name: String(nativeToolName(input)),
          input: nativeToolInput(input),
          output: ${options.toolAfterOutputExpression ?? "input?.tool?.output ?? input?.toolOutput ?? input?.tool_output ?? input?.output"},
          success: input?.tool?.success ?? input?.success,
        },
        cwd,
        session: nativeSession(input),
        native: input,
      };
    case "prompt.submit":
      return { target, cwd, session: nativeSession(input), prompt: String(input?.prompt ?? ""), native: input };
    case "permission.request":
      return {
        target,
        tool: nativeToolName(input)
          ? { name: String(nativeToolName(input)), input: nativeToolInput(input) }
          : undefined,
        cwd,
        session: nativeSession(input),
        native: input,
      };
    case "session.start":
      return { target, cwd, session: nativeSession(input) ?? { id: ${JSON.stringify(options.fallbackSessionId)} }, native: input };
    case "session.end":
      return { target, cwd, session: nativeSession(input) ?? { id: ${JSON.stringify(options.fallbackSessionId)} }, reason: ${options.nativeSessionEndReasonExpression ?? "input?.reason"}, native: input };
  }
};`;

const renderHookWrapperExecution = (
  event: Hook["event"],
): string => `const unwrapDecode = (decoded, label) => {
  if (decoded && decoded._tag === "Right") return decoded.right;
  throw new Error("prism hook " + label + " validation failed");
};

const toPromise = (value) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);

const payload = unwrapDecode(
  decodeNativeHookPayloadForEvent(${JSON.stringify(event)}, normalizePayload(await parseInput())),
  "native payload",
);
const rawResult = await toPromise(hook.handle(payload));
const result = unwrapDecode(
  decodeHookResultForEvent(${JSON.stringify(event)}, rawResult ?? { decision: "continue" }),
  "result",
);`;

const renderHookWrapperBlockHandling = (
  event: Hook["event"],
  blockDecisionSource: string,
): string => `if ((${JSON.stringify(event)} === "tool.before" || ${JSON.stringify(event)} === "permission.request") && result.decision === "block") {
${blockDecisionSource}
}`;

export const renderPrePostSessionHookWrapperEntry = (options: {
  readonly hook: Hook;
  readonly hookRuntimePath: string;
  readonly hookSourcePath?: string;
  readonly harness: string;
  readonly nativeEvent: string;
  readonly cwdExpression: string;
  readonly fallbackSessionId: string;
  readonly toolAfterOutputExpression?: string;
  readonly nativeToolInputExpression?: string;
  readonly nativeSessionSource?: string;
  readonly nativeSessionEndReasonExpression?: string;
  readonly blockDecisionSource?: string;
  readonly resultHandlingSource?: string;
}): string =>
  [
    renderHookWrapperImports(options.hookSourcePath ?? options.hook.sourcePath, options.hookRuntimePath),
    renderHookWrapperInputHelpers({
      nativeToolInputExpression: options.nativeToolInputExpression,
      nativeSessionSource: options.nativeSessionSource,
    }),
    renderHookWrapperNormalizePayload({
      event: options.hook.event,
      harness: options.harness,
      nativeEvent: options.nativeEvent,
      cwdExpression: options.cwdExpression,
      fallbackSessionId: options.fallbackSessionId,
      toolAfterOutputExpression: options.toolAfterOutputExpression,
      nativeSessionEndReasonExpression: options.nativeSessionEndReasonExpression,
    }),
    renderHookWrapperExecution(options.hook.event),
    options.resultHandlingSource
      ?? (options.blockDecisionSource
        ? renderHookWrapperBlockHandling(options.hook.event, options.blockDecisionSource)
        : ""),
    "",
  ].join("\n\n");

export const bundleGeneratedHookWrapper = async (options: {
  readonly hook: Hook;
  readonly tempPrefix: string;
  readonly buildLabel: string;
  readonly renderEntry: (
    hook: Hook,
    hookRuntimePath: string,
    hookSourcePath: string,
  ) => string;
}): Promise<string> => {
  const tempRoot = await makeTempBuildRoot(options.tempPrefix);

  try {
    const bundleSource = await prepareHookBundleSource(options.hook.sourcePath);
    const hookRuntimePath = await writeTempBuildFile(
      tempRoot,
      "hook-runtime.mjs",
      GENERATED_HOOK_RUNTIME,
    );
    const entry = await writeTempBuildFile(
      tempRoot,
      "hook-entry.ts",
      options.renderEntry(options.hook, hookRuntimePath, bundleSource.transformedPath),
    );

    const outdir = join(tempRoot, "dist");
    try {
      await buildHookWrapperWithBun(entry, outdir, options.buildLabel);
    } finally {
      await bundleSource.cleanup();
    }

    const built = normalizeBuiltHookWrapper(await readFile(join(outdir, "wrapper.mjs")));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await removeTempBuildRoot(tempRoot);
  }
};

const normalizeBuiltHookWrapper = (content: string): string =>
  stripBundlerPathComments(content);

// ---------------------------------------------------------------------------
// Desired-file plumbing
// ---------------------------------------------------------------------------

export interface DesiredFileOptions {
  readonly mode?: number;
}

export const pushDesiredFile = (
  files: DesiredFile[],
  options: {
    readonly targetPath: string;
    readonly content: string;
    readonly plugin: string;
    readonly mode?: number;
  },
): void => {
  files.push({
    targetPath: options.targetPath,
    content: options.content,
    plugin: options.plugin,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
};

export interface GeneratedPluginPlanState {
  readonly files: DesiredFile[];
  /** Package-relative paths, kept for manifest rendering (kimi/pi). */
  readonly desiredRelativePaths: Set<string>;
}

export const createGeneratedPluginPlanState = (): GeneratedPluginPlanState => ({
  files: [],
  desiredRelativePaths: new Set(),
});

export interface GeneratedPluginPlanTarget {
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
}

export const createGeneratedPluginWritePusher =
  <Target extends GeneratedPluginPlanTarget>(
    resolveTarget: (target: Target, relativePath: string) => string,
  ): ((
    files: DesiredFile[],
    desiredRelativePaths: Set<string>,
    target: Target,
    relativePath: string,
    content: string,
    options?: DesiredFileOptions,
  ) => void) =>
  (
    files: DesiredFile[],
    desiredRelativePaths: Set<string>,
    target: Target,
    relativePath: string,
    content: string,
    options: DesiredFileOptions = {},
  ): void => {
    desiredRelativePaths.add(relativePath);
    pushDesiredFile(files, {
      targetPath: resolveTarget(target, relativePath),
      content,
      plugin: target.sourcePluginName,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
  };

export type GeneratedPluginWritePusher<Target extends GeneratedPluginPlanTarget> =
  ReturnType<typeof createGeneratedPluginWritePusher<Target>>;

export interface GeneratedPluginPlanInput<Target extends GeneratedPluginPlanTarget> {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: Target;
}

export const planGeneratedPluginManifest = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly pushWrite: GeneratedPluginWritePusher<Target>;
  readonly pluginId: string;
  readonly json: (value: unknown) => string;
  readonly relativePath?: string;
}): Promise<void> => {
  options.pushWrite(
    options.state.files,
    options.state.desiredRelativePaths,
    options.input.target,
    options.relativePath ?? ".claude-plugin/plugin.json",
    options.json({
      name: options.pluginId,
      version: options.input.target.sourcePluginVersion ?? "0.1.0",
      description: `Generated by prism from ${options.input.target.sourcePluginName}.`,
    }),
  );
};

export const planGeneratedPluginAgentWrites = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly pushWrite: GeneratedPluginWritePusher<Target>;
  readonly renderAgentMarkdown: (agent: ComposedAgent) => string;
}): Promise<void> => {
  for (const agent of options.input.agents) {
    options.pushWrite(
      options.state.files,
      options.state.desiredRelativePaths,
      options.input.target,
      `agents/${agent.name}.md`,
      options.renderAgentMarkdown(agent),
    );
  }
};

export const planGeneratedPluginSkillWrites = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly pushWrite: GeneratedPluginWritePusher<Target>;
}): Promise<void> => {
  for (const skill of options.input.skills ?? []) {
    options.pushWrite(
      options.state.files,
      options.state.desiredRelativePaths,
      options.input.target,
      `skills/${skill.name}/SKILL.md`,
      await readFile(skill.sourcePath),
    );
  }
};

export const planGeneratedPluginOrbitSkillWrites = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly pushWrite: GeneratedPluginWritePusher<Target>;
  readonly renderOrbitSkill: (orbit: Orbit) => string;
}): Promise<void> => {
  for (const orbit of options.input.orbits) {
    options.pushWrite(
      options.state.files,
      options.state.desiredRelativePaths,
      options.input.target,
      `skills/${orbit.name}/SKILL.md`,
      options.renderOrbitSkill(orbit),
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      options.pushWrite(
        options.state.files,
        options.state.desiredRelativePaths,
        options.input.target,
        `skills/${orbit.name}/references/${reference.filename}`,
        reference.content,
      );
    }
  }
};

export const planStandardGeneratedPluginOrbitSkillWrites = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly pushWrite: GeneratedPluginWritePusher<Target>;
}): Promise<void> => {
  await planGeneratedPluginOrbitSkillWrites({
    ...options,
    renderOrbitSkill: (orbit) =>
      renderStandardOrbitSkill(orbit, options.input.registry),
  });
};

export const planGeneratedPluginHookWrites = async <
  Target extends GeneratedPluginPlanTarget,
>(options: {
  readonly input: GeneratedPluginPlanInput<Target>;
  readonly state: GeneratedPluginPlanState;
  readonly renderHooksJson: (
    hooks: ReadonlyArray<Hook>,
    registry: PluginRegistry | undefined,
    target: Target,
    bindings: ReadonlyArray<ResolvedContractBinding>,
  ) => Promise<string>;
  readonly bundleHookWrapper: (hook: Hook) => Promise<string>;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<void> => {
  await planGeneratedPluginHooks({
    files: options.state.files,
    desiredRelativePaths: options.state.desiredRelativePaths,
    plugin: options.input.target.sourcePluginName,
    hooks: options.input.hooks ?? [],
    hooksJson: await options.renderHooksJson(
      options.input.hooks ?? [],
      options.input.registry,
      options.input.target,
      mcpBindingsForAgentsAndTools(
        options.input.target.sourcePluginName,
        options.input.tools,
        options.input.agents,
      ),
    ),
    bundleHookWrapper: options.bundleHookWrapper,
    resolveTarget: options.resolveTarget,
  });
};

export const planGeneratedPluginHooks = async (options: {
  readonly files: DesiredFile[];
  readonly desiredRelativePaths: Set<string>;
  readonly plugin: string;
  readonly hooks: ReadonlyArray<Hook>;
  readonly hooksJson: string;
  readonly bundleHookWrapper: (hook: Hook) => Promise<string>;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<void> => {
  options.desiredRelativePaths.add("hooks/hooks.json");
  pushDesiredFile(options.files, {
    targetPath: options.resolveTarget("hooks/hooks.json"),
    content: options.hooksJson,
    plugin: options.plugin,
  });

  for (const hook of options.hooks) {
    const relativePath = `hooks/${hook.name}.mjs`;
    options.desiredRelativePaths.add(relativePath);
    pushDesiredFile(options.files, {
      targetPath: options.resolveTarget(relativePath),
      content: await options.bundleHookWrapper(hook),
      plugin: options.plugin,
    });
  }
};

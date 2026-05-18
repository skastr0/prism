import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupFile,
  chmodFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
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
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { mcpBindingsForAgentsAndTools } from "../tool-bindings.js";
import type { LowerOperation } from "./opencode.js";

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

export const prismOwnerMarker = (
  ownerKind: string,
  sourcePluginName: string,
): string => `<!-- prism:${ownerKind} owner=${JSON.stringify(sourcePluginName)} -->`;

export const renderGeneratedOrbitSkill = (options: {
  readonly orbit: Orbit;
  readonly sourcePluginName: string;
  readonly registry: PluginRegistry | undefined;
  readonly ownerKind: string;
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
    prismOwnerMarker(options.ownerKind, options.sourcePluginName),
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
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    sourcePluginName,
    registry,
    ownerKind: "orbit-skill",
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
    readonly sessionStart: Name;
    readonly sessionEnd: Name;
  },
): Name => {
  switch (event) {
    case "tool.before":
      return names.toolBefore;
    case "tool.after":
      return names.toolAfter;
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
  input?.tool?.name ?? input?.toolName ?? input?.tool_name ?? input?.name ?? "";

const nativeToolInput = (input) =>
  ${options?.nativeToolInputExpression ?? DEFAULT_HOOK_WRAPPER_TOOL_INPUT_EXPRESSION};

${options?.nativeSessionSource ?? DEFAULT_HOOK_WRAPPER_SESSION_SOURCE}`;

const renderHookWrapperImports = (
  hook: Hook,
  hookRuntimePath: string,
): string => `import { Effect } from ${JSON.stringify(effectBundleImportPath())};
import hook from ${JSON.stringify(hook.sourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${JSON.stringify(hookRuntimePath.replace(/\\/g, "/"))};`;

const renderHookWrapperNormalizePayload = (options: {
  readonly event: Hook["event"];
  readonly harness: string;
  readonly nativeEvent: string;
  readonly cwdExpression: string;
  readonly fallbackSessionId: string;
  readonly toolAfterOutputExpression?: string;
}): string => `const normalizePayload = (input) => {
  const target = { harness: ${JSON.stringify(options.harness)}, nativeEvent: ${JSON.stringify(options.nativeEvent)} };
  const cwd = ${options.cwdExpression};

  switch (${JSON.stringify(options.event)}) {
    case "tool.before":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input) }, cwd, session: nativeSession(input) };
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
      };
    case "session.start":
      return { target, cwd, session: nativeSession(input) ?? { id: ${JSON.stringify(options.fallbackSessionId)} } };
    case "session.end":
      return { target, cwd, session: nativeSession(input) ?? { id: ${JSON.stringify(options.fallbackSessionId)} }, reason: input?.reason };
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
): string => `if (${JSON.stringify(event)} === "tool.before" && result.decision === "block") {
${blockDecisionSource}
}`;

export const renderPrePostSessionHookWrapperEntry = (options: {
  readonly hook: Hook;
  readonly hookRuntimePath: string;
  readonly harness: string;
  readonly nativeEvent: string;
  readonly cwdExpression: string;
  readonly fallbackSessionId: string;
  readonly toolAfterOutputExpression?: string;
  readonly nativeToolInputExpression?: string;
  readonly nativeSessionSource?: string;
  readonly blockDecisionSource?: string;
  readonly resultHandlingSource?: string;
}): string =>
  [
    renderHookWrapperImports(options.hook, options.hookRuntimePath),
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
  readonly renderEntry: (hook: Hook, hookRuntimePath: string) => string;
}): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), options.tempPrefix));

  try {
    const entry = join(tempRoot, "hook-entry.ts");
    const hookRuntimePath = join(tempRoot, "hook-runtime.mjs");
    await nodeWriteFile(hookRuntimePath, GENERATED_HOOK_RUNTIME);
    await nodeWriteFile(entry, options.renderEntry(options.hook, hookRuntimePath));

    const outdir = join(tempRoot, "dist");
    await buildHookWrapperWithBun(entry, outdir, options.buildLabel);

    const built = await readFile(join(outdir, "wrapper.mjs"));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

export const planGeneratedPluginFilePruning = async (options: {
  readonly root: string;
  readonly desiredRelativePaths: ReadonlySet<string>;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const existingFiles = await listDirRecursive(options.root);

  for (const relativePath of existingFiles.sort((left, right) => left.localeCompare(right))) {
    if (options.desiredRelativePaths.has(relativePath)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: options.resolveTarget(relativePath),
      targetType: "file",
      reason: "stale",
    });
  }

  return operations;
};

export const executeStandardLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean },
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  for (const operation of operations) {
    if (operation.reason === "unchanged") {
      if (
        (operation.kind === "write-md" || operation.kind === "write-plugin-file") &&
        operation.mode !== undefined
      ) {
        await chmodFile(operation.target, operation.mode);
      }
      continue;
    }

    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      if (options.backup && operation.kind === "write-md") {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content, { mode: operation.mode });
      continue;
    }

    if (operation.kind === "prune-plugin-path") {
      if (operation.targetType === "dir") await removeDir(operation.target);
      else await removeFile(operation.target);
    }
  }

  return { backups };
};

export type LowerWriteKind = "write-md" | "write-plugin-file";
export interface LowerWriteOptions {
  readonly mode?: number;
}

export const writeReason = async (
  target: string,
  content: string,
): Promise<"new" | "changed" | "unchanged"> => {
  if (!(await exists(target))) return "new";
  return (await readFile(target)) === content ? "unchanged" : "changed";
};

export const pushWriteOperation = async (
  operations: LowerOperation[],
  target: string,
  content: string,
  kind: LowerWriteKind = "write-plugin-file",
  options: LowerWriteOptions = {},
): Promise<void> => {
  operations.push({
    kind,
    target,
    content,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    reason: await writeReason(target, content),
  });
};

export const pushGeneratedPluginWrite = async (options: {
  readonly operations: LowerOperation[];
  readonly desiredRelativePaths: Set<string>;
  readonly relativePath: string;
  readonly target: string;
  readonly content: string;
  readonly kind?: LowerWriteKind;
  readonly mode?: number;
}): Promise<void> => {
  options.desiredRelativePaths.add(options.relativePath);
  await pushWriteOperation(
    options.operations,
    options.target,
    options.content,
    options.kind,
    { mode: options.mode },
  );
};

export const createGeneratedPluginWritePusher =
  <Target>(resolveTarget: (target: Target, relativePath: string) => string) =>
  async (
    operations: LowerOperation[],
    desiredRelativePaths: Set<string>,
    target: Target,
    relativePath: string,
    content: string,
    kind: LowerWriteKind = "write-plugin-file",
    options: LowerWriteOptions = {},
  ): Promise<void> => {
    await pushGeneratedPluginWrite({
      operations,
      desiredRelativePaths,
      relativePath,
      target: resolveTarget(target, relativePath),
      content,
      kind,
      ...options,
    });
  };

export type GeneratedPluginWritePusher<Target> = ReturnType<
  typeof createGeneratedPluginWritePusher<Target>
>;

export interface GeneratedPluginPlanState {
  readonly operations: LowerOperation[];
  readonly desiredRelativePaths: Set<string>;
}

export interface GeneratedPluginPlanTarget {
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
}

export interface GeneratedPluginPlanInput<Target extends GeneratedPluginPlanTarget> {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: Target;
}

export const createGeneratedPluginPlanState = (): GeneratedPluginPlanState => ({
  operations: [],
  desiredRelativePaths: new Set(),
});

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
  await options.pushWrite(
    options.state.operations,
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
    await options.pushWrite(
      options.state.operations,
      options.state.desiredRelativePaths,
      options.input.target,
      `agents/${agent.name}.md`,
      options.renderAgentMarkdown(agent),
      "write-md",
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
    await options.pushWrite(
      options.state.operations,
      options.state.desiredRelativePaths,
      options.input.target,
      `skills/${skill.name}/SKILL.md`,
      await readFile(skill.sourcePath),
      "write-md",
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
    await options.pushWrite(
      options.state.operations,
      options.state.desiredRelativePaths,
      options.input.target,
      `skills/${orbit.name}/SKILL.md`,
      options.renderOrbitSkill(orbit),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      await options.pushWrite(
        options.state.operations,
        options.state.desiredRelativePaths,
        options.input.target,
        `skills/${orbit.name}/references/${reference.filename}`,
        reference.content,
        "write-md",
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
      renderStandardOrbitSkill(
        orbit,
        options.input.target.sourcePluginName,
        options.input.registry,
      ),
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
    operations: options.state.operations,
    desiredRelativePaths: options.state.desiredRelativePaths,
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

export const planGeneratedPluginPruning = async (options: {
  readonly state: GeneratedPluginPlanState;
  readonly root: string;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<void> => {
  options.state.operations.push(
    ...(await planGeneratedPluginFilePruning({
      root: options.root,
      desiredRelativePaths: options.state.desiredRelativePaths,
      resolveTarget: options.resolveTarget,
    })),
  );
};

export const planGeneratedPluginHooks = async (options: {
  readonly operations: LowerOperation[];
  readonly desiredRelativePaths: Set<string>;
  readonly hooks: ReadonlyArray<Hook>;
  readonly hooksJson: string;
  readonly bundleHookWrapper: (hook: Hook) => Promise<string>;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<void> => {
  await pushGeneratedPluginWrite({
    operations: options.operations,
    desiredRelativePaths: options.desiredRelativePaths,
    relativePath: "hooks/hooks.json",
    target: options.resolveTarget("hooks/hooks.json"),
    content: options.hooksJson,
  });

  for (const hook of options.hooks) {
    const relativePath = `hooks/${hook.name}.mjs`;
    await pushGeneratedPluginWrite({
      operations: options.operations,
      desiredRelativePaths: options.desiredRelativePaths,
      relativePath,
      target: options.resolveTarget(relativePath),
      content: await options.bundleHookWrapper(hook),
    });
  }
};

import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  chmodFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import { backupManagedTarget } from "../../managed-backups.js";
import {
  hasOtherManagedCompileOwners,
  isSharedMcpRuntimeServerPath,
  managedEntryId,
  readHarnessLedger,
  removeLedgerEntries,
  upsertLedgerEntries,
  writeHarnessLedger,
  type HarnessLedger,
  type ManagedLedgerEntry,
} from "../../managed-ledger.js";
import type { HarnessId, HarnessScope } from "../../types.js";
import { computeContentHash } from "../../content-hash.js";
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
  input?.tool?.name ?? input?.toolCall?.name ?? input?.toolName ?? input?.tool_name ?? input?.name ?? "";

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
  readonly nativeSessionEndReasonExpression?: string;
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

    const built = normalizeBuiltHookWrapper(await readFile(join(outdir, "wrapper.mjs")));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const normalizeBuiltHookWrapper = (content: string): string =>
  content.replace(/^\/\/ .*\/prism-[^/\n]*hook-[^/\n]+\/[^\n]+\n/gm, "");

export const planGeneratedPluginFilePruning = async (options: {
  readonly root: string;
  readonly desiredRelativePaths: ReadonlySet<string>;
  readonly resolveTarget: (relativePath: string) => string;
}): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  if (options.desiredRelativePaths.size === 0) {
    if (await exists(options.root)) {
      operations.push({
        kind: "prune-plugin-path",
        target: options.root,
        targetType: "dir",
        reason: "stale",
      });
    }
    return operations;
  }

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
  options: ExecuteLoweringOptions,
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };
  const ledger = options.target ? await readHarnessLedger(options.target.harness) : undefined;

  for (const operation of operations) {
    const backup = await executeLoweringOperation(operation, options, ledger);
    if (backup) backups.push(backup);
  }

  if (ledger) await writeHarnessLedger(ledger);
  return { backups };
};

type LowerWriteOperation = Extract<
  LowerOperation,
  { readonly kind: "write-md" | "write-plugin-file" }
>;

type LowerConfigPatchOperation = Extract<LowerOperation, { readonly kind: "patch-config" }>;

type LowerPruneOperation = Extract<LowerOperation, { readonly kind: "prune-plugin-path" }>;

const isLowerWriteOperation = (operation: LowerOperation): operation is LowerWriteOperation =>
  operation.kind === "write-md" || operation.kind === "write-plugin-file";

const isLowerConfigPatchOperation = (
  operation: LowerOperation,
): operation is LowerConfigPatchOperation => operation.kind === "patch-config";

const executeLoweringOperation = async (
  operation: LowerOperation,
  options: ExecuteLoweringOptions,
  ledger: HarnessLedger | undefined,
): Promise<string | null> => {
  if (isLowerConfigPatchOperation(operation)) {
    return executeLoweringConfigPatch(operation, options, ledger);
  }
  if (operation.reason === "unchanged") {
    await applyUnchangedMode(operation);
    return null;
  }
  if (isLowerWriteOperation(operation)) {
    return executeLoweringWrite(operation, options, ledger);
  }
  if (operation.kind === "prune-plugin-path") {
    await executeLoweringPrune(operation, options.target, ledger);
  }
  return null;
};

const applyUnchangedMode = async (operation: LowerOperation): Promise<void> => {
  if (
    (isLowerWriteOperation(operation) || isLowerConfigPatchOperation(operation)) &&
    operation.mode !== undefined
  ) {
    await chmodFile(operation.target, operation.mode);
  }
};

const executeLoweringWrite = async (
  operation: LowerWriteOperation,
  options: ExecuteLoweringOptions,
  ledger: HarnessLedger | undefined,
): Promise<string | null> => {
  const backup =
    operation.kind === "write-md"
      ? await backupLoweringTarget(operation.target, options, "write")
      : null;
  await writeFile(operation.target, operation.content, { mode: operation.mode });
  if (ledger && options.target) {
    upsertLoweringEntry(ledger, options.target, operation.target, "file", operation.content);
  }
  return backup;
};

const executeLoweringConfigPatch = async (
  operation: LowerConfigPatchOperation,
  options: ExecuteLoweringOptions,
  ledger: HarnessLedger | undefined,
): Promise<string | null> => {
  if (operation.reason === "unchanged") {
    await applyUnchangedMode(operation);
    if (ledger && options.target) {
      removeLoweringEntry(ledger, options.target, operation.target, "file");
      upsertLoweringEntry(ledger, options.target, operation.target, "config", operation.content);
    }
    return null;
  }

  const backup = await backupLoweringTarget(operation.target, options, "patch");
  await writeFile(operation.target, operation.content, { mode: operation.mode });
  if (ledger && options.target) {
    removeLoweringEntry(ledger, options.target, operation.target, "file");
    upsertLoweringEntry(ledger, options.target, operation.target, "config", operation.content);
  }
  return backup;
};

const executeLoweringPrune = async (
  operation: LowerPruneOperation,
  target: LowerExecutionTargetContext | undefined,
  ledger: HarnessLedger | undefined,
): Promise<void> => {
  if (await shouldForgetSharedPrune(operation, target)) {
    if (ledger && target) {
      removeLoweringEntry(ledger, target, operation.target, operation.targetType);
    }
    return;
  }

  if (operation.targetType === "dir") await removeDir(operation.target);
  else await removeFile(operation.target);
  if (ledger && target) {
    removeLoweringEntry(ledger, target, operation.target, operation.targetType);
  }
};

const shouldForgetSharedPrune = async (
  operation: LowerPruneOperation,
  target: LowerExecutionTargetContext | undefined,
): Promise<boolean> => {
  const shared = (operation as LowerPruneOperation & { readonly shared?: boolean }).shared;
  if (!shared || !target || operation.targetType !== "file") return false;
  if (!isSharedMcpRuntimeServerPath(operation.target)) return false;
  return hasOtherManagedCompileOwners({
    currentHarness: target.harness,
    currentEntryId: lowerLedgerEntryId(target, operation.target, "file"),
    pluginName: target.sourcePluginName,
    targetPath: operation.target,
    kind: "file",
  });
};

export interface LowerExecutionTargetContext {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface ExecuteLoweringOptions {
  readonly dryRun: boolean;
  readonly target?: LowerExecutionTargetContext;
}

export const backupLoweringTarget = async (
  targetPath: string,
  options: ExecuteLoweringOptions,
  operation: "write" | "prune" | "patch",
): Promise<string | null> => {
  if (!options.target) return null;
  return backupManagedTarget({
    harness: options.target.harness,
    scope: options.target.scope,
    targetPath,
    operation,
  });
};

const lowerLedgerEntryId = (
  target: LowerExecutionTargetContext,
  targetPath: string,
  kind: "file" | "directory" | "config",
): string =>
  managedEntryId({
    harness: target.harness,
    scope: target.scope,
    root: target.root,
    pluginName: target.sourcePluginName,
    artifact: "compile",
    targetPath,
    kind,
  });

const upsertLoweringEntry = (
  ledger: HarnessLedger,
  target: LowerExecutionTargetContext,
  targetPath: string,
  kind: "file" | "config",
  content: string,
): void => {
  const now = new Date().toISOString();
  const entry: ManagedLedgerEntry = {
    id: lowerLedgerEntryId(target, targetPath, kind),
    pluginName: target.sourcePluginName,
    ...(target.sourcePluginVersion ? { pluginVersion: target.sourcePluginVersion } : {}),
    pluginPath: target.sourcePluginPath ?? target.root,
    harness: target.harness,
    scope: target.scope,
    root: target.root,
    artifact: "compile",
    targetPath,
    kind,
    contentHash: computeContentHash(content),
    updatedAt: now,
  };
  Object.assign(ledger, upsertLedgerEntries(ledger, [entry]));
};

const removeLoweringEntry = (
  ledger: HarnessLedger,
  target: LowerExecutionTargetContext,
  targetPath: string,
  targetType: "file" | "dir",
): void => {
  const kind = targetType === "dir" ? "directory" : "file";
  const entryIds = new Set([lowerLedgerEntryId(target, targetPath, kind)]);
  const resolvedPruneRoot = targetType === "dir" ? resolve(targetPath) : undefined;
  for (const entry of ledger.entries) {
    if (entry.pluginName !== target.sourcePluginName || entry.artifact !== "compile") continue;
    if (targetType === "file" && entry.kind === kind && entry.targetPath === targetPath) {
      entryIds.add(entry.id);
      continue;
    }
    if (targetType !== "dir" || !resolvedPruneRoot) continue;
    const entryRelativePath = relative(resolvedPruneRoot, resolve(entry.targetPath));
    if (
      entryRelativePath === "" ||
      (
        entryRelativePath !== ".." &&
        !entryRelativePath.startsWith(`..${sep}`) &&
        !isAbsolute(entryRelativePath)
      )
    ) {
      entryIds.add(entry.id);
    }
  }
  Object.assign(
    ledger,
    removeLedgerEntries(ledger, entryIds),
  );
};

export const recordLoweringConfigPatch = async (
  targetPath: string,
  content: string,
  options: ExecuteLoweringOptions,
): Promise<void> => {
  if (!options.target) return;
  const ledger = await readHarnessLedger(options.target.harness);
  removeLoweringEntry(ledger, options.target, targetPath, "file");
  upsertLoweringEntry(ledger, options.target, targetPath, "config", content);
  await writeHarnessLedger(ledger);
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

const relativePathInsideRoot = (root: string, targetPath: string): string | undefined => {
  const relativePath = relative(resolve(root), resolve(targetPath));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
};

const hasGeneratedSkillOwnerMarker = (content: string, sourcePluginName: string): boolean =>
  content.includes("<!-- prism:") && content.includes(`owner=${JSON.stringify(sourcePluginName)}`);

export const planCompileOwnedTargetedSkillPruning = async (options: {
  readonly target: LowerExecutionTargetContext;
  readonly skillsRoot: string;
  readonly desiredRelativePaths: ReadonlySet<string>;
}): Promise<LowerOperation[]> => {
  const ledger = await readHarnessLedger(options.target.harness);
  const operations: LowerOperation[] = [];

  for (const entry of ledger.entries) {
    if (entry.pluginName !== options.target.sourcePluginName) continue;
    if (entry.scope !== options.target.scope) continue;
    if (resolve(entry.root) !== resolve(options.target.root)) continue;
    if (entry.artifact !== "compile" || entry.kind !== "file") continue;

    const relativePath = relativePathInsideRoot(options.skillsRoot, entry.targetPath);
    if (!relativePath || options.desiredRelativePaths.has(relativePath)) continue;

    if (await exists(entry.targetPath)) {
      const content = await readFile(entry.targetPath);
      if (hasGeneratedSkillOwnerMarker(content, options.target.sourcePluginName)) continue;
    }

    operations.push({
      kind: "prune-plugin-path",
      target: entry.targetPath,
      targetType: "file",
      reason: "stale",
    });
  }

  return operations;
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

export const pushConfigPatchOperation = async (
  operations: LowerOperation[],
  target: string,
  content: string,
  options: LowerWriteOptions = {},
): Promise<void> => {
  operations.push({
    kind: "patch-config",
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
  <Target>(
    resolveTarget: (target: Target, relativePath: string) => string,
  ): ((
    operations: LowerOperation[],
    desiredRelativePaths: Set<string>,
    target: Target,
    relativePath: string,
    content: string,
    kind?: LowerWriteKind,
    options?: LowerWriteOptions,
  ) => Promise<void>) =>
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

export const planSharedMcpRuntimePrune = async (
  operations: LowerOperation[],
  target: string,
  owner?: {
    readonly harness: HarnessId;
    readonly scope: HarnessScope;
    readonly root: string;
    readonly sourcePluginName: string;
  },
): Promise<void> => {
  const hasTarget = await exists(target);
  const hasLedgerEntry = owner ? await hasSharedMcpRuntimeLedgerEntry(owner, target) : false;
  if (!hasTarget && !hasLedgerEntry) return;
  operations.push({
    kind: "prune-plugin-path",
    target,
    targetType: "file",
    shared: true,
    reason: "stale",
  } as LowerOperation);
};

const hasSharedMcpRuntimeLedgerEntry = async (
  owner: {
    readonly harness: HarnessId;
    readonly scope: HarnessScope;
    readonly root: string;
    readonly sourcePluginName: string;
  },
  target: string,
): Promise<boolean> => {
  const ledger = await readHarnessLedger(owner.harness);
  return ledger.entries.some((entry) =>
    entry.pluginName === owner.sourcePluginName &&
    entry.scope === owner.scope &&
    resolve(entry.root) === resolve(owner.root) &&
    entry.artifact === "compile" &&
    entry.kind === "file" &&
    resolve(entry.targetPath) === resolve(target)
  );
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

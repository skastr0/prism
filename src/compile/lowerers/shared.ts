import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import {
  renderDerivedOrbitSkillBody,
} from "../derived-orbit-skill.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { buildHookWrapperWithBun } from "../hook-wrapper-build.js";
import type { ResolvedHookMatch } from "../hooks.js";
import type { PluginRegistry } from "../registry.js";
import type { Hook, Orbit } from "../sources.js";
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
    if (operation.reason === "unchanged") continue;

    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      if (options.backup && operation.kind === "write-md") {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content);
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
): Promise<void> => {
  operations.push({
    kind,
    target,
    content,
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
}): Promise<void> => {
  options.desiredRelativePaths.add(options.relativePath);
  await pushWriteOperation(
    options.operations,
    options.target,
    options.content,
    options.kind,
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
  ): Promise<void> => {
    await pushGeneratedPluginWrite({
      operations,
      desiredRelativePaths,
      relativePath,
      target: resolveTarget(target, relativePath),
      content,
      kind,
    });
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

import { getHarness, isValidHarnessId } from "./harnesses.js";
import { getCompileTargetCapabilities } from "./lowerer-capabilities.js";
import {
  COMPILE_ARTIFACT_TYPES,
  PLUGIN_ARTIFACT_TYPES,
  TARGET_PRESET_IDS,
  type HarnessId,
  type HarnessScope,
  type PluginArtifactType,
  type PluginManifestTargets,
  type PluginRuntimeConfig,
  type PluginTargetId,
  type PrismMcpTransport,
  type TargetPresetId,
} from "./types.js";

export const SOURCE_NOUNS = [
  ...PLUGIN_ARTIFACT_TYPES,
  ...COMPILE_ARTIFACT_TYPES,
] as const;

export type SourceNoun = (typeof SOURCE_NOUNS)[number];

const TARGET_PRESETS = {
  "coding-harness": [
    "claude-code",
    "opencode",
    "codex-cli",
    "antigravity-cli",
    "kimi-code",
    "amp-code",
    "cursor",
    "factory-droid",
    "pi",
    "grok",
  ],
  "claw-harness": ["openclaw", "hermes"],
} as const satisfies Record<TargetPresetId, readonly HarnessId[]>;

const COMPILE_SOURCE_HARNESSES = [
  "opencode",
  "claude-code",
  "antigravity-cli",
  "codex-cli",
  "amp-code",
  "hermes",
  "grok",
  "factory-droid",
  "pi",
  "kimi-code",
] as const satisfies ReadonlyArray<HarnessId>;

const COMPILE_MANAGED_PLUGIN_ARTIFACT_TARGETS: Partial<Record<PluginArtifactType, readonly HarnessId[]>> = {
  rules: ["antigravity-cli", "pi", "kimi-code"],
  commands: ["amp-code", "claude-code", "pi", "kimi-code"],
  skills: ["pi", "kimi-code"],
};

export interface SourceRuntimeRequirements {
  readonly mcpConfigured: boolean;
  readonly mcpTransport?: PrismMcpTransport;
  readonly streamableHttpMcp: boolean;
}

export interface SourceSelectionEntry {
  readonly noun: SourceNoun;
  readonly declaredTargets: readonly PluginTargetId[];
  readonly harnesses: readonly HarnessId[];
}

export interface SourceSelection {
  readonly entries: readonly SourceSelectionEntry[];
  readonly runtime: PluginRuntimeConfig;
}

export interface TargetSourceSelection {
  readonly target: HarnessId;
  readonly scope?: HarnessScope;
  readonly nouns: Readonly<Record<SourceNoun, boolean>>;
  readonly runtime: SourceRuntimeRequirements;
  readonly hasLowerableSources: boolean;
}

export const getCompileManagedPluginArtifactTargets = (
  artifact: PluginArtifactType,
): readonly HarnessId[] => COMPILE_MANAGED_PLUGIN_ARTIFACT_TARGETS[artifact] ?? [];

export function isTargetPresetId(value: string): value is TargetPresetId {
  return TARGET_PRESET_IDS.includes(value as TargetPresetId);
}

export function isPluginTargetId(value: unknown): value is PluginTargetId {
  return typeof value === "string" && (isValidHarnessId(value) || isTargetPresetId(value));
}

const harnessSupportsDirectPluginArtifact = (
  harnessId: HarnessId,
  artifact: PluginArtifactType,
): boolean => {
  const harness = getHarness(harnessId);
  switch (artifact) {
    case "rules":
      return harness.rulesFile !== null || harness.rulesDir !== null;
    case "commands":
      return harness.supportsCommands && harness.commandsDir !== null;
    case "agents":
      return false;
    case "skills":
      return harness.supportsSkills && harness.skillsDir !== null;
  }
};

const targetSupportsCompileSourceNoun = (
  harnessId: HarnessId,
  noun: SourceNoun,
): boolean => {
  const capabilities = getCompileTargetCapabilities(harnessId);
  switch (noun) {
    case "agents":
      return capabilities.agents === "supported";
    case "tools":
      return capabilities.generatedCanonicalTools === "executable";
    case "hooks":
      return capabilities.hooks === "supported";
    case "orbits":
    case "toolspaces":
    case "modelspaces":
    case "skillspaces":
      return (COMPILE_SOURCE_HARNESSES as readonly HarnessId[]).includes(harnessId);
    case "rules":
    case "commands":
    case "skills":
      return getCompileManagedPluginArtifactTargets(noun).includes(harnessId);
  }
};

export const targetSupportsSourceNoun = (
  harnessId: HarnessId,
  noun: SourceNoun,
): boolean => {
  if (targetSupportsCompileSourceNoun(harnessId, noun)) return true;
  if (noun === "rules" || noun === "commands" || noun === "skills") {
    return harnessSupportsDirectPluginArtifact(harnessId, noun);
  }
  return false;
};

export function resolveManifestTargets(
  targets: readonly PluginTargetId[],
): HarnessId[] {
  const resolvedTargets = new Set<HarnessId>();

  for (const target of targets) {
    if (isTargetPresetId(target)) {
      for (const harnessId of TARGET_PRESETS[target]) {
        resolvedTargets.add(harnessId);
      }
      continue;
    }

    resolvedTargets.add(target);
  }

  return [...resolvedTargets];
}

export function resolveManifestTargetsForSourceNoun(
  targets: readonly PluginTargetId[],
  noun: SourceNoun,
): HarnessId[] {
  const resolvedTargets = new Set<HarnessId>();

  for (const target of targets) {
    if (isTargetPresetId(target)) {
      for (const harnessId of TARGET_PRESETS[target]) {
        if (targetSupportsSourceNoun(harnessId, noun)) {
          resolvedTargets.add(harnessId);
        }
      }
      continue;
    }

    resolvedTargets.add(target);
  }

  return [...resolvedTargets];
}

export function unsupportedDirectTargetsForSourceNoun(
  targets: readonly PluginTargetId[],
  noun: SourceNoun,
): HarnessId[] {
  return targets.filter(
    (target): target is HarnessId =>
      !isTargetPresetId(target) && !targetSupportsSourceNoun(target, noun),
  );
}

export function presetsWithNoSupportedTargetsForSourceNoun(
  targets: readonly PluginTargetId[],
  noun: SourceNoun,
): TargetPresetId[] {
  return targets.filter(
    (target): target is TargetPresetId =>
      isTargetPresetId(target) &&
      TARGET_PRESETS[target].every((harnessId) => !targetSupportsSourceNoun(harnessId, noun)),
  );
}

export function validateSourceTargetSupport(
  noun: SourceNoun,
  declaredTargets: readonly unknown[],
): string[] {
  const validTargets = declaredTargets.filter(isPluginTargetId);
  const unsupportedTargets = unsupportedDirectTargetsForSourceNoun(validTargets, noun);
  const emptyPresets = presetsWithNoSupportedTargetsForSourceNoun(validTargets, noun);
  const errors: string[] = [];

  if (unsupportedTargets.length > 0) {
    const unsupportedList = unsupportedTargets
      .map((harnessId) => `${harnessId} (${getHarness(harnessId).name})`)
      .join(", ");
    errors.push(
      noun === "agents"
        ? `targets.agents resolves to unsupported compile harnesses: ${unsupportedList}. Source agents must be authored as agents/*.agent.ts and can only target compile-supported harnesses.`
        : `targets.${noun} resolves to unsupported harnesses for ${noun}: ${unsupportedList}`,
    );
  }

  for (const preset of emptyPresets) {
    errors.push(
      `targets.${noun} preset '${preset}' resolves to no supported harnesses for ${noun}`,
    );
  }

  return errors;
}

export const sourceSelectionFromManifestTargets = (
  targets: PluginManifestTargets,
  options: { readonly runtime?: PluginRuntimeConfig } = {},
): SourceSelection => ({
  entries: SOURCE_NOUNS.flatMap((noun) => {
    const declaredTargets = targets[noun] ?? [];
    if (declaredTargets.length === 0) return [];
    return [{
      noun,
      declaredTargets,
      harnesses: resolveManifestTargetsForSourceNoun(declaredTargets, noun),
    }];
  }),
  runtime: options.runtime ?? {},
});

const emptySourceNounRecord = (): Record<SourceNoun, boolean> =>
  Object.fromEntries(SOURCE_NOUNS.map((noun) => [noun, false])) as Record<SourceNoun, boolean>;

const runtimeRequirementsForTarget = (
  runtime: PluginRuntimeConfig,
  target: HarnessId,
): SourceRuntimeRequirements => {
  const mcp = runtime.mcp?.[target];
  return {
    mcpConfigured: mcp !== undefined,
    ...(mcp?.transport ? { mcpTransport: mcp.transport } : {}),
    streamableHttpMcp: mcp?.transport === "streamable-http",
  };
};

export const selectSourcesForTarget = (
  selection: SourceSelection,
  target: HarnessId,
  options: { readonly scope?: HarnessScope } = {},
): TargetSourceSelection => {
  const nouns = emptySourceNounRecord();
  for (const entry of selection.entries) {
    if (entry.harnesses.includes(target)) {
      nouns[entry.noun] = true;
    }
  }

  return {
    target,
    ...(options.scope ? { scope: options.scope } : {}),
    nouns,
    runtime: runtimeRequirementsForTarget(selection.runtime, target),
    hasLowerableSources: SOURCE_NOUNS.some((noun) => nouns[noun]),
  };
};

import { Schema } from "effect";
import {
  type StableJsonValue,
  sortStableStrings,
  stableJsonHash,
  stableJsonValue,
} from "./stable-json.js";

export const COMPILE_MANIFEST_VERSION = 1 as const;

export const HarnessScopeSchema = Schema.Literal("global", "project");
export type HarnessScope = typeof HarnessScopeSchema.Type;

export const HarnessIdSchema = Schema.Literal(
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "cursor",
  "factory-droid",
  "grok",
  "hermes",
  "kimi-code",
  "opencode",
  "pi",
);
export type HarnessId = typeof HarnessIdSchema.Type;

export const CompileManifestPluginSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  sourceHash: Schema.String,
});
export type CompileManifestPlugin = typeof CompileManifestPluginSchema.Type;

export const CompileManifestTargetSchema = Schema.Struct({
  harness: HarnessIdSchema,
  scope: HarnessScopeSchema,
});
export type CompileManifestTarget = typeof CompileManifestTargetSchema.Type;

export const CompileManifestTraitSchema = Schema.Struct({
  id: Schema.String,
  ref: Schema.String,
});
export type CompileManifestTrait = typeof CompileManifestTraitSchema.Type;

export const CompileManifestGrantsSchema = Schema.Struct({
  tools: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
});
export type CompileManifestGrants = typeof CompileManifestGrantsSchema.Type;

export const CompileManifestModelBindingsSchema = Schema.Struct({
  modelspace: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
});
export type CompileManifestModelBindings = typeof CompileManifestModelBindingsSchema.Type;

const JsonRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const CompileManifestPerTargetSchema = Schema.Struct({
  scope: HarnessScopeSchema,
  model: Schema.NullOr(JsonRecordSchema),
  allowedTools: Schema.Array(Schema.String),
  allowedSkills: Schema.Array(Schema.String),
});
export type CompileManifestPerTarget = typeof CompileManifestPerTargetSchema.Type;

export const CompileManifestAgentSchema = Schema.Struct({
  name: Schema.String,
  plugin: Schema.String,
  description: Schema.String,
  sourceHash: Schema.String,
  traits: Schema.Array(CompileManifestTraitSchema),
  skills: Schema.Array(Schema.String),
  composed: Schema.Struct({
    grants: CompileManifestGrantsSchema,
    modelBindings: CompileManifestModelBindingsSchema,
    perTarget: Schema.Record({ key: Schema.String, value: CompileManifestPerTargetSchema }),
  }),
  manifestHash: Schema.String,
});
export type CompileManifestAgent = typeof CompileManifestAgentSchema.Type;

const CompileManifestV1Schema = Schema.Struct({
  version: Schema.Literal(COMPILE_MANIFEST_VERSION),
  plugins: Schema.Record({ key: Schema.String, value: CompileManifestPluginSchema }),
  compileTargets: Schema.Array(CompileManifestTargetSchema),
  agents: Schema.Record({ key: Schema.String, value: CompileManifestAgentSchema }),
  manifestHash: Schema.String,
});

export const CompileManifestSchema = CompileManifestV1Schema;
export type CompileManifest = typeof CompileManifestSchema.Type;

export interface UnsupportedCompileManifestVersion {
  readonly _tag: "UnsupportedCompileManifestVersion";
  readonly version: unknown;
  readonly message: string;
}

export const unsupportedCompileManifestVersion = (
  version: unknown,
): UnsupportedCompileManifestVersion => ({
  _tag: "UnsupportedCompileManifestVersion",
  version,
  message: `Unsupported compile manifest version: ${String(version)}. Expected ${COMPILE_MANIFEST_VERSION}.`,
});

const decodeJson = (json: string): unknown => JSON.parse(json) as unknown;

const versionFromJson = (json: string): unknown => {
  const parsed = decodeJson(json);
  return parsed && typeof parsed === "object" && "version" in parsed
    ? (parsed as { readonly version?: unknown }).version
    : undefined;
};

const decodeCompileManifestPayload = Schema.decodeUnknownEither(
  Schema.parseJson(CompileManifestSchema),
);
export type CompileManifestDecodeResult = ReturnType<typeof decodeCompileManifestPayload>;

export const decodeCompileManifest = (
  json: string,
): CompileManifestDecodeResult | UnsupportedCompileManifestVersion => {
  let version: unknown;
  try {
    version = versionFromJson(json);
  } catch {
    return decodeCompileManifestPayload(json);
  }
  if (version !== COMPILE_MANIFEST_VERSION) {
    return unsupportedCompileManifestVersion(version);
  }
  return decodeCompileManifestPayload(json);
};

const sortRecord = <T>(
  record: Readonly<Record<string, T>>,
  normalize: (value: T) => T,
): Record<string, T> =>
  Object.fromEntries(sortStableStrings(Object.keys(record)).map((key) => [key, normalize(record[key]!)]));

const sortStrings = (values: ReadonlyArray<string>): string[] => sortStableStrings(values);

const sortTargets = (targets: ReadonlyArray<CompileManifestTarget>): CompileManifestTarget[] =>
  [...targets].sort((left, right) =>
    left.harness === right.harness
      ? (left.scope === right.scope ? 0 : left.scope < right.scope ? -1 : 1)
      : left.harness < right.harness ? -1 : 1,
  );

const sortTraits = (traits: ReadonlyArray<CompileManifestTrait>): CompileManifestTrait[] =>
  [...traits].sort((left, right) =>
    left.id === right.id
      ? (left.ref === right.ref ? 0 : left.ref < right.ref ? -1 : 1)
      : left.id < right.id ? -1 : 1,
  );

const normalizeAgentForEncoding = (agent: CompileManifestAgent): CompileManifestAgent => ({
  ...agent,
  traits: sortTraits(agent.traits),
  skills: sortStrings(agent.skills),
  composed: {
    grants: {
      tools: sortStrings(agent.composed.grants.tools),
      skills: sortStrings(agent.composed.grants.skills),
    },
    modelBindings: stableJsonValue(agent.composed.modelBindings as StableJsonValue) as CompileManifestModelBindings,
    perTarget: sortRecord(agent.composed.perTarget, (slice) => ({
      ...slice,
      model: slice.model === null ? null : stableJsonValue(slice.model as StableJsonValue) as Record<string, unknown>,
      allowedTools: sortStrings(slice.allowedTools),
      allowedSkills: sortStrings(slice.allowedSkills),
    })),
  },
});

export const normalizeCompileManifestForEncoding = (manifest: CompileManifest): CompileManifest => ({
  version: COMPILE_MANIFEST_VERSION,
  plugins: sortRecord(manifest.plugins, (plugin) => plugin),
  compileTargets: sortTargets(manifest.compileTargets),
  agents: sortRecord(manifest.agents, normalizeAgentForEncoding),
  manifestHash: manifest.manifestHash,
});

export const encodeCompileManifest = (manifest: CompileManifest): string =>
  `${JSON.stringify(normalizeCompileManifestForEncoding(manifest), null, 2)}\n`;

export const agentManifestHashInput = (
  agent: CompileManifestAgent,
): Omit<CompileManifestAgent, "manifestHash"> => {
  const { manifestHash: _manifestHash, ...rest } = normalizeAgentForEncoding(agent);
  return rest;
};

export const computeAgentManifestHash = (agent: CompileManifestAgent): string =>
  stableJsonHash(agentManifestHashInput(agent) as StableJsonValue);

export const manifestHashInput = (
  manifest: CompileManifest,
): Omit<CompileManifest, "manifestHash"> => {
  const { manifestHash: _manifestHash, ...rest } = normalizeCompileManifestForEncoding(manifest);
  return rest;
};

export const computeCompileManifestHash = (manifest: CompileManifest): string =>
  stableJsonHash(manifestHashInput(manifest) as StableJsonValue);

export const verifyAgentManifestHash = (agent: CompileManifestAgent): boolean =>
  computeAgentManifestHash(agent) === agent.manifestHash;

export const verifyCompileManifestHash = (manifest: CompileManifest): boolean =>
  computeCompileManifestHash(manifest) === manifest.manifestHash;

export const getCompileManifestAgent = (
  manifest: CompileManifest,
  id: string,
): CompileManifestAgent | undefined => manifest.agents[id];

export const getCompileManifestAgentForTarget = (
  manifest: CompileManifest,
  id: string,
  harness: HarnessId,
): { readonly agent: CompileManifestAgent; readonly target: CompileManifestPerTarget } | undefined => {
  const agent = getCompileManifestAgent(manifest, id);
  const target = agent?.composed.perTarget[harness];
  return agent && target ? { agent, target } : undefined;
};

export const emptyCompileManifest = (): CompileManifest => {
  const manifest: CompileManifest = {
    version: COMPILE_MANIFEST_VERSION,
    plugins: {},
    compileTargets: [],
    agents: {},
    manifestHash: "",
  };
  return { ...manifest, manifestHash: computeCompileManifestHash(manifest) };
};

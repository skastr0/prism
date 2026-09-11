import { Schema } from "effect";
import {
  type StableJsonValue,
  compareCodePoint,
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
  "devin",
  "factory-droid",
  "grok",
  "hermes",
  "kimi-code",
  "opencode",
  "omp",
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

export const CompileManifestOrbitAgentSchema = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
});
export type CompileManifestOrbitAgent = typeof CompileManifestOrbitAgentSchema.Type;

export const CompileManifestOrbitPhaseIoSchema = Schema.Struct({
  inputs: Schema.Array(Schema.String),
  outputs: Schema.Array(Schema.String),
});
export type CompileManifestOrbitPhaseIo = typeof CompileManifestOrbitPhaseIoSchema.Type;

export const CompileManifestOrbitPhaseFramingSchema = Schema.Struct({
  telos: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
  coordination: Schema.optional(Schema.String),
  escalation: Schema.optional(Schema.String),
});
export type CompileManifestOrbitPhaseFraming = typeof CompileManifestOrbitPhaseFramingSchema.Type;

const JsonSchemaObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const CompileManifestOrbitPhaseContractSchema = Schema.Struct({
  input: Schema.optional(JsonSchemaObjectSchema),
  output: Schema.optional(JsonSchemaObjectSchema),
});
export type CompileManifestOrbitPhaseContract = typeof CompileManifestOrbitPhaseContractSchema.Type;

export const CompileManifestOrbitPhaseSchema = Schema.Struct({
  name: Schema.String,
  agents: Schema.Array(CompileManifestOrbitAgentSchema),
  criteria: Schema.Array(Schema.String),
  io: CompileManifestOrbitPhaseIoSchema,
  framing: CompileManifestOrbitPhaseFramingSchema,
  notes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  contract: Schema.optional(CompileManifestOrbitPhaseContractSchema),
});
export type CompileManifestOrbitPhase = typeof CompileManifestOrbitPhaseSchema.Type;

export const CompileManifestOrbitSchema = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
  phases: Schema.Array(CompileManifestOrbitPhaseSchema),
});
export type CompileManifestOrbit = typeof CompileManifestOrbitSchema.Type;

export const CompileManifestSopPhaseSchema = Schema.Struct({
  name: Schema.String,
  purpose: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  escalation: Schema.optional(Schema.String),
  input: Schema.optional(JsonSchemaObjectSchema),
  output: Schema.optional(JsonSchemaObjectSchema),
});
export type CompileManifestSopPhase = typeof CompileManifestSopPhaseSchema.Type;

export const CompileManifestSopSchema = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
  phases: Schema.Array(CompileManifestSopPhaseSchema),
});
export type CompileManifestSop = typeof CompileManifestSopSchema.Type;

/**
 * Side-effect authority class for a canonical tool (PQ-075). Migration is
 * default-then-require: declaration is optional today (undeclared tools omit
 * the field, both in tool source and in this manifest projection, so no
 * existing plugin corpus is broken by adding this type); a follow-on glyph
 * makes declaration mandatory (hard error, per AGENTS invariant 6) once
 * enforcement (preset fail-closed gating, dry-run surfacing) lands.
 */
export const ToolAuthoritySchema = Schema.Literal(
  "readOnly",
  "mutatesExternalState",
  "mutatesHarnessConfig",
  "startsDaemon",
  "requiresHumanApproval",
);
export type ToolAuthority = typeof ToolAuthoritySchema.Type;

export const CompileManifestCanonicalToolSchema = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
  authority: Schema.optional(ToolAuthoritySchema),
});
export type CompileManifestCanonicalTool = typeof CompileManifestCanonicalToolSchema.Type;

export const CompileManifestModelBindingsSchema = Schema.Struct({
  modelspace: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
});
export type CompileManifestModelBindings = typeof CompileManifestModelBindingsSchema.Type;

export const CompileManifestModelspaceSchema = Schema.Struct({
  plugin: Schema.String,
  modelspace: Schema.String,
  profiles: Schema.Array(Schema.String),
  profilesData: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Record({
        key: Schema.String,
        value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
    }),
  ),
});
export type CompileManifestModelspace = typeof CompileManifestModelspaceSchema.Type;

export const CompileManifestManagedSkillSchema = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
});
export type CompileManifestManagedSkill = typeof CompileManifestManagedSkillSchema.Type;

export const CompileManifestSkillspaceSchema = Schema.Struct({
  plugin: Schema.String,
  skillspace: Schema.String,
  skills: Schema.Array(Schema.String),
});
export type CompileManifestSkillspace = typeof CompileManifestSkillspaceSchema.Type;

const JsonRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const CompileManifestPerTargetSchema = Schema.Struct({
  scope: HarnessScopeSchema,
  model: Schema.NullOr(JsonRecordSchema),
});
export type CompileManifestPerTarget = typeof CompileManifestPerTargetSchema.Type;

export const CompileManifestAgentSchema = Schema.Struct({
  name: Schema.String,
  plugin: Schema.String,
  description: Schema.String,
  sourceHash: Schema.String,
  skills: Schema.Array(Schema.String),
  composed: Schema.Struct({
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
  modelspaces: Schema.Record({ key: Schema.String, value: CompileManifestModelspaceSchema }),
  skills: Schema.Record({ key: Schema.String, value: Schema.Union(CompileManifestManagedSkillSchema, CompileManifestSkillspaceSchema) }),
  tools: Schema.Record({ key: Schema.String, value: CompileManifestCanonicalToolSchema }),
  orbits: Schema.Record({ key: Schema.String, value: CompileManifestOrbitSchema }),
  sops: Schema.Record({ key: Schema.String, value: CompileManifestSopSchema }),
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

const sortOrbitAgents = (
  agents: ReadonlyArray<CompileManifestOrbitAgent>,
): CompileManifestOrbitAgent[] =>
  [...agents].sort((left, right) =>
    left.plugin === right.plugin
      ? compareCodePoint(left.name, right.name)
      : compareCodePoint(left.plugin, right.plugin),
  );

const normalizeOrbitPhaseForEncoding = (
  phase: CompileManifestOrbitPhase,
): CompileManifestOrbitPhase => ({
  name: phase.name,
  agents: sortOrbitAgents(phase.agents),
  criteria: sortStrings(phase.criteria),
  io: {
    inputs: sortStrings(phase.io.inputs),
    outputs: sortStrings(phase.io.outputs),
  },
  framing: stableJsonValue(phase.framing as StableJsonValue) as CompileManifestOrbitPhaseFraming,
  ...(phase.notes
    ? { notes: sortRecord(phase.notes, (value) => value) }
    : {}),
  ...(phase.contract
    ? {
        contract: {
          ...(phase.contract.input
            ? { input: stableJsonValue(phase.contract.input as StableJsonValue) as Record<string, unknown> }
            : {}),
          ...(phase.contract.output
            ? { output: stableJsonValue(phase.contract.output as StableJsonValue) as Record<string, unknown> }
            : {}),
        },
      }
    : {}),
});

const normalizeOrbitForEncoding = (orbit: CompileManifestOrbit): CompileManifestOrbit => ({
  plugin: orbit.plugin,
  name: orbit.name,
  phases: orbit.phases.map(normalizeOrbitPhaseForEncoding),
});

const sortOrbits = (orbits: ReadonlyArray<CompileManifestOrbit>): CompileManifestOrbit[] =>
  [...orbits].sort((left, right) =>
    left.plugin === right.plugin
      ? compareCodePoint(left.name, right.name)
      : compareCodePoint(left.plugin, right.plugin),
  );

const normalizeSopPhaseForEncoding = (
  phase: CompileManifestSopPhase,
): CompileManifestSopPhase => ({
  name: phase.name,
  purpose: phase.purpose,
  acceptanceCriteria: sortStrings(phase.acceptanceCriteria),
  ...(phase.escalation !== undefined ? { escalation: phase.escalation } : {}),
  ...(phase.input
    ? { input: stableJsonValue(phase.input as StableJsonValue) as Record<string, unknown> }
    : {}),
  ...(phase.output
    ? { output: stableJsonValue(phase.output as StableJsonValue) as Record<string, unknown> }
    : {}),
});

const normalizeSopForEncoding = (sop: CompileManifestSop): CompileManifestSop => ({
  plugin: sop.plugin,
  name: sop.name,
  phases: sop.phases.map(normalizeSopPhaseForEncoding),
});

const sortTools = (
  tools: ReadonlyArray<CompileManifestCanonicalTool>,
): CompileManifestCanonicalTool[] =>
  [...tools].sort((left, right) =>
    left.plugin === right.plugin
      ? compareCodePoint(left.name, right.name)
      : compareCodePoint(left.plugin, right.plugin),
  );

const normalizeAgentForEncoding = (agent: CompileManifestAgent): CompileManifestAgent => ({
  ...agent,
  skills: sortStrings(agent.skills),
  composed: {
    modelBindings: stableJsonValue(agent.composed.modelBindings as StableJsonValue) as CompileManifestModelBindings,
    perTarget: sortRecord(agent.composed.perTarget, (slice) => ({
      ...slice,
      model: slice.model === null ? null : stableJsonValue(slice.model as StableJsonValue) as Record<string, unknown>,
    })),
  },
});

export const normalizeCompileManifestForEncoding = (manifest: CompileManifest): CompileManifest => ({
  version: COMPILE_MANIFEST_VERSION,
  plugins: sortRecord(manifest.plugins, (plugin) => plugin),
  compileTargets: sortTargets(manifest.compileTargets),
  agents: sortRecord(manifest.agents, normalizeAgentForEncoding),
  modelspaces: sortRecord(manifest.modelspaces, (entry) => ({
    plugin: entry.plugin,
    modelspace: entry.modelspace,
    profiles: sortStrings(entry.profiles),
    profilesData: entry.profilesData
      ? sortRecord(entry.profilesData, (profileMap) =>
          sortRecord(profileMap, (targetBlock) =>
            stableJsonValue(targetBlock as StableJsonValue) as Record<string, unknown>,
          ),
        )
      : undefined,
  })),
  skills: sortRecord(manifest.skills, (entry) =>
    "skillspace" in entry && entry.skillspace !== undefined
      ? {
          plugin: entry.plugin,
          skillspace: entry.skillspace,
          skills: sortStrings(entry.skills),
        }
      : {
          plugin: entry.plugin,
          name: (entry as { readonly name: string }).name,
        },
  ),
  tools: sortRecord(manifest.tools, (entry) => entry),
  orbits: sortRecord(manifest.orbits, normalizeOrbitForEncoding),
  sops: sortRecord(manifest.sops, normalizeSopForEncoding),
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
    modelspaces: {},
    skills: {},
    tools: {},
    orbits: {},
    sops: {},
    manifestHash: "",
  };
  return { ...manifest, manifestHash: computeCompileManifestHash(manifest) };
};

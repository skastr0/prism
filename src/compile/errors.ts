/**
 * Typed compile errors for the structured compile-language pipeline.
 */

import { Schema } from "effect";

export class SourceParseError extends Schema.TaggedError<SourceParseError>()(
  "SourceParseError",
  {
    sourcePath: Schema.String,
    kind: Schema.Literal(
      "identity",
      "personality",
      "trait",
      "agent",
      "toolspace",
      "modelspace",
      "lifecycle",
      "tool",
    ),
    message: Schema.String,
  },
) {}

export class UnknownReferenceError extends Schema.TaggedError<UnknownReferenceError>()(
  "UnknownReferenceError",
  {
    agentName: Schema.String,
    sourcePath: Schema.String,
    field: Schema.Literal(
      "identity",
      "personality",
      "model",
      "trait",
      "tool",
      "tool-group",
      "lifecycle",
      "phase.lifecycle",
      "phase.agent",
    ),
    referenceName: Schema.String,
  },
) {}

export class UnknownDependencyError extends Schema.TaggedError<UnknownDependencyError>()(
  "UnknownDependencyError",
  {
    sourcePath: Schema.String,
    referenceName: Schema.String,
    depPrefix: Schema.String,
    declaredDeps: Schema.Array(Schema.String),
  },
) {}

export class DependencyCycleError extends Schema.TaggedError<DependencyCycleError>()(
  "DependencyCycleError",
  {
    cycle: Schema.Array(Schema.String),
  },
) {}

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()(
  "PluginManifestError",
  {
    pluginPath: Schema.String,
    message: Schema.String,
  },
) {}

export class UnknownTargetError extends Schema.TaggedError<UnknownTargetError>()(
  "UnknownTargetError",
  {
    target: Schema.String,
    supportedTargets: Schema.Array(Schema.String),
  },
) {}

export class InvalidTargetScopeError extends Schema.TaggedError<InvalidTargetScopeError>()(
  "InvalidTargetScopeError",
  {
    target: Schema.String,
    scope: Schema.String,
    message: Schema.String,
  },
) {}

export class UnsupportedTargetCapabilityError extends Schema.TaggedError<UnsupportedTargetCapabilityError>()(
  "UnsupportedTargetCapabilityError",
  {
    target: Schema.String,
    capability: Schema.Literal("generated-canonical-tools"),
    message: Schema.String,
  },
) {}

export class LifecycleValidationError extends Schema.TaggedError<LifecycleValidationError>()(
  "LifecycleValidationError",
  {
    sourcePath: Schema.String,
    lifecycleName: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class AgentValidationError extends Schema.TaggedError<AgentValidationError>()(
  "AgentValidationError",
  {
    sourcePath: Schema.String,
    agentName: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class DuplicateNameError extends Schema.TaggedError<DuplicateNameError>()(
  "DuplicateNameError",
  {
    kind: Schema.Literal(
      "identity",
      "personality",
      "trait",
      "agent",
      "toolspace",
      "modelspace",
      "lifecycle",
      "tool",
    ),
    name: Schema.String,
    firstPath: Schema.String,
    secondPath: Schema.String,
  },
) {}

export class AgentNameMismatchError extends Schema.TaggedError<AgentNameMismatchError>()(
  "AgentNameMismatchError",
  {
    sourcePath: Schema.String,
    fileStem: Schema.String,
    agentName: Schema.String,
  },
) {}

export class MissingTargetResolutionError extends Schema.TaggedError<MissingTargetResolutionError>()(
  "MissingTargetResolutionError",
  {
    agentName: Schema.String,
    referenceKind: Schema.Literal(
      "model-profile",
      "tool",
      "tool-group",
    ),
    referenceName: Schema.String,
    target: Schema.String,
  },
) {}

export type CompileError =
  | SourceParseError
  | UnknownReferenceError
  | LifecycleValidationError
  | AgentValidationError
  | UnknownTargetError
  | InvalidTargetScopeError
  | UnsupportedTargetCapabilityError
  | DuplicateNameError
  | AgentNameMismatchError
  | MissingTargetResolutionError
  | UnknownDependencyError
  | DependencyCycleError
  | PluginManifestError;

export const formatCompileError = (error: CompileError): string => {
  switch (error._tag) {
    case "SourceParseError":
      return `${error.sourcePath}: failed to parse ${error.kind}: ${error.message}`;
    case "UnknownReferenceError":
      return `${error.sourcePath}: agent '${error.agentName}' references unknown ${error.field} '${error.referenceName}'`;
    case "LifecycleValidationError":
      return `${error.sourcePath}: lifecycle '${error.lifecycleName}' invalid ${error.field}: ${error.message}`;
    case "AgentValidationError":
      return `${error.sourcePath}: agent '${error.agentName}' invalid ${error.field}: ${error.message}`;
    case "UnknownTargetError":
      return `unknown target '${error.target}'. Supported: ${error.supportedTargets.join(", ")}`;
    case "InvalidTargetScopeError":
      return `target '${error.target}' cannot use scope '${error.scope}': ${error.message}`;
    case "UnsupportedTargetCapabilityError":
      return `target '${error.target}' does not support ${error.capability}: ${error.message}`;
    case "DuplicateNameError":
      return `duplicate ${error.kind} '${error.name}': declared at ${error.firstPath} and ${error.secondPath}`;
    case "AgentNameMismatchError":
      return `${error.sourcePath}: agent 'name' field ('${error.agentName}') must match file stem ('${error.fileStem}')`;
    case "MissingTargetResolutionError":
      return `agent '${error.agentName}' uses ${error.referenceKind} '${error.referenceName}' which has no '${error.target}' target defined`;
    case "UnknownDependencyError":
      return `${error.sourcePath}: reference '${error.referenceName}' uses undeclared dep prefix '${error.depPrefix}'. Declared deps: [${error.declaredDeps.join(", ")}]`;
    case "DependencyCycleError":
      return `dependency cycle detected: ${error.cycle.join(" → ")}`;
    case "PluginManifestError":
      return `${error.pluginPath}: ${error.message}`;
  }
};

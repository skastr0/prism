/**
 * PrismError — the single tagged-error vocabulary that survives the
 * one-writer overhaul (docs/overhaul-one-writer-plan.md, WS2).
 *
 * Every failure Prism shows a human goes through this module:
 *   - one `PrismError` union the CLI edge can exhaustively match,
 *   - `renderPrismError` / `renderPrismCause` as the only renderers
 *     (one-line headline, optional indented detail, a `hint:` line),
 *   - never a stack trace.
 *
 * Compile-language errors keep living in `src/compile/errors.ts` (they are
 * constructed throughout the compile pipeline); this module absorbs them into
 * the union instead of duplicating them. New error families added by later
 * workstreams (SnapshotDecodeError, RegionPatchError, BlockedTargetError,
 * McpSupervisorError, TokenStoreError, …) join the union here.
 */

import { basename, join } from "node:path";
import { Schema } from "effect";
import { formatCompileError, type CompileError } from "./compile/errors.js";
import { expandPath } from "./fs.js";

// ---------------------------------------------------------------------------
// PluginManifestError — the one manifest error class (re-minted from the
// plain-Error class formerly in src/manifest.ts and the thin tagged variant
// formerly in src/compile/errors.ts).
// ---------------------------------------------------------------------------

const MANIFEST_FILE = "plugin.json";

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()(
  "PluginManifestError",
  {
    pluginPath: Schema.String,
    manifestPath: Schema.String,
    pluginLabel: Schema.String,
    summary: Schema.String,
    details: Schema.Array(Schema.String),
  },
) {
  /**
   * Build a manifest error from just a plugin path + summary, deriving the
   * manifest path and plugin label.
   */
  static forPlugin(
    pluginPath: string,
    summary: string,
    details: ReadonlyArray<string> = [],
    options: { readonly pluginName?: string } = {},
  ): PluginManifestError {
    const expandedPluginPath = expandPath(pluginPath);
    return new PluginManifestError({
      pluginPath: expandedPluginPath,
      manifestPath: join(expandedPluginPath, MANIFEST_FILE),
      pluginLabel: options.pluginName || basename(expandedPluginPath),
      summary,
      details: [...details],
    });
  }

  override get message(): string {
    const detailBlock =
      this.details.length > 0
        ? `:\n${this.details.map((detail) => `- ${detail}`).join("\n")}`
        : "";
    return `${this.summary} for plugin '${this.pluginLabel}' (${this.manifestPath})${detailBlock}`;
  }
}

// ---------------------------------------------------------------------------
// PrismConfigError — re-minted from the plain-Error class in src/prism-home.ts.
// ---------------------------------------------------------------------------

export class PrismConfigError extends Schema.TaggedError<PrismConfigError>()(
  "PrismConfigError",
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// BundleBuildError — re-minted from the plain-Error class in
// src/compile/mcp-bundle.ts.
// ---------------------------------------------------------------------------

export class BundleBuildError extends Schema.TaggedError<BundleBuildError>()(
  "BundleBuildError",
  {
    bundleKind: Schema.String,
    diagnostics: Schema.String,
  },
) {
  override get message(): string {
    return `failed to build ${this.bundleKind} bundle: ${this.diagnostics}`;
  }
}

// ---------------------------------------------------------------------------
// McpBundleMissingError — the MCP daemon lifecycle consumes (never builds)
// the canonical compiled bundle at PRISM_HOME/runtime/mcp/<plugin>/server.mjs.
// Serving without a compiled bundle is a typed, hinted failure.
// ---------------------------------------------------------------------------

export class McpBundleMissingError extends Schema.TaggedError<McpBundleMissingError>()(
  "McpBundleMissingError",
  {
    pluginName: Schema.String,
    bundlePath: Schema.String,
  },
) {
  get hint(): string {
    return `refresh the plugin first (prism install <plugin-path> --harness <id>) so the canonical MCP bundle exists, then retry`;
  }

  override get message(): string {
    return `Compiled MCP server bundle for plugin '${this.pluginName}' is missing: ${this.bundlePath}`;
  }
}

// ---------------------------------------------------------------------------
// LoweringOwnershipError — INTERIM, deleted in WS5.
//
// Drift-as-error dies with the sync engine: the one-writer model converges
// (repair + backup) instead of refusing. Until WS5 replaces the lowering
// write/prune authority gates in src/compile/lowerers/shared.ts, this tagged
// error carries the structured fields the edge renderer needs so the failure
// is at least explainable. Do not grow new call sites.
// ---------------------------------------------------------------------------

export const LOWERING_OWNERSHIP_REASONS = [
  "unowned-target",
  "drifted-target",
  "unowned-prune-target",
  "drifted-prune-target",
  "missing-base-hash",
  "stale-base-hash",
] as const;

const LOWERING_OWNERSHIP_HEADLINES: Record<
  (typeof LOWERING_OWNERSHIP_REASONS)[number],
  string
> = {
  "unowned-target": "Compile target exists but is not owned by Prism",
  "drifted-target": "Managed compile target changed outside Prism",
  "unowned-prune-target": "Compile prune target is not owned by Prism",
  "drifted-prune-target": "Managed compile prune target changed outside Prism",
  "missing-base-hash": "Compile config patch lacks base content hash",
  "stale-base-hash": "Compile config target changed while Prism was patching it",
};

export class LoweringOwnershipError extends Schema.TaggedError<LoweringOwnershipError>()(
  "LoweringOwnershipError",
  {
    reason: Schema.Literal(...LOWERING_OWNERSHIP_REASONS),
    targetPath: Schema.String,
    plugin: Schema.String,
    harness: Schema.String,
    ledgerHash: Schema.optional(Schema.String),
    ledgerUpdatedAt: Schema.optional(Schema.String),
    currentHash: Schema.optional(Schema.String),
    hint: Schema.String,
  },
) {
  get headline(): string {
    return `${LOWERING_OWNERSHIP_HEADLINES[this.reason]}: ${this.targetPath}`;
  }

  override get message(): string {
    return this.headline;
  }
}

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Every typed error Prism may surface to a human. `CompileError` (which
 * includes `PluginManifestError`) is defined in src/compile/errors.ts.
 */
export type PrismError =
  | CompileError
  | PrismConfigError
  | BundleBuildError
  | McpBundleMissingError
  | LoweringOwnershipError;

export const PRISM_ERROR_TAGS: ReadonlySet<string> = new Set([
  "SourceParseError",
  "UnknownReferenceError",
  "OrbitValidationError",
  "AgentValidationError",
  "UnknownTargetError",
  "InvalidTargetScopeError",
  "UnsupportedTargetCapabilityError",
  "DuplicateNameError",
  "AgentNameMismatchError",
  "MissingTargetResolutionError",
  "UnknownDependencyError",
  "DependencyCycleError",
  "PluginManifestError",
  "PrismConfigError",
  "BundleBuildError",
  "McpBundleMissingError",
  "LoweringOwnershipError",
]);

export const isPrismError = (value: unknown): value is PrismError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { _tag?: unknown })._tag === "string" &&
  PRISM_ERROR_TAGS.has((value as { _tag: string })._tag);

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

export interface PrismErrorRender {
  /** One line; never multi-line, never a stack frame. */
  readonly headline: string;
  /** Optional extra lines, rendered indented under the headline. */
  readonly detail?: ReadonlyArray<string>;
  /** Remediation; rendered as a trailing `hint: …` line. */
  readonly hint: string;
  /** Filesystem path the error is about, when it has one. */
  readonly path?: string;
}

const hashDetail = (error: LoweringOwnershipError): string[] => {
  const lines: string[] = [`plugin: ${error.plugin} · harness: ${error.harness}`];
  if (error.ledgerHash) {
    const updated = error.ledgerUpdatedAt ? ` (recorded ${error.ledgerUpdatedAt})` : "";
    lines.push(`ledger hash: ${error.ledgerHash}${updated}`);
  }
  if (error.currentHash) lines.push(`current hash: ${error.currentHash}`);
  return lines;
};

export const describePrismError = (error: PrismError): PrismErrorRender => {
  switch (error._tag) {
    case "PluginManifestError":
      return {
        headline: `${error.summary} for plugin '${error.pluginLabel}'`,
        detail: [`manifest: ${error.manifestPath}`, ...error.details],
        hint: "fix plugin.json at the listed manifest path, then re-run",
        path: error.manifestPath,
      };
    case "PrismConfigError":
      return {
        headline: error.message,
        hint: "fix config.json under PRISM_HOME (default ~/.prism), then re-run",
      };
    case "BundleBuildError":
      return {
        headline: `failed to build ${error.bundleKind} bundle`,
        detail: error.diagnostics
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        hint: "fix the reported bundler diagnostics in the plugin source, then re-run",
      };
    case "McpBundleMissingError":
      return {
        headline: error.message,
        hint: error.hint,
        path: error.bundlePath,
      };
    case "LoweringOwnershipError":
      return {
        headline: error.headline,
        detail: hashDetail(error),
        hint: error.hint,
        path: error.targetPath,
      };
    case "SourceParseError":
      return {
        headline: formatCompileError(error),
        hint: `fix the ${error.kind} source at ${error.sourcePath}, then re-run`,
        path: error.sourcePath,
      };
    case "UnknownReferenceError":
      return {
        headline: formatCompileError(error),
        hint: `declare ${error.field} '${error.referenceName}' in the plugin or remove the reference`,
        path: error.sourcePath,
      };
    case "OrbitValidationError":
      return {
        headline: formatCompileError(error),
        hint: `fix '${error.field}' of orbit '${error.orbitName}' at ${error.sourcePath}`,
        path: error.sourcePath,
      };
    case "AgentValidationError":
      return {
        headline: formatCompileError(error),
        hint: `fix '${error.field}' of agent '${error.agentName}' at ${error.sourcePath}`,
        path: error.sourcePath,
      };
    case "UnknownTargetError":
      return {
        headline: formatCompileError(error),
        hint: `use one of: ${error.supportedTargets.join(", ")}`,
      };
    case "InvalidTargetScopeError":
      return {
        headline: formatCompileError(error),
        hint: "rerun with a scope the target supports (see --scope)",
      };
    case "UnsupportedTargetCapabilityError":
      return {
        headline: formatCompileError(error),
        hint: `remove the ${error.capability} targeting for '${error.target}' or pick a harness that supports it`,
      };
    case "DuplicateNameError":
      return {
        headline: formatCompileError(error),
        hint: `rename one of the two ${error.kind} definitions so names are unique`,
        path: error.secondPath,
      };
    case "AgentNameMismatchError":
      return {
        headline: formatCompileError(error),
        hint: `rename the file to '${error.agentName}.agent.ts' or set name: '${error.fileStem}'`,
        path: error.sourcePath,
      };
    case "MissingTargetResolutionError":
      return {
        headline: formatCompileError(error),
        hint: `add a '${error.target}' target to ${error.referenceKind} '${error.referenceName}' or drop it from the agent`,
      };
    case "UnknownDependencyError":
      return {
        headline: formatCompileError(error),
        hint: `declare '${error.depPrefix}' under plugin.json deps or fix the reference`,
        path: error.sourcePath,
      };
    case "DependencyCycleError":
      return {
        headline: formatCompileError(error),
        hint: "break the dependency cycle by removing one of the listed edges",
      };
  }
};

const composeRender = (render: PrismErrorRender): string => {
  const lines = [render.headline];
  for (const detail of render.detail ?? []) lines.push(`  ${detail}`);
  lines.push(`  hint: ${render.hint}`);
  return lines.join("\n");
};

/** Render a PrismError for humans: headline, indented detail, hint line. */
export const renderPrismError = (error: PrismError): string =>
  composeRender(describePrismError(error));

// ---------------------------------------------------------------------------
// Cause walking — the CLI edge feeds whole Effect Causes (typed failures or
// defects from promise-throwing code) through here. Never renders stacks.
// ---------------------------------------------------------------------------

export interface PrismCauseDescription {
  readonly headline: string;
  readonly detail?: ReadonlyArray<string>;
  readonly hint?: string;
  readonly path?: string;
}

const describeDefect = (defect: unknown): PrismCauseDescription => {
  if (isPrismError(defect)) return describePrismError(defect);
  const hint =
    typeof (defect as { hint?: unknown })?.hint === "string"
      ? (defect as { hint: string }).hint
      : undefined;
  if (defect instanceof Error) {
    return {
      headline: `${defect.name}: ${defect.message}`,
      ...(hint ? { hint } : {}),
    };
  }
  if (typeof defect === "string") return { headline: defect };
  return { headline: `unknown failure: ${JSON.stringify(defect)}` };
};

/**
 * Walk an Effect Cause (or any thrown value) and describe the first Prism
 * error found. Unknown defects render name + message only — never `.stack`.
 */
export const describePrismCause = (cause: unknown): PrismCauseDescription => {
  let described: PrismCauseDescription | undefined;
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (described || !node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (isPrismError(node)) {
      described = describePrismError(node);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record._tag === "Die" && record.defect !== undefined) {
      described = describeDefect(record.defect);
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };

  walk(cause);
  if (described) return described;
  return describeDefect(cause);
};

/** Render a whole Cause for humans. The single edge renderer. */
export const renderPrismCause = (cause: unknown): string => {
  const described = describePrismCause(cause);
  const lines = [described.headline];
  for (const detail of described.detail ?? []) lines.push(`  ${detail}`);
  if (described.hint) lines.push(`  hint: ${described.hint}`);
  return lines.join("\n");
};

/**
 * Frozen contract for the plugins TUI. Every sibling module binds to these
 * types; nothing here imports a sibling (this is the root of the dep graph).
 *
 * Layering:
 *   model.ts (types) <- theme.ts (palette) <- status.ts / introspect.ts /
 *   preview.ts (pure transforms) <- data.ts (impure loaders) <- app.tsx (view)
 */

import type { HarnessId, HarnessScope, PluginManifest } from "../types.js";
import type { SyncOp } from "../sync/plan.js";
import type { HarnessPlan, PluginPlan } from "../plugin-inventory.js";
import type { PrismCauseDescription } from "../errors.js";

export type { HarnessId, HarnessScope, PluginManifest, HarnessPlan, PluginPlan };

export type SyncOpKind = SyncOp["kind"];

/**
 * The per-harness install state, worst-wins. Ordered least→most severe in
 * {@link CELL_STATE_SEVERITY}; `synced` is the only "good" state.
 */
export type CellState =
  | "synced" // converged — nothing to write
  | "not-installed" // create ops — never (or no longer) on disk
  | "stale" // repair source-changed — source moved ahead of disk
  | "orphaned" // prune — managed file no longer desired
  | "drifted" // repair drifted+backup — edited outside prism
  | "blocked" // foreign file refused placement
  | "error" // apply failure or compile error
  | "n/a"; // harness not targeted / nothing to probe

/** Severity order, low→high. The rollup keeps the highest. */
export const CELL_STATE_SEVERITY: readonly CellState[] = [
  "n/a",
  "synced",
  "not-installed",
  "stale",
  "orphaned",
  "drifted",
  "blocked",
  "error",
];

export interface HarnessStatusCell {
  readonly harness: HarnessId;
  readonly state: CellState;
  /** Counts per SyncOp kind across both legs (compile + file-router). */
  readonly opCounts: Readonly<Partial<Record<SyncOpKind, number>>>;
  readonly blockedCount: number;
  readonly failureCount: number;
  /** True when the compile leg failed before producing any plan. */
  readonly compileFailed: boolean;
  /** One-line human detail (e.g. compile-error headline, blocked hint). */
  readonly detail?: string;
}

/** A plugin's status for one scope (global or a project). */
export interface ScopeStatus {
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly cells: ReadonlyArray<HarnessStatusCell>;
  readonly worst: CellState;
}

export interface PluginRow {
  readonly pluginPath: string;
  readonly name: string;
  readonly version: string;
  readonly valid: boolean;
  /** Set when the manifest failed to load/validate. */
  readonly manifestError?: string;
  /** Worst state across all loaded scopes; undefined until status is computed. */
  readonly worst?: CellState;
  /** True when a matching MCP daemon record exists. */
  readonly hasMcp?: boolean;
}

// ── Introspection ──────────────────────────────────────────────────────────

export interface IntrospectionEntry {
  readonly name: string;
  readonly summary?: string;
  /** Full record, rendered as JSON in the detail view. */
  readonly json: unknown;
}

export interface IntrospectionNounGroup {
  readonly noun: string;
  readonly count: number;
  readonly entries: ReadonlyArray<IntrospectionEntry>;
}

export interface PluginIntrospection {
  readonly pluginName: string;
  readonly groups: ReadonlyArray<IntrospectionNounGroup>;
  /** Orbit-derived skills are synthesized at lower-time, not in registry.skills. */
  readonly orbitSkillCount: number;
}

export type IntrospectionResult =
  | { readonly ok: true; readonly value: PluginIntrospection }
  | { readonly ok: false; readonly error: PrismCauseDescription };

// ── Install preview ──────────────────────────────────────────────────────────

export interface InstallPreviewRow {
  readonly noun: string;
  readonly phase: "install" | "compile";
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly compileManaged: boolean;
}

export interface InstallPreview {
  readonly rows: ReadonlyArray<InstallPreviewRow>;
  readonly inlineSkills: ReadonlyArray<string>;
  /** Compact one-line target summary (formatManifestTargets). */
  readonly targetsSummary: string;
}

// ── Live refresh log ──────────────────────────────────────────────────────────

export type LogStatus = "pending" | "running" | "applied" | "skipped" | "blocked" | "failed";

export interface LogEntry {
  readonly id: string;
  readonly harness?: HarnessId;
  readonly targetPath: string;
  readonly kind: SyncOpKind;
  readonly status: LogStatus;
  readonly reason?: string;
  readonly error?: string;
}

// ── Drift drilldown ──────────────────────────────────────────────────────────

export interface DriftDetail {
  readonly targetPath: string;
  readonly snapshotHash?: string;
  readonly diskHash?: string;
  readonly backupPath?: string;
  readonly blockedHint?: string;
  readonly quarantinedPath?: string;
}

export type { PluginManifest as Manifest };

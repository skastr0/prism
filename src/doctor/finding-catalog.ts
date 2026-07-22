/**
 * Catalog of every `prism.doctor.finding.v1` code emitted by `src/doctor.ts`.
 *
 * This registry is the spine of the doctor contract tests. The meta-test in
 * `finding-catalog.test.ts` greps `src/doctor.ts` and fails CI when a code is
 * emitted but missing from this catalog.
 */

import type { DoctorFinding, DoctorFindingFamily, DoctorSeverity } from "../doctor.js";

export interface FindingCatalogEntry {
  readonly family: DoctorFindingFamily;
  readonly code: string;
  readonly severity: DoctorSeverity;
  /** How `doctor --fix` resolves this finding, if it has an automated path. */
  readonly fix?: DoctorFinding["fix"];
  readonly description: string;
}

export const FINDING_CATALOG: readonly FindingCatalogEntry[] = [
  // sync.plan
  {
    family: "sync.plan",
    code: "sync.blocked",
    severity: "error",
    fix: "manual",
    description: "A target file is blocked by an unmanaged foreign file.",
  },
  {
    family: "sync.plan",
    code: "sync.apply-failed",
    severity: "error",
    description: "A planned sync operation failed to apply.",
  },
  {
    family: "sync.plan",
    code: "sync.create",
    severity: "warning",
    fix: "refresh",
    description: "A managed file needs to be created.",
  },
  {
    family: "sync.plan",
    code: "sync.repair",
    severity: "warning",
    fix: "refresh",
    description: "A managed file differs from the desired content.",
  },
  {
    family: "sync.plan",
    code: "sync.prune",
    severity: "warning",
    fix: "refresh",
    description: "A managed file is no longer desired and should be pruned.",
  },
  {
    family: "sync.plan",
    code: "compile.failed",
    severity: "error",
    fix: "manual",
    description: "Compile failed for a targeted harness.",
  },
  {
    family: "sync.plan",
    code: "compile.blocked",
    severity: "error",
    fix: "manual",
    description: "Compile produced a blocked operation.",
  },
  {
    family: "sync.plan",
    code: "compile.apply-failed",
    severity: "error",
    fix: "manual",
    description: "Compile apply failed for a targeted harness.",
  },

  // harness.config
  {
    family: "harness.config",
    code: "config.json.invalid",
    severity: "error",
    fix: "manual",
    description: "A harness JSON config file is not valid JSON.",
  },
  {
    family: "harness.config",
    code: "config.toml.invalid",
    severity: "error",
    fix: "manual",
    description: "A harness TOML config file is not valid TOML.",
  },
  {
    family: "harness.config",
    code: "config.codex-hook-command-missing",
    severity: "error",
    fix: "refresh",
    description: "Codex hook command references a missing generated file.",
  },
  {
    family: "harness.config",
    code: "config.codex-hooks-json-split",
    severity: "warning",
    fix: "manual",
    description: "Codex hooks.json contains Prism-managed hooks that should live in config.toml.",
  },
  {
    family: "harness.config",
    code: "config.opencode-plugin-missing",
    severity: "error",
    fix: "refresh",
    description: "OpenCode plugin entry references a missing generated plugin.",
  },
  {
    family: "harness.config",
    code: "config.opencode-plugin-bundle-missing",
    severity: "error",
    fix: "refresh",
    description: "OpenCode generated plugin is missing its bundle.",
  },
  {
    family: "harness.config",
    code: "config.claude-hook-command-missing",
    severity: "error",
    fix: "refresh",
    description: "Claude hook command references a missing generated file.",
  },
  {
    family: "harness.config",
    code: "config.claude-hooks-json-invalid",
    severity: "error",
    fix: "refresh",
    description: "Claude generated plugin has invalid hooks.json.",
  },

  // snapshot.disk-drift
  {
    family: "snapshot.disk-drift",
    code: "snapshot.owned-missing",
    severity: "warning",
    fix: "refresh",
    description: "Prism-owned file recorded in snapshot is missing (PQ-157: refresh always heals this — recreate if still desired, drop if not).",
  },
  {
    family: "snapshot.disk-drift",
    code: "snapshot.owned-unreadable",
    severity: "error",
    fix: "manual",
    description: "Prism-owned file cannot be read.",
  },
  {
    family: "snapshot.disk-drift",
    code: "snapshot.owned-drift",
    severity: "warning",
    fix: "refresh",
    description: "Prism-owned file differs from the snapshot.",
  },

  // snapshot.gc
  {
    family: "snapshot.gc",
    code: "snapshot.manifest-invalid",
    severity: "error",
    fix: "gc",
    description: "Snapshot manifest is not decodeable.",
  },
  {
    family: "snapshot.gc",
    code: "snapshot.dead-root",
    severity: "warning",
    fix: "gc",
    description: "Snapshot root no longer exists.",
  },
  {
    family: "snapshot.gc",
    code: "snapshot.dead-root-dropped",
    severity: "info",
    description: "Dropped snapshot for missing root (only emitted during --fix).",
  },
  {
    family: "snapshot.gc",
    code: "snapshot.stale-entry-dropped",
    severity: "info",
    description: "Dropped stale snapshot entry for missing file (only emitted during --fix).",
  },

  // namespace.stray
  {
    family: "namespace.stray",
    code: "namespace.unowned-prism-path",
    severity: "warning",
    fix: "manual",
    description: "Prism-looking path is not recorded in the snapshot.",
  },

  // region.integrity
  {
    family: "region.integrity",
    code: "region.marker-count",
    severity: "error",
    fix: "refresh",
    description: "Expected one begin/end fence for a marker region.",
  },
  {
    family: "region.integrity",
    code: "region.marker-drift",
    severity: "warning",
    fix: "refresh",
    description: "Prism-owned marker region differs from the snapshot.",
  },
  {
    family: "region.integrity",
    code: "region.json-key-missing",
    severity: "error",
    fix: "refresh",
    description: "Prism-owned JSON key region is missing.",
  },
  {
    family: "region.integrity",
    code: "region.json-array-member-missing",
    severity: "error",
    fix: "refresh",
    description: "Prism-owned JSON array member is missing.",
  },
  {
    family: "region.integrity",
    code: "region.ref-missing",
    severity: "error",
    fix: "refresh",
    description: "Snapshot region entry is missing a serialized region key.",
  },
  {
    family: "region.integrity",
    code: "region.ref-invalid",
    severity: "error",
    fix: "refresh",
    description: "Snapshot region key is not parseable.",
  },
  {
    family: "region.integrity",
    code: "region.target-missing",
    severity: "error",
    fix: "refresh",
    description: "Shared config file recorded in snapshot is missing.",
  },
  {
    family: "region.integrity",
    code: "region.json-invalid",
    severity: "error",
    fix: "manual",
    description: "Shared JSON config with Prism regions is not parseable.",
  },

  // determinism.selfcheck
  {
    family: "determinism.selfcheck",
    code: "determinism.compile-failed",
    severity: "warning",
    fix: "refresh",
    description: "Dry-run compile self-check failed.",
  },
  {
    family: "determinism.selfcheck",
    code: "determinism.operations-changed",
    severity: "error",
    fix: "manual",
    description: "Two dry-run compiles produced different operation plans.",
  },

  // launchd.residue
  {
    family: "launchd.residue",
    code: "launchd.orphaned-service",
    severity: "error",
    fix: "gc",
    description: "A retired launchd-era com.prism.mcp.* service is still loaded and/or its plist survives on disk.",
  },
  {
    family: "launchd.residue",
    code: "launchd.dead-bundle-respawn",
    severity: "error",
    fix: "gc",
    description: "A retired launchd service is respawning against a deleted MCP server bundle path.",
  },
  {
    family: "launchd.residue",
    code: "launchd.residue-dropped",
    severity: "info",
    description: "Booted out and removed retired launchd-era Prism MCP residue (only emitted during --fix).",
  },

  // workflow.store-registry
  {
    family: "workflow.store-registry",
    code: "workflow.store-registry.stale-entry",
    severity: "info",
    fix: "gc",
    description: "The workflow store registry references a store whose backing file no longer exists.",
  },
  {
    family: "workflow.store-registry",
    code: "workflow.store-registry.stale-entry-dropped",
    severity: "info",
    description: "Dropped a workflow store registry entry for a missing store (only emitted during --fix).",
  },
] as const;

export const FINDING_CODES: readonly string[] = FINDING_CATALOG.map((entry) => entry.code);

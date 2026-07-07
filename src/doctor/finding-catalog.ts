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
    code: "config.mcp-shim-command-unresolvable",
    severity: "error",
    fix: "refresh",
    description: "A harness's stdio-shim MCP server command does not resolve to a prism binary.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-args-invalid",
    severity: "error",
    fix: "refresh",
    description: "A harness's stdio-shim MCP server args do not invoke 'prism mcp shim'.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-env-harness-mismatch",
    severity: "error",
    fix: "refresh",
    description: "A harness's stdio-shim MCP server env.PRISM_SHIM_HARNESS is missing or wrong.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-env-plugins-missing",
    severity: "error",
    fix: "refresh",
    description: "A harness's stdio-shim MCP server is missing env.PRISM_SHIM_PLUGINS.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-plugin-bundle-missing",
    severity: "error",
    fix: "refresh",
    description: "A stdio-shim MCP server references an owner plugin with no compiled MCP bundle.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-allowlist-invalid",
    severity: "error",
    fix: "refresh",
    description: "A stdio-shim MCP server allowlist entry does not match the wire naming scheme.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-json-invalid",
    severity: "error",
    fix: "manual",
    description: "A generated stdio-shim MCP JSON config file is not valid JSON.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-per-plugin-naming-missing",
    severity: "error",
    fix: "refresh",
    description: "A per-owner-plugin stdio-shim MCP server is missing env.PRISM_SHIM_NAMING=per-plugin.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-per-plugin-plugin-mismatch",
    severity: "error",
    fix: "refresh",
    description: "A per-owner-plugin stdio-shim MCP server's PRISM_SHIM_PLUGINS or server key does not name exactly one matching owner.",
  },
  {
    family: "harness.config",
    code: "config.mcp-shim-legacy-aggregated-entry",
    severity: "warning",
    fix: "manual",
    description: "A retired aggregated `prism-mcp-shim` entry survives under the per-owner-plugin scheme.",
  },
  {
    family: "harness.config",
    code: "config.codex-enabled-tools-invalid",
    severity: "error",
    fix: "refresh",
    description: "Codex MCP server has non-array enabled_tools.",
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
    code: "config.claude-mcp-json-invalid",
    severity: "error",
    fix: "refresh",
    description: "Claude generated plugin has invalid .mcp.json.",
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
    severity: "error",
    fix: "refresh",
    description: "Prism-owned file recorded in snapshot is missing.",
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

  // mcp.health
  {
    family: "mcp.health",
    code: "mcp.port-conflict",
    severity: "error",
    fix: "mcp-restart",
    description: "MCP server port is occupied but no Prism pid is recorded.",
  },
  {
    family: "mcp.health",
    code: "mcp.stale-pid",
    severity: "warning",
    fix: "mcp-restart",
    description: "Recorded MCP server pid is not running.",
  },
  {
    family: "mcp.health",
    code: "mcp.stale-build",
    severity: "error",
    fix: "mcp-restart",
    description: "MCP runtime server hash does not match the generated bundle.",
  },
  {
    family: "mcp.health",
    code: "mcp.stale-health",
    severity: "error",
    fix: "mcp-restart",
    description: "MCP runtime health mismatch.",
  },
  {
    family: "mcp.health",
    code: "mcp.status-unavailable",
    severity: "warning",
    fix: "refresh",
    description: "Could not determine MCP server status.",
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
] as const;

export const FINDING_CODES: readonly string[] = FINDING_CATALOG.map((entry) => entry.code);

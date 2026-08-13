/**
 * Configure TUI domain model — multi-harness inventory + settings catalogues.
 * Pure types — no I/O. Inventory + mutations + TUI all bind to these.
 */

import type { HarnessId } from "../types.js";

/** All Prism harnesses are configure targets. */
export type ConfigureHarnessId = HarnessId;

/** How present a harness is on this machine. */
export type HarnessPresence =
  | "present" // root exists and/or binary found and/or snapshot non-empty
  | "snapshot-only" // ledger has entries but root/binary missing
  | "absent";

export type ArtifactNoun =
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "rules"
  | "bundle"
  | "tool-runtime"
  /** Hermes (and similar) identity prose — SOUL.md */
  | "soul"
  /** Hermes memories/*.md */
  | "memory"
  /** Hermes identity-brief / profile.yaml / vouch */
  | "identity"
  | "other";

export type OwnershipKind =
  | "prism-owned" // whole file in snapshot mode=owned
  | "prism-region" // fenced/json fragment in shared file
  | "prism-namespace" // path looks Prism-generated but not ledgered (stray)
  | "foreign"; // on disk under harness dirs, not Prism

export interface ArtifactEntry {
  readonly id: string;
  readonly noun: ArtifactNoun;
  readonly ownership: OwnershipKind;
  readonly targetPath: string;
  readonly relativePath: string;
  readonly plugin?: string;
  readonly regionKey?: string;
  readonly label: string;
  readonly detail?: string;
  /**
   * Stable identity for dedup across install sites
   * (e.g. skill name shared by `skills/foo` and `skills/prism-generated-X/skills/foo`).
   */
  readonly logicalKey?: string;
  /**
   * Install-site key for the same logical item in different places
   * (e.g. `direct:foo` vs `bundle:tower:foo`).
   */
  readonly siteKey?: string;
  /** Primary unit (SKILL.md / agent.md) vs support file under the same package. */
  readonly role?: "primary" | "support";
}

/**
 * Deduped list unit: one logical skill/agent/command/… with 1..n on-disk locations.
 */
export interface ArtifactGroup {
  readonly id: string;
  readonly noun: ArtifactNoun;
  readonly logicalKey: string;
  readonly label: string;
  readonly locations: ReadonlyArray<ArtifactEntry>;
  readonly locationCount: number;
  /** True when the same logical item exists at more than one install site. */
  readonly isDuplicate: boolean;
  readonly siteCount: number;
  readonly ownerships: ReadonlyArray<OwnershipKind>;
  readonly plugins: ReadonlyArray<string>;
  readonly primaryLocations: ReadonlyArray<ArtifactEntry>;
}

export interface PluginSummary {
  /** Bare plugin name (no #file-router suffix). */
  readonly name: string;
  readonly entryCount: number;
  readonly ownedFiles: number;
  readonly regions: number;
  readonly hasToolRuntime: boolean;
  readonly roots: ReadonlyArray<string>;
}

/** Known harness config surface (read-only overview for the TUI). */
export type ConfigFileKind =
  | "settings" // e.g. settings.json — harness-native prefs
  | "rules" // CLAUDE.md / AGENTS.md
  | "credentials" // never open content in TUI
  | "runtime" // history, sessions, cache
  | "other";

export interface ConfigFileEntry {
  readonly id: string;
  readonly kind: ConfigFileKind;
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes?: number;
  /** Prism may own fences/regions inside; never whole-file for settings. */
  readonly prismTouch: "none" | "regions" | "owned-tree";
  readonly note?: string;
}

export interface SettingsKeySummary {
  readonly key: string;
  readonly shape: string; // "string" | "bool" | "number" | "list/N" | "dict/a,b" | "redacted"
  readonly preview?: string; // short non-secret preview
}

export interface ConfigOverview {
  readonly files: ReadonlyArray<ConfigFileEntry>;
  readonly settingsPath?: string;
  readonly settingsKeys: ReadonlyArray<SettingsKeySummary>;
  readonly notes: ReadonlyArray<string>;
}

export interface HarnessSummary {
  readonly harness: ConfigureHarnessId;
  readonly displayName: string;
  readonly presence: HarnessPresence;
  readonly globalRoot: string;
  readonly rootExists: boolean;
  readonly binaryPath?: string;
  readonly snapshotEntryCount: number;
  readonly plugins: ReadonlyArray<PluginSummary>;
  readonly counts: Readonly<Record<ArtifactNoun, number>>;
  /** Harness-native settings/config overview (read-only). */
  readonly config?: ConfigOverview;
  /** Hermes (etc.): count of agent profiles under the shared root. */
  readonly profileCount?: number;
  /** Project-local harness roots discovered from cwd / --project. */
  readonly projectCount?: number;
  /** Absolute project path used for this inventory load, if any. */
  readonly projectPath?: string;
}

/**
 * Nested configure scope: a Hermes profile or a project-local harness root.
 * Inventory is scoped to that directory (no parent-root bleed).
 */
export type ScopeKind = "profile" | "project";

export interface ProfileSummary {
  readonly id: string;
  readonly displayName: string;
  readonly root: string;
  readonly rootExists: boolean;
  readonly counts: Readonly<Record<ArtifactNoun, number>>;
  readonly config?: ConfigOverview;
  /** Soul / identity-brief / profile.yaml. Memory files belong in memoryFiles. */
  readonly identityFiles: ReadonlyArray<ConfigFileEntry>;
  /** profile = Hermes profiles/<id>; project = catalog.projectRoot under cwd. */
  readonly kind?: ScopeKind;
  /** Generated memory files (may live outside root, e.g. Claude projects/<id>/memory). */
  readonly memoryFiles?: ReadonlyArray<ConfigFileEntry>;
  /** Absolute memory bucket when distinct from root. */
  readonly memoryRoot?: string;
}

export interface ProfileInventory {
  readonly summary: ProfileSummary;
  readonly artifacts: ReadonlyArray<ArtifactEntry>;
  readonly groups: ReadonlyArray<ArtifactGroup>;
}

/** Project-local harness root — same shape as a Hermes profile. */
export type ProjectInventory = ProfileInventory;

export interface HarnessInventory {
  readonly summary: HarnessSummary;
  readonly artifacts: ReadonlyArray<ArtifactEntry>;
  readonly groups: ReadonlyArray<ArtifactGroup>;
  /** Present for hermes (and any future multi-profile harness). */
  readonly profiles?: ReadonlyArray<ProfileInventory>;
  /** Project-local roots (.claude/, .grok/, …) plus attached memory buckets. */
  readonly projects?: ReadonlyArray<ProjectInventory>;
}

export interface ConfigureInventory {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessSummary>;
  /** Per-harness detail (artifacts + groups). Key = harness id. */
  readonly byHarness: Readonly<Partial<Record<ConfigureHarnessId, HarnessInventory>>>;
  /**
   * Convenience: artifacts for the focused/default harness (first present, else first).
   * Prefer `byHarness[id]` in multi-harness UI.
   */
  readonly artifacts: ReadonlyArray<ArtifactEntry>;
  readonly groups: ReadonlyArray<ArtifactGroup>;
  readonly focusedHarness: ConfigureHarnessId;
}

export type NavKind = "harness" | "section" | "plugin" | "artifact" | "profile" | "project";

export type SectionId =
  | "summary"
  | "config"
  | "plugins"
  | "skills"
  | "commands"
  | "agents"
  | "hooks"
  | "rules"
  | "bundles"
  /** Hermes: SOUL / identity-brief / profile.yaml */
  | "identity"
  /** Generated memories (MEMORY.md, topic files) — not session transcripts. */
  | "memories"
  | "other";

export interface NavNode {
  readonly id: string;
  readonly kind: NavKind;
  readonly label: string;
  readonly detail?: string;
  /** For section nodes. */
  readonly section?: SectionId;
  /** For plugin nodes. */
  readonly plugin?: string;
  /** For artifact nodes. */
  readonly artifactId?: string;
  /** Hermes profile id when nav is scoped to a profile. */
  readonly profileId?: string;
  /** Project-scope id when nav is scoped to a project root. */
  readonly projectId?: string;
}

export interface MutationPlanOp {
  readonly kind: string;
  readonly targetPath: string;
  readonly detail?: string;
}

export interface MutationPlan {
  readonly title: string;
  readonly dryRun: boolean;
  readonly ops: ReadonlyArray<MutationPlanOp>;
  readonly blocked: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

export interface MutationResult {
  readonly plan: MutationPlan;
  readonly applied: boolean;
  readonly failures: ReadonlyArray<string>;
}

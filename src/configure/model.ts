/**
 * Configure TUI domain model (POC: claude-code first).
 * Pure types — no I/O. Inventory + mutations + TUI all bind to these.
 */

export type ConfigureHarnessId = "claude-code";

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
}

export interface ConfigureInventory {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessSummary>;
  /** Flat artifact list for the primary (claude-code) harness roots. */
  readonly artifacts: ReadonlyArray<ArtifactEntry>;
  /** Deduped groups (same logical skill/agent/… across install sites). */
  readonly groups: ReadonlyArray<ArtifactGroup>;
}

export type NavKind = "harness" | "section" | "plugin" | "artifact";

export type SectionId =
  | "summary"
  | "plugins"
  | "skills"
  | "commands"
  | "agents"
  | "hooks"
  | "rules"
  | "bundles"
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

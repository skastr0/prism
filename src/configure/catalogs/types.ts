/**
 * Per-harness settings catalogue contract.
 * No ConfigSpaces yet — one concrete catalogue per harness.
 */

import type { HarnessId } from "../../types.js";

export type SettingValueType =
  | "string"
  | "boolean"
  | "number"
  | "enum"
  | "object"
  | "array"
  | "secret";

/** How Prism may touch this key today. */
export type PrismTouch =
  | "none" // user-only; TUI read-only
  | "region" // Prism can patch via DesiredRegion
  | "owned" // whole file Prism-owned (rare for settings)
  | "unknown";

export interface CatalogSettingsFile {
  /** Path relative to harness root, or absolute-style with ~ */
  readonly path: string;
  readonly format: "json" | "jsonc" | "toml" | "yaml" | "md" | "mdc" | "other";
  readonly primary?: boolean;
  readonly note?: string;
}

export interface CatalogField {
  /** Dotted path within the primary settings file (or file#path). */
  readonly key: string;
  readonly label: string;
  readonly type: SettingValueType;
  readonly enumValues?: ReadonlyArray<string>;
  readonly description?: string;
  readonly file: string;
  readonly prismTouch: PrismTouch;
  /** Optional cross-harness cousin label (documentation only). */
  readonly cousin?: string;
}

export interface CatalogRefresh {
  /** Human steps to re-derive this catalogue when the harness evolves. */
  readonly procedure: ReadonlyArray<string>;
  /** Authoritative or useful sources (CLI flags, schema URLs, local paths). */
  readonly sources: ReadonlyArray<string>;
  /** ISO date of last research pass. */
  readonly lastResearched: string;
}

export interface HarnessCatalog {
  readonly harness: HarnessId;
  readonly displayName: string;
  /** PATH command names used for detection. */
  readonly binaryNames: ReadonlyArray<string>;
  readonly binaryEnvVars?: ReadonlyArray<string>;
  readonly globalRoot: string;
  readonly projectRoot: string | null;
  readonly settingsFiles: ReadonlyArray<CatalogSettingsFile>;
  /** Relative dirs under the harness root for artifact inventory scans. */
  readonly scanDirs: ReadonlyArray<string>;
  /** Path fragments that mark Prism-generated namespaces. */
  readonly prismNamespaceMarkers: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<CatalogField>;
  readonly refresh: CatalogRefresh;
  readonly notes?: ReadonlyArray<string>;
}

export interface ResolvedSettingValue {
  readonly key: string;
  readonly present: boolean;
  readonly valuePreview?: string;
  readonly redacted?: boolean;
}

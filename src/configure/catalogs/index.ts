/**
 * Registry of per-harness settings catalogues for prism configure.
 * Populated by harness-settings-catalog workflow research (2026-08-11).
 */

import type { HarnessId } from "../../types.js";
import { ampCodeCatalog } from "./amp-code.js";
import { ampOrbCatalog } from "./amp-orb.js";
import { antigravityCliCatalog } from "./antigravity-cli.js";
import { claudeCodeCatalog } from "./claude-code.js";
import { codexCliCatalog } from "./codex-cli.js";
import { cursorCatalog } from "./cursor.js";
import { devinCatalog } from "./devin.js";
import { grokCatalog } from "./grok.js";
import { hermesCatalog } from "./hermes.js";
import { kimiCodeCatalog } from "./kimi-code.js";
import { ompCatalog } from "./omp.js";
import { opencodeCatalog } from "./opencode.js";
import { piCatalog } from "./pi.js";
import type { HarnessCatalog } from "./types.js";

export type {
  CatalogField,
  CatalogRefresh,
  CatalogSettingsFile,
  HarnessCatalog,
  PrismTouch,
  ResolvedSettingValue,
  SettingValueType,
} from "./types.js";
export { readCatalogSettings } from "./read.js";

export const HARNESS_CATALOGS: Record<HarnessId, HarnessCatalog> = {
  "claude-code": claudeCodeCatalog,
  opencode: opencodeCatalog,
  hermes: hermesCatalog,
  "codex-cli": codexCliCatalog,
  "antigravity-cli": antigravityCliCatalog,
  "kimi-code": kimiCodeCatalog,
  "amp-code": ampCodeCatalog,
  "amp-orb": ampOrbCatalog,
  cursor: cursorCatalog,
  pi: piCatalog,
  omp: ompCatalog,
  grok: grokCatalog,
  devin: devinCatalog,
};

export const getHarnessCatalog = (id: HarnessId): HarnessCatalog => HARNESS_CATALOGS[id];

export const allHarnessCatalogs = (): ReadonlyArray<HarnessCatalog> =>
  Object.values(HARNESS_CATALOGS);

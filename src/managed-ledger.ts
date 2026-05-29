import { join } from "node:path";
import { Schema } from "effect";
import { ensureDir, exists, readFile, writeFile } from "./fs.js";
import { prismStateDir, resolvePrismHome } from "./prism-home.js";
import type { HarnessId, HarnessScope } from "./types.js";

export const LEDGER_SCHEMA_VERSION = 1;

export const ManagedOutputKindSchema = Schema.Literal(
  "file",
  "directory",
  "section",
  "config",
);
export type ManagedOutputKind = typeof ManagedOutputKindSchema.Type;

export const ManagedLedgerEntrySchema = Schema.Struct({
  id: Schema.String,
  pluginName: Schema.String,
  pluginVersion: Schema.optional(Schema.String),
  pluginPath: Schema.String,
  harness: Schema.String,
  scope: Schema.Literal("global", "project"),
  root: Schema.String,
  artifact: Schema.String,
  sourcePath: Schema.optional(Schema.String),
  targetPath: Schema.String,
  kind: ManagedOutputKindSchema,
  contentHash: Schema.String,
  updatedAt: Schema.String,
});
export type ManagedLedgerEntry = typeof ManagedLedgerEntrySchema.Type;

const HarnessLedgerSchema = Schema.Struct({
  version: Schema.Literal(LEDGER_SCHEMA_VERSION),
  harness: Schema.String,
  entries: Schema.Array(ManagedLedgerEntrySchema),
});
export type HarnessLedger = typeof HarnessLedgerSchema.Type;

export class ManagedLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedLedgerError";
  }
}

export const harnessLedgerPath = (
  harness: HarnessId,
  prismHome = resolvePrismHome(),
): string => join(prismStateDir(prismHome), `${harness}.ledger.json`);

export const emptyHarnessLedger = (harness: HarnessId): HarnessLedger => ({
  version: LEDGER_SCHEMA_VERSION,
  harness,
  entries: [],
});

const decodeHarnessLedger = (harness: HarnessId, value: unknown): HarnessLedger => {
  try {
    const ledger = Schema.decodeUnknownSync(HarnessLedgerSchema)(value);
    if (ledger.harness !== harness) {
      throw new ManagedLedgerError(
        `Ledger harness mismatch: expected '${harness}', found '${ledger.harness}'.`,
      );
    }
    return ledger;
  } catch (error) {
    if (error instanceof ManagedLedgerError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ManagedLedgerError(`Ledger for '${harness}' is invalid: ${message}`);
  }
};

export const readHarnessLedger = async (
  harness: HarnessId,
  prismHome = resolvePrismHome(),
): Promise<HarnessLedger> => {
  const path = harnessLedgerPath(harness, prismHome);
  if (!(await exists(path))) return emptyHarnessLedger(harness);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ManagedLedgerError(`Ledger for '${harness}' is not valid JSON: ${message}`);
  }

  return decodeHarnessLedger(harness, parsed);
};

export const writeHarnessLedger = async (
  ledger: HarnessLedger,
  prismHome = resolvePrismHome(),
): Promise<string> => {
  const decoded = decodeHarnessLedger(ledger.harness as HarnessId, ledger);
  const path = harnessLedgerPath(decoded.harness as HarnessId, prismHome);
  await ensureDir(prismStateDir(prismHome));
  await writeFile(path, `${JSON.stringify(decoded, null, 2)}\n`, { mode: 0o600 });
  return path;
};

export const managedEntryId = (input: {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly root: string;
  readonly pluginName: string;
  readonly artifact: string;
  readonly targetPath: string;
  readonly kind: ManagedOutputKind;
  readonly sourcePath?: string;
}): string =>
  [
    input.harness,
    input.scope,
    input.root,
    input.pluginName,
    input.artifact,
    input.kind,
    input.sourcePath ?? "",
    input.targetPath,
  ].join("\u001f");

export const upsertLedgerEntries = (
  ledger: HarnessLedger,
  entries: ReadonlyArray<ManagedLedgerEntry>,
): HarnessLedger => {
  const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) byId.set(entry.id, entry);
  return {
    ...ledger,
    entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
};

export const removeLedgerEntries = (
  ledger: HarnessLedger,
  entryIds: ReadonlySet<string>,
): HarnessLedger => ({
  ...ledger,
  entries: ledger.entries.filter((entry) => !entryIds.has(entry.id)),
});

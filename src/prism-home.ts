import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { PrismConfigError } from "./errors.js";
import { exists, readFile } from "./fs.js";

export const PRISM_CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_BACKUP_RETENTION_PER_TARGET = 3;

export const BackupModeSchema = Schema.Literal("always", "never");
export type BackupMode = typeof BackupModeSchema.Type;

const RawPrismConfigSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(PRISM_CONFIG_SCHEMA_VERSION)),
  backup: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(BackupModeSchema),
      retentionPerTarget: Schema.optional(Schema.Number),
    }),
  ),
});

type RawPrismConfig = typeof RawPrismConfigSchema.Type;

export interface PrismBackupConfig {
  readonly mode: BackupMode;
  readonly retentionPerTarget: number;
}

export interface PrismConfig {
  readonly version: typeof PRISM_CONFIG_SCHEMA_VERSION;
  readonly backup: PrismBackupConfig;
}

/**
 * Resolve the Prism home directory from an override or the environment.
 *
 * WS2+: new code must NOT call this from library modules — consume the
 * `PrismHome` Context.Tag from src/services/prism-env.ts instead; the env
 * read happens exactly once at the CLI edge layer.
 */
export const resolvePrismHome = (override?: string): string => {
  const configured = override ?? process.env.PRISM_HOME;
  if (configured && configured.trim().length > 0) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return resolve(configured);
  }

  return join(homedir(), ".prism");
};

export const prismConfigPath = (prismHome = resolvePrismHome()): string =>
  join(prismHome, "config.json");

export const prismStateDir = (prismHome = resolvePrismHome()): string =>
  join(prismHome, "state");

export const prismBackupDir = (prismHome = resolvePrismHome()): string =>
  join(prismHome, "backups");

const assertPositiveInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PrismConfigError({ message: `Prism config '${field}' must be a positive integer.` });
  }
  return value;
};

const normalizePrismConfig = (raw: RawPrismConfig): PrismConfig => {
  const retention = raw.backup?.retentionPerTarget ?? DEFAULT_BACKUP_RETENTION_PER_TARGET;
  return {
    version: raw.version ?? PRISM_CONFIG_SCHEMA_VERSION,
    backup: {
      mode: raw.backup?.mode ?? "always",
      retentionPerTarget: assertPositiveInteger(retention, "backup.retentionPerTarget"),
    },
  };
};

export const defaultPrismConfig = (): PrismConfig =>
  normalizePrismConfig({});

const decodeRawPrismConfig = (value: unknown): RawPrismConfig => {
  try {
    return Schema.decodeUnknownSync(RawPrismConfigSchema)(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PrismConfigError({ message: `Prism config is invalid: ${message}` });
  }
};

export const readPrismConfig = async (
  prismHome = resolvePrismHome(),
): Promise<PrismConfig> => {
  const path = prismConfigPath(prismHome);
  if (!(await exists(path))) return defaultPrismConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PrismConfigError({ message: `Prism config is not valid JSON: ${message}` });
  }

  return normalizePrismConfig(decodeRawPrismConfig(parsed));
};

import { dirname, isAbsolute, join, resolve } from "node:path";
import { exists, readFile } from "./fs.js";
import type { HarnessId } from "./types.js";

export interface PrismPackageTargetConfig {
  readonly path?: string;
  readonly packageId?: string;
}

export interface PrismProjectConfig {
  readonly configPath?: string;
  readonly root: string;
  readonly distribution: {
    readonly outDir: string;
    readonly packages: Partial<Record<HarnessId, PrismPackageTargetConfig>>;
  };
}

interface RawPrismProjectConfig {
  readonly distribution?: {
    readonly outDir?: unknown;
    readonly packages?: unknown;
  };
}

const CONFIG_FILE = "prism.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const findPrismConfigPath = async (startPath: string): Promise<string | undefined> => {
  let current = resolve(startPath);

  while (true) {
    const candidate = join(current, CONFIG_FILE);
    if (await exists(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const resolveConfigPath = (root: string, value: string): string =>
  isAbsolute(value) ? value : resolve(root, value);

const normalizeTargetPackageConfig = (value: unknown): PrismPackageTargetConfig => {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.path === "string" && value.path.length > 0 ? { path: value.path } : {}),
    ...(typeof value.packageId === "string" && value.packageId.length > 0
      ? { packageId: value.packageId }
      : {}),
  };
};

const normalizePackages = (value: unknown): Partial<Record<HarnessId, PrismPackageTargetConfig>> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([target, config]) => [
      target,
      normalizeTargetPackageConfig(config),
    ]),
  ) as Partial<Record<HarnessId, PrismPackageTargetConfig>>;
};

const normalizeProjectConfig = (
  root: string,
  configPath: string | undefined,
  raw: RawPrismProjectConfig,
): PrismProjectConfig => {
  const distribution = raw.distribution;
  const outDir = typeof distribution?.outDir === "string" && distribution.outDir.length > 0
    ? resolveConfigPath(root, distribution.outDir)
    : join(root, "dist", "prism");

  return {
    ...(configPath ? { configPath } : {}),
    root,
    distribution: {
      outDir,
      packages: normalizePackages(distribution?.packages),
    },
  };
};

export const readPrismProjectConfig = async (
  pluginPath: string,
): Promise<PrismProjectConfig> => {
  const configPath = await findPrismConfigPath(pluginPath);
  if (!configPath) {
    return normalizeProjectConfig(resolve(pluginPath), undefined, {});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Prism project config is not valid JSON: ${configPath}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Prism project config must be a JSON object: ${configPath}`);
  }

  return normalizeProjectConfig(dirname(configPath), configPath, parsed);
};

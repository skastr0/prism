import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import type { LowerOutput } from "../lowerers/shared.js";

export interface NormalizeLowerOutputOptions {
  /** Harness id, used only for logging/diagnostics; not part of normalization. */
  readonly harnessId: string;
  /** The harness output root that should be replaced with <HARNESS_ROOT>. */
  readonly root: string;
  /** PRISM_HOME prefix to replace with <PRISM_HOME>. */
  readonly prismHome: string;
  /** Source plugin root to replace with <PLUGIN_ROOT>. */
  readonly pluginRoot: string;
  /** Optional project root to replace with <PROJECT_ROOT>. */
  readonly projectRoot?: string;
  /** Optional base temp root to replace with <TEMP_ROOT>. */
  readonly tempRoot?: string;
}

const ISO_DATE_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

const BUN_VERSION_RE = /Bun v\d+\.\d+\.\d+/g;

const MCP_URL_RE =
  /(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)\/mcp/g;

const BUNDLE_FILE_RE = /(\.mjs$|prism-extension\.js$)/;

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sortedEntries = (record: Record<string, unknown>): [string, unknown][] =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      sortedEntries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sortKeys(item),
      ]),
    );
  }
  return value;
};

const normalizePathSeparators = (value: string): string =>
  value.replace(/\\/g, "/");

const buildReplacements = (options: NormalizeLowerOutputOptions): { from: string; to: string }[] => {
  const pairs: { from: string; to: string }[] = [
    { from: options.root, to: "<HARNESS_ROOT>" },
    { from: options.prismHome, to: "<PRISM_HOME>" },
    { from: options.pluginRoot, to: "<PLUGIN_ROOT>" },
    { from: tmpdir(), to: "<TMPDIR>" },
  ];
  if (options.projectRoot && options.projectRoot.length > 0) {
    pairs.push({ from: options.projectRoot, to: "<PROJECT_ROOT>" });
  }
  if (options.tempRoot && options.tempRoot.length > 0) {
    pairs.push({ from: options.tempRoot, to: "<TEMP_ROOT>" });
  }

  const cwd = process.cwd();
  pairs.push({ from: cwd, to: "<CWD>" });

  return pairs
    .map(({ from, to }) => ({
      from: normalizePathSeparators(from),
      to,
    }))
    .filter(({ from }) => from.length > 0)
    .sort((left, right) => right.from.length - left.from.length);
};

const replacePaths = (
  value: string,
  replacements: { from: string; to: string }[],
): string => {
  let result = normalizePathSeparators(value);
  for (const { from, to } of replacements) {
    if (from === "/" || from.length === 0) continue;
    let next = result.split(from).join(to);
    // Also cover file:// URLs that embed the absolute path.
    const fileUrlFrom = `file://${from}`;
    const fileUrlTo = `file://${to}`;
    next = next.split(fileUrlFrom).join(fileUrlTo);
    result = next;
  }
  return result;
};

const maskPorts = (value: string): string =>
  value.replace(MCP_URL_RE, "<MCP_URL>");

const maskTimestamps = (value: string): string =>
  value.replace(ISO_DATE_RE, "<TIMESTAMP>");

const maskBunVersion = (value: string): string =>
  value.replace(BUN_VERSION_RE, "Bun <VERSION>");

const normalizeString = (
  value: string,
  replacements: { from: string; to: string }[],
): string => maskBunVersion(maskTimestamps(maskPorts(replacePaths(value, replacements))));

const isBundleFile = (path: string): boolean => BUNDLE_FILE_RE.test(path);

interface NormalizedFile {
  path: string;
  content: string;
  mode?: number;
}

interface NormalizedRegion {
  targetPath: string;
  regionKey: string;
  kind: DesiredRegion["kind"];
  content?: string;
  value?: unknown;
  commentPrefix?: string;
  commentSuffix?: string;
  anchor?: string;
  jsonPath?: ReadonlyArray<string | number>;
  memberKey?: ReadonlyArray<string>;
  skipIfTomlScalarExists?: {
    table: string;
    key: string;
    value: string | number | boolean;
  };
}

const normalizeFile = (
  file: DesiredFile,
  replacements: { from: string; to: string }[],
): NormalizedFile => {
  const path = normalizeString(file.targetPath, replacements);
  const normalizedContent = normalizeString(file.content, replacements);
  const content = isBundleFile(path)
    ? `<BUNDLE_HASH:${sha256Hex(normalizedContent)}>`
    : normalizedContent;
  const out: NormalizedFile = { path, content };
  if (file.mode !== undefined) {
    out.mode = file.mode;
  }
  return out;
};

const normalizeRegion = (
  region: DesiredRegion,
  replacements: { from: string; to: string }[],
): NormalizedRegion => {
  const base = {
    targetPath: normalizeString(region.targetPath, replacements),
    regionKey: region.regionKey,
    kind: region.kind,
  };

  if (region.kind === "marker") {
    const out: NormalizedRegion = {
      ...base,
      commentPrefix: region.commentPrefix,
      content: normalizeString(region.content, replacements),
    };
    if (region.commentSuffix !== undefined) {
      out.commentSuffix = region.commentSuffix;
    }
    if (region.anchor !== undefined) {
      out.anchor = region.anchor;
    }
    if (region.skipIfTomlScalarExists !== undefined) {
      out.skipIfTomlScalarExists = region.skipIfTomlScalarExists;
    }
    return out;
  }

  if (region.kind === "json-key") {
    return {
      ...base,
      jsonPath: region.jsonPath,
      value: sortKeys(
        JSON.parse(normalizeString(JSON.stringify(region.value), replacements)),
      ),
    };
  }

  return {
    ...base,
    jsonPath: region.jsonPath,
    value: sortKeys(
      JSON.parse(normalizeString(JSON.stringify(region.value), replacements)),
    ),
    ...(region.memberKey !== undefined ? { memberKey: region.memberKey } : {}),
  };
};

/**
 * Deterministically serialize lowerer output for golden snapshots.
 *
 * - Sorts files and regions by key.
 * - Masks absolute paths (harness root, PRISM_HOME, plugin root, tmpdir, cwd).
 * - Masks MCP loopback URLs, timestamps, and Bun version stamps.
 * - Replaces `.mjs` bundle contents with a stable hash placeholder.
 * - Recursively sorts JSON object keys for a deterministic envelope.
 */
export const normalizeLowerOutput = (
  output: LowerOutput,
  options: NormalizeLowerOutputOptions,
): { files: NormalizedFile[]; regions: NormalizedRegion[] } => {
  const replacements = buildReplacements(options);

  const files = output.files
    .map((file) => normalizeFile(file, replacements))
    .sort((left, right) => left.path.localeCompare(right.path));

  const regions = output.regions
    .map((region) => normalizeRegion(region, replacements))
    .sort(
      (left, right) =>
        left.targetPath.localeCompare(right.targetPath) ||
        left.regionKey.localeCompare(right.regionKey),
    );

  return sortKeys({ files, regions }) as {
    files: NormalizedFile[];
    regions: NormalizedRegion[];
  };
};

export const formatGolden = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

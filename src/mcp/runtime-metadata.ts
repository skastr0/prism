import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MCP_RUNTIME_METADATA_SCHEMA = "prism.mcp-runtime.v1" as const;
export const MCP_RUNTIME_HEALTH_SCHEMA = "prism.mcp-health.v1" as const;

export type McpRuntimeMetadataSchema = typeof MCP_RUNTIME_METADATA_SCHEMA;
export type McpRuntimeHealthSchema = typeof MCP_RUNTIME_HEALTH_SCHEMA;
export type McpRuntimeTransport = "stdio" | "streamable-http";

export interface McpRuntimeMetadata {
  readonly schema: McpRuntimeMetadataSchema;
  readonly serverName: string;
  readonly transport: McpRuntimeTransport;
  readonly host?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly tokenEnv?: string;
  readonly tokenSha256?: string;
  readonly serverSha256?: string;
  readonly startedAt?: string;
  readonly healthUrl?: string;
  readonly mcpUrl?: string;
}

export interface McpRuntimeHealth {
  readonly schema: McpRuntimeHealthSchema;
  readonly serverName: string;
  readonly transport: Extract<McpRuntimeTransport, "streamable-http">;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly pid: number;
  readonly toolCount: number;
  readonly serverSha256?: string;
}

export type McpRuntimeStaleReason =
  | "missing-pid"
  | "pid-not-running"
  | "missing-health"
  | "health-server-name-mismatch"
  | "health-transport-mismatch"
  | "health-pid-mismatch"
  | "health-started-at-mismatch"
  | "metadata-host-non-loopback"
  | "missing-runtime-port"
  | "missing-pid-command"
  | "pid-command-mismatch"
  | "missing-listener-pid"
  | "listener-pid-mismatch"
  | "missing-health-server-sha256"
  | "health-server-sha256-mismatch"
  | "missing-server-file"
  | "server-file-sha256-mismatch"
  | "missing-server-sha256"
  | "server-sha256-mismatch"
  | "missing-token-sha256"
  | "token-sha256-mismatch";

export interface McpRuntimeStalenessOptions {
  readonly requireLivePid?: boolean;
  readonly requireHealth?: boolean;
  readonly health?: McpRuntimeHealth;
  readonly expectedServerSha256?: string;
  readonly expectedTokenSha256?: string;
  readonly pidExists?: (pid: number) => boolean;
}

const METADATA_KEYS = new Set<keyof McpRuntimeMetadata>([
  "schema",
  "serverName",
  "transport",
  "host",
  "port",
  "pid",
  "tokenEnv",
  "tokenSha256",
  "serverSha256",
  "startedAt",
  "healthUrl",
  "mcpUrl",
]);

const SECRET_KEY_NAMES = new Set([
  "token",
  "authToken",
  "bearerToken",
  "accessToken",
  "secret",
]);

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/iu;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new Error(`invalid MCP runtime metadata: ${message}`);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    fail("root value must be an object");
  }
  return value as Record<string, unknown>;
};

const assertKnownKeys = (record: Record<string, unknown>): void => {
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_NAMES.has(key)) {
      fail(`secret key '${key}' must not be stored`);
    }
    if (!METADATA_KEYS.has(key as keyof McpRuntimeMetadata)) {
      fail(`unexpected key '${key}'`);
    }
  }
};

const requiredString = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`'${key}' must be a non-empty string`);
  }
  return value as string;
};

const optionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`'${key}' must be a non-empty string when present`);
  }
  return value as string;
};

const optionalPositiveInteger = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`'${key}' must be a positive integer when present`);
  }
  return value as number;
};

const optionalSha256 = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (!SHA256_HEX_PATTERN.test(value)) {
    fail(`'${key}' must be a sha256 hex digest`);
  }
  return value.toLowerCase();
};

const parseUrlValue = (value: string, key: string): URL => {
  try {
    return new URL(value);
  } catch {
    return fail(`'${key}' must be a valid URL`);
  }
};

const optionalUrl = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  const url = parseUrlValue(value, key);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`'${key}' must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    fail(`'${key}' must not contain credentials, query parameters, or fragments`);
  }
  return value;
};

const optionalEnvName = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (!ENV_NAME_PATTERN.test(value)) {
    fail(`'${key}' must be an environment variable name`);
  }
  return value;
};

const optionalStartedAt = (record: Record<string, unknown>): string | undefined => {
  const value = optionalString(record, "startedAt");
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("'startedAt' must be an ISO date string");
  }
  return value;
};

export const sha256Hex = (value: string | Buffer | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const computeFileSha256 = async (path: string): Promise<string> =>
  sha256Hex(await readFile(path));

export const hashMcpRuntimeToken = (token: string): string => sha256Hex(token);

export const parseMcpRuntimeMetadata = (value: unknown): McpRuntimeMetadata => {
  const record = asRecord(value);
  assertKnownKeys(record);

  const schema = requiredString(record, "schema");
  if (schema !== MCP_RUNTIME_METADATA_SCHEMA) {
    fail(`unsupported schema '${schema}'`);
  }

  const transport = requiredString(record, "transport");
  if (transport !== "stdio" && transport !== "streamable-http") {
    fail("'transport' must be 'stdio' or 'streamable-http'");
  }

  const host = optionalString(record, "host");
  const port = optionalPositiveInteger(record, "port");
  const pid = optionalPositiveInteger(record, "pid");
  const tokenEnv = optionalEnvName(record, "tokenEnv");
  const tokenSha256 = optionalSha256(record, "tokenSha256");
  const serverSha256 = optionalSha256(record, "serverSha256");
  const startedAt = optionalStartedAt(record);
  const healthUrl = optionalUrl(record, "healthUrl");
  const mcpUrl = optionalUrl(record, "mcpUrl");

  return {
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: requiredString(record, "serverName"),
    transport: transport as McpRuntimeTransport,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(tokenSha256 !== undefined ? { tokenSha256 } : {}),
    ...(serverSha256 !== undefined ? { serverSha256 } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(healthUrl !== undefined ? { healthUrl } : {}),
    ...(mcpUrl !== undefined ? { mcpUrl } : {}),
  };
};

const requiredNonNegativeNumber = (
  record: Record<string, unknown>,
  key: string,
): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`'${key}' must be a non-negative number`);
  }
  return value as number;
};

const requiredPositiveInteger = (
  record: Record<string, unknown>,
  key: string,
): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`'${key}' must be a positive integer`);
  }
  return value as number;
};

export const parseMcpRuntimeHealth = (value: unknown): McpRuntimeHealth => {
  const record = asRecord(value);
  const schema = requiredString(record, "schema");
  if (schema !== MCP_RUNTIME_HEALTH_SCHEMA) {
    fail(`unsupported health schema '${schema}'`);
  }

  const transport = requiredString(record, "transport");
  if (transport !== "streamable-http") {
    fail("'transport' must be 'streamable-http'");
  }

  const startedAt = requiredString(record, "startedAt");
  const parsedStartedAt = Date.parse(startedAt);
  if (!Number.isFinite(parsedStartedAt)) {
    fail("'startedAt' must be an ISO date string");
  }

  return {
    schema: MCP_RUNTIME_HEALTH_SCHEMA,
    serverName: requiredString(record, "serverName"),
    transport: "streamable-http",
    startedAt,
    uptimeMs: requiredNonNegativeNumber(record, "uptimeMs"),
    pid: requiredPositiveInteger(record, "pid"),
    toolCount: requiredNonNegativeNumber(record, "toolCount"),
    ...(optionalSha256(record, "serverSha256") !== undefined
      ? { serverSha256: optionalSha256(record, "serverSha256") }
      : {}),
  };
};

export const readMcpRuntimeMetadata = async (path: string): Promise<McpRuntimeMetadata> =>
  parseMcpRuntimeMetadata(JSON.parse(await readFile(path, "utf8")));

export const serializeMcpRuntimeMetadata = (metadata: McpRuntimeMetadata): string =>
  `${JSON.stringify(parseMcpRuntimeMetadata(metadata), null, 2)}\n`;

export const writeMcpRuntimeMetadata = async (
  path: string,
  metadata: McpRuntimeMetadata,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMcpRuntimeMetadata(metadata));
};

const defaultPidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
};

export const detectMcpRuntimeStaleReasons = (
  metadata: McpRuntimeMetadata,
  options: McpRuntimeStalenessOptions = {},
): ReadonlyArray<McpRuntimeStaleReason> => {
  const reasons: McpRuntimeStaleReason[] = [];
  const pidExists = options.pidExists ?? defaultPidExists;
  const healthRequired =
    options.requireHealth ?? (options.requireLivePid === true && metadata.transport === "streamable-http");

  if (options.requireLivePid) {
    if (metadata.pid === undefined) {
      reasons.push("missing-pid");
    } else if (!pidExists(metadata.pid)) {
      reasons.push("pid-not-running");
    }
  }

  if (healthRequired) {
    if (!options.health) {
      reasons.push("missing-health");
    } else {
      if (options.health.serverName !== metadata.serverName) {
        reasons.push("health-server-name-mismatch");
      }
      if (options.health.transport !== metadata.transport) {
        reasons.push("health-transport-mismatch");
      }
      if (metadata.pid !== undefined && options.health.pid !== metadata.pid) {
        reasons.push("health-pid-mismatch");
      }
      if (metadata.startedAt !== undefined && options.health.startedAt !== metadata.startedAt) {
        reasons.push("health-started-at-mismatch");
      }
      const expectedHealthSha256 = options.expectedServerSha256 ?? metadata.serverSha256;
      if (expectedHealthSha256 !== undefined) {
        if (options.health.serverSha256 === undefined) {
          reasons.push("missing-health-server-sha256");
        } else if (options.health.serverSha256 !== expectedHealthSha256.toLowerCase()) {
          reasons.push("health-server-sha256-mismatch");
        }
      }
    }
  }

  if (options.expectedServerSha256 !== undefined) {
    const expected = options.expectedServerSha256.toLowerCase();
    if (metadata.serverSha256 === undefined) {
      reasons.push("missing-server-sha256");
    } else if (metadata.serverSha256 !== expected) {
      reasons.push("server-sha256-mismatch");
    }
  }

  if (options.expectedTokenSha256 !== undefined) {
    const expected = options.expectedTokenSha256.toLowerCase();
    if (metadata.tokenSha256 === undefined) {
      reasons.push("missing-token-sha256");
    } else if (metadata.tokenSha256 !== expected) {
      reasons.push("token-sha256-mismatch");
    }
  }

  return reasons;
};

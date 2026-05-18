import { randomBytes, createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MCP_TOKEN_STORE_SCHEMA = "prism.mcp-tokens.v1";
const MIN_MCP_BEARER_TOKEN_LENGTH = 24;
const RESERVED_TOKEN_ENV_NAMES = new Set([
  "HOME",
  "LOGNAME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

export interface McpStoredToken {
  readonly token: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpTokenStore {
  readonly schema: typeof MCP_TOKEN_STORE_SCHEMA;
  readonly tokens: Record<string, McpStoredToken>;
}

export const prismConfigDir = (runtimeRoot: string): string =>
  join(runtimeRoot, "prism");

export const mcpTokenStorePath = (runtimeRoot: string): string =>
  join(prismConfigDir(runtimeRoot), "tokens.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTokenStore = (content: string): McpTokenStore => {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || parsed.schema !== MCP_TOKEN_STORE_SCHEMA || !isRecord(parsed.tokens)) {
    return { schema: MCP_TOKEN_STORE_SCHEMA, tokens: {} };
  }

  const tokens: Record<string, McpStoredToken> = {};
  for (const [serverName, value] of Object.entries(parsed.tokens)) {
    if (!isRecord(value)) continue;
    if (
      typeof value.token !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      continue;
    }
    tokens[serverName] = {
      token: value.token,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }

  return { schema: MCP_TOKEN_STORE_SCHEMA, tokens };
};

const readTokenStore = async (runtimeRoot: string): Promise<McpTokenStore> => {
  try {
    return parseTokenStore(await readFile(mcpTokenStorePath(runtimeRoot), "utf8"));
  } catch {
    return { schema: MCP_TOKEN_STORE_SCHEMA, tokens: {} };
  }
};

const writeTokenStore = async (
  runtimeRoot: string,
  store: McpTokenStore,
): Promise<void> => {
  await mkdir(prismConfigDir(runtimeRoot), { recursive: true, mode: 0o700 });
  const path = mcpTokenStorePath(runtimeRoot);
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
};

const generateToken = (): string => randomBytes(32).toString("base64url");

export const isUsableMcpBearerToken = (value: string | undefined): value is string => {
  const token = value?.trim();
  return Boolean(
    token &&
      token.length >= MIN_MCP_BEARER_TOKEN_LENGTH &&
      !/[\s\x00-\x1F\x7F]/u.test(token),
  );
};

const isReservedTokenEnvName = (value: string | undefined): boolean =>
  value !== undefined && RESERVED_TOKEN_ENV_NAMES.has(value.trim().toUpperCase());

export const normalizePreferredMcpBearerToken = (options: {
  readonly preferredToken?: string;
  readonly preferredTokenEnv?: string;
}): string | undefined => {
  if (isReservedTokenEnvName(options.preferredTokenEnv)) return undefined;
  const token = options.preferredToken?.trim();
  return isUsableMcpBearerToken(token) ? token : undefined;
};

export const hashStoredMcpToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const readMcpToken = async (
  runtimeRoot: string,
  serverName: string,
): Promise<string | undefined> => {
  const store = await readTokenStore(runtimeRoot);
  return store.tokens[serverName]?.token;
};

export const ensureMcpToken = async (
  runtimeRoot: string,
  serverName: string,
  options: {
    readonly preferredToken?: string;
    readonly preferredTokenEnv?: string;
  } = {},
): Promise<string> => {
  const store = await readTokenStore(runtimeRoot);
  const existing = store.tokens[serverName];
  const preferredToken = normalizePreferredMcpBearerToken(options);
  const existingToken = isUsableMcpBearerToken(existing?.token) ? existing.token : undefined;
  const token = preferredToken ?? existingToken ?? generateToken();
  const now = new Date().toISOString();
  store.tokens[serverName] = {
    token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.token === token ? existing.updatedAt : now,
  };
  await writeTokenStore(runtimeRoot, store);
  return token;
};

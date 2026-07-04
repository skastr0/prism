import { createHash } from "node:crypto";

export const computeContentHash = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const MCP_HTTP_URL_AUTHORITY = /^(https?:\/\/)[^/?#]+(.*)$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalizes the dynamic `mcpServers[*].url` authority (host:port) out of a
 * generated MCP HTTP config before hashing, so an owner daemon rebinding to a
 * different ephemeral port is never mistaken for content drift. Detection is
 * purely structural (`{ mcpServers: { url: "http(s)://..." } }`); content that
 * does not match this shape is returned unchanged.
 */
export const normalizeMcpHttpConfigForHash = (content: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return content;

  let changed = false;
  const normalizedServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    if (!isPlainObject(server) || typeof server.url !== "string") {
      normalizedServers[name] = server;
      continue;
    }
    const normalizedUrl = server.url.replace(MCP_HTTP_URL_AUTHORITY, "$1<host>$2");
    if (normalizedUrl === server.url) {
      normalizedServers[name] = server;
      continue;
    }
    changed = true;
    normalizedServers[name] = { ...server, url: normalizedUrl };
  }
  if (!changed) return content;
  return JSON.stringify({ ...parsed, mcpServers: normalizedServers });
};

/**
 * Content hash for a generated MCP HTTP config owned file. Equal for two
 * renders that differ only in the dynamic port/url authority; still differs
 * for a genuine content change (e.g. an added/removed server entry).
 */
export const computeMcpHttpConfigContentHash = (content: string): string =>
  computeContentHash(normalizeMcpHttpConfigForHash(content));

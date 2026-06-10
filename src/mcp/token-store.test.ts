import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMcpToken,
  mcpTokenStorePath,
  normalizePreferredMcpBearerToken,
} from "./token-store.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-token-store-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("MCP token store accepts explicit strong Prism token overrides", async () => {
  const root = await createTempRoot();
  const token = "prism-test-token-with-enough-entropy";

  const resolved = await ensureMcpToken(root, "prism-generated-test", {
    preferredToken: token,
    preferredTokenEnv: "PRISM_MCP_TEST_TOKEN",
  });

  expect(resolved).toBe(token);
});

test("MCP token store ignores reserved process environment values as bearer tokens", async () => {
  const root = await createTempRoot();
  const pathLikeToken = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  const resolved = await ensureMcpToken(root, "prism-generated-test", {
    preferredToken: pathLikeToken,
    preferredTokenEnv: "PATH",
  });

  expect(resolved).not.toBe(pathLikeToken);
  expect(resolved.length).toBeGreaterThanOrEqual(24);
});

test("MCP token store rotates weak stored tokens", async () => {
  const root = await createTempRoot();
  await mkdir(join(root, "runtime", "mcp"), { recursive: true });
  await writeFile(
    mcpTokenStorePath(root),
    `${JSON.stringify({
      schema: "prism.mcp-tokens.v1",
      tokens: {
        "prism-generated-test": {
          token: "short",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const resolved = await ensureMcpToken(root, "prism-generated-test");
  const persisted = await readFile(mcpTokenStorePath(root), "utf8");

  expect(resolved).not.toBe("short");
  expect(persisted).toContain(resolved);
});

test("MCP token normalization rejects short or whitespace-bearing overrides", () => {
  expect(normalizePreferredMcpBearerToken({
    preferredToken: "short",
    preferredTokenEnv: "PRISM_MCP_TEST_TOKEN",
  })).toBeUndefined();
  expect(normalizePreferredMcpBearerToken({
    preferredToken: "prism token with spaces and enough length",
    preferredTokenEnv: "PRISM_MCP_TEST_TOKEN",
  })).toBeUndefined();
});

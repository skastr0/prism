import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile as nodeWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import { exists, readFile } from "../fs.js";
import { computeContentHash } from "../content-hash.js";
import { commitSnapshot, readSnapshot, snapshotPath } from "../state/store.js";
import type { DesiredRoot } from "./desired.js";
import { planSync } from "./plan.js";
import { applySync } from "./apply.js";

let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-sync-home-"));
  root = await mkdtemp(join(tmpdir(), "prism-sync-root-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const desiredWith = (overrides: Partial<DesiredRoot>): DesiredRoot => ({
  harness: "codex-cli",
  root,
  files: [],
  regions: [],
  ...overrides,
});

const refresh = async (desired: DesiredRoot, options: { degraded?: boolean } = {}) => {
  const snapshot = await readSnapshot({ prismHome: home, harness: desired.harness, root });
  const plan = await planSync({
    desired,
    snapshot: snapshot.manifest,
    degradedOwnership: options.degraded ?? snapshot.quarantinedPath !== undefined,
  });
  return applySync({ prismHome: home, plan });
};

const kinds = (report: Awaited<ReturnType<typeof refresh>>): string[] =>
  report.ops.map((op) => op.kind).sort();

describe("sync engine — owned files", () => {
  const skillPath = () => join(root, "skills", "demo", "SKILL.md");
  const desired = (content: string) =>
    desiredWith({ files: [{ targetPath: skillPath(), content, plugin: "demo" }] });

  test("create, then converged no-op with byte-identical manifest", async () => {
    const first = await refresh(desired("v1\n"));
    expect(kinds(first)).toEqual(["create"]);
    expect(first.failures).toEqual([]);
    expect(await readFile(skillPath())).toBe("v1\n");

    const manifestBytes = await readFile(snapshotPath(home, root));
    const second = await refresh(desired("v1\n"));
    expect(kinds(second)).toEqual(["skip"]);
    expect(second.converged).toBe(true);
    expect(second.backups).toEqual([]);
    expect(await readFile(snapshotPath(home, root))).toBe(manifestBytes);
  });

  test("source change repairs without backup; user drift repairs with backup", async () => {
    await refresh(desired("v1\n"));

    const sourceChanged = await refresh(desired("v2\n"));
    const repair = sourceChanged.ops.find((op) => op.kind === "repair");
    expect(repair).toMatchObject({ reason: "source-changed", backup: false });
    expect(sourceChanged.backups).toEqual([]);

    await nodeWriteFile(skillPath(), "user edit\n");
    const drifted = await refresh(desired("v2\n"));
    expect(drifted.ops.find((op) => op.kind === "repair")).toMatchObject({
      reason: "drifted",
      backup: true,
    });
    expect(drifted.backups).toHaveLength(1);
    expect(await readFile(drifted.backups[0]!)).toBe("user edit\n");
    expect(await readFile(skillPath())).toBe("v2\n");
  });

  test("skip-before-blocked: bytes equal but never managed converges silently", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "v1\n");
    const report = await refresh(desired("v1\n"));
    expect(kinds(report)).toEqual(["skip"]);
    expect(report.blocked).toEqual([]);
  });

  test("blocked: foreign differing file at first placement; withheld from manifest; rest proceeds", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "foreign content\n");
    const other = join(root, "skills", "other", "SKILL.md");
    const report = await refresh(
      desiredWith({
        files: [
          { targetPath: skillPath(), content: "v1\n", plugin: "demo" },
          { targetPath: other, content: "other\n", plugin: "other" },
        ],
      }),
    );
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.hint).toContain("delete or move");
    expect(await readFile(skillPath())).toBe("foreign content\n");
    expect(await readFile(other)).toBe("other\n");

    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.map((entry) => entry.targetPath)).toEqual([other]);
  });

  test("degraded ownership (quarantined snapshot) converges foreign files with backup", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "foreign content\n");
    const report = await refresh(desired("v1\n"), { degraded: true });
    expect(report.blocked).toEqual([]);
    expect(report.ops.find((op) => op.kind === "repair")).toMatchObject({ reason: "drifted" });
    expect(await readFile(skillPath())).toBe("v1\n");
    expect(report.backups).toHaveLength(1);
  });

  test("prune on removal; drifted orphans get a backup", async () => {
    await refresh(desired("v1\n"));
    const pruned = await refresh(desiredWith({ files: [] }));
    expect(kinds(pruned)).toEqual(["prune"]);
    expect(await exists(skillPath())).toBe(false);

    await refresh(desired("v1\n"));
    await nodeWriteFile(skillPath(), "user touched\n");
    const prunedDrifted = await refresh(desiredWith({ files: [] }));
    expect(prunedDrifted.backups).toHaveLength(1);
    expect(await readFile(prunedDrifted.backups[0]!)).toBe("user touched\n");
  });

  test("crash convergence: deleting the manifest re-converges without errors", async () => {
    await refresh(desired("v1\n"));
    await rm(snapshotPath(home, root));
    const report = await refresh(desired("v1\n"));
    expect(kinds(report)).toEqual(["skip"]);
    expect(report.blocked).toEqual([]);
  });

  test("a directory at a file target classifies as blocked; other ops land", async () => {
    await mkdir(skillPath(), { recursive: true });
    const other = join(root, "ok.md");
    const report = await refresh(
      desiredWith({
        files: [
          { targetPath: skillPath(), content: "v1\n", plugin: "demo" },
          { targetPath: other, content: "ok\n", plugin: "demo" },
        ],
      }),
    );
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.hint).toContain("not a readable file");
    expect(report.failures).toEqual([]);
    expect(await readFile(other)).toBe("ok\n");
    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.map((entry) => entry.targetPath)).toEqual([other]);
  });
});

describe("sync engine — grok MCP port normalization (PQ-167)", () => {
  const mcpPath = () => join(root, "plugins", "demo", ".mcp.json");
  const renderMcpConfig = (port: number, extraServers?: Record<string, unknown>): string =>
    JSON.stringify({
      mcpServers: {
        p_demo: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-demo:grok" },
        },
        ...extraServers,
      },
    }, null, 2) + "\n";
  const grokDesired = (content: string): DesiredRoot =>
    desiredWith({ harness: "grok", files: [{ targetPath: mcpPath(), content, plugin: "demo" }] });

  test("a legacy raw-hash snapshot classifies a routine port bump as source-changed (no backup), and still catches real drift", async () => {
    // Disk holds exactly what a pre-PQ-167 Prism last wrote and snapshotted
    // with a plain (unnormalized) content hash — the file has not drifted at
    // all since then.
    const original = renderMcpConfig(50953);
    await mkdir(join(root, "plugins", "demo"), { recursive: true });
    await nodeWriteFile(mcpPath(), original);
    await commitSnapshot({
      prismHome: home,
      manifest: {
        version: 1,
        harness: "grok",
        root,
        entries: [{ targetPath: mcpPath(), contentHash: computeContentHash(original), mode: "owned", plugin: "demo" }],
      },
    });

    // The owner daemon has since rebound to a new port; Prism regenerates
    // desired content reflecting it. This is Prism's own routine update, not
    // external tampering, so it must repair without a backup.
    const portBumped = await refresh(grokDesired(renderMcpConfig(61742)));
    const repair = portBumped.ops.find((op) => op.kind === "repair");
    expect(repair).toMatchObject({ reason: "source-changed", backup: false });
    expect(portBumped.backups).toEqual([]);
    expect(await readFile(mcpPath())).toBe(renderMcpConfig(61742));

    // The new snapshot entry is normalized going forward: a further pure
    // port bump against it must also read as source-changed.
    const portBumpedAgain = await refresh(grokDesired(renderMcpConfig(9001)));
    expect(portBumpedAgain.ops.find((op) => op.kind === "repair")).toMatchObject({
      reason: "source-changed",
      backup: false,
    });

    // Genuine external tampering (a hand-edited server entry) against that
    // same normalized snapshot must still be caught as drift.
    await nodeWriteFile(mcpPath(), renderMcpConfig(9001, { p_other: { type: "http", url: "http://127.0.0.1:1/mcp" } }));
    const tampered = await refresh(grokDesired(renderMcpConfig(2222)));
    expect(tampered.ops.find((op) => op.kind === "repair")).toMatchObject({ reason: "drifted", backup: true });
    expect(tampered.backups).toHaveLength(1);
  });
});

describe("sync engine — prune scoping", () => {
  test("a single-plugin compile cannot prune another plugin's outputs", async () => {
    const a = join(root, "skills", "a", "SKILL.md");
    const b = join(root, "skills", "b", "SKILL.md");
    await refresh(desiredWith({
      files: [
        { targetPath: a, content: "a\n", plugin: "plugin-a" },
        { targetPath: b, content: "b\n", plugin: "plugin-b" },
      ],
    }));

    // Recompile ONLY plugin-a with plugin-b's file absent from desired state.
    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    const plan = await planSync({
      desired: desiredWith({ files: [{ targetPath: a, content: "a\n", plugin: "plugin-a" }] }),
      snapshot: snapshot.manifest,
      scopePlugins: new Set(["plugin-a"]),
    });
    const report = await applySync({ prismHome: home, plan });

    expect(report.ops.some((op) => op.kind === "prune")).toBe(false);
    expect(await exists(b)).toBe(true);
    const after = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(after.manifest.entries.map((entry) => entry.targetPath).sort()).toEqual([a, b].sort());

    // An unscoped (whole-world) plan with the same desired state DOES prune b.
    const worldPlan = await planSync({
      desired: desiredWith({ files: [{ targetPath: a, content: "a\n", plugin: "plugin-a" }] }),
      snapshot: after.manifest,
    });
    const worldReport = await applySync({ prismHome: home, plan: worldPlan });
    expect(worldReport.ops.some((op) => op.kind === "prune")).toBe(true);
    expect(await exists(b)).toBe(false);
  });

  test("a single-plugin compile cannot prune a shared marker still owned out of scope", async () => {
    const configToml = join(root, "config.toml");
    const sharedMarker = (plugin: string) => ({
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: "codex.features.hooks",
      commentPrefix: "#",
      anchor: "[features]",
      content: "hooks = true",
      plugin,
    });

    await nodeWriteFile(configToml, "[features]\nmodel_widget = true\n");
    await refresh(desiredWith({ regions: [sharedMarker("plugin-a"), sharedMarker("plugin-b")] }));

    const first = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(first.manifest.entries.filter((entry) =>
      entry.regionKey?.includes("codex.features.hooks")
    )).toHaveLength(2);

    const scopedPlan = await planSync({
      desired: desiredWith({ regions: [] }),
      snapshot: first.manifest,
      scopePlugins: new Set(["plugin-b"]),
    });
    const report = await applySync({ prismHome: home, plan: scopedPlan });

    expect(report.ops.some((op) => op.kind === "patch-regions")).toBe(false);
    expect(await readFile(configToml)).toContain("prism:codex.features.hooks");
    const after = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    const remainingOwners = after.manifest.entries
      .filter((entry) => entry.regionKey?.includes("codex.features.hooks"))
      .map((entry) => entry.plugin);
    expect(remainingOwners).toEqual(["plugin-a"]);
  });
});

describe("sync engine — shared-file regions", () => {
  const configPath = () => join(root, "config.toml");
  const userContent = [
    "# my hand-written config",
    "",
    "[projects.x]",
    "last_updated = \"2026-01-01\"  # trailing comment",
    "",
  ].join("\n");

  const markerRegion = (content: string) =>
    desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configPath(),
        regionKey: "codex-cli:session-watch",
        commentPrefix: "#",
        content,
        plugin: "session-watch",
      }],
    });

  test("marker region appends once, preserves user bytes, converges, and removes on orphan", async () => {
    await nodeWriteFile(configPath(), userContent);

    const first = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"x\""));
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = await readFile(configPath());
    expect(after).toContain(userContent.trimEnd());
    expect(after).toContain("# --- prism:codex-cli:session-watch begin ---");

    const second = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"x\""));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(second.converged).toBe(true);
    expect(await readFile(configPath())).toBe(after);

    const updated = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"y\""));
    expect(kinds(updated)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toContain('command = "y"');

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = await readFile(configPath());
    expect(final).not.toContain("prism:codex-cli:session-watch");
    expect(final).toContain("# my hand-written config");
    expect(final).toContain("trailing comment");
  });

  test("marker region preserves dollar replacement tokens on insert and update", async () => {
    const literalContent = [
      "literal ampersand = $&",
      "literal quote = $'",
      "literal prefix = $`",
      "literal dollar = $$",
      "literal capture = $1",
      "",
    ].join("\n");
    const updatedContent = [
      "updated ampersand = $&",
      "updated quote = $'",
      "updated prefix = $`",
      "updated dollar = $$",
      "updated capture = $1",
      "",
    ].join("\n");
    const desired = (content: string) => desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configPath(),
        regionKey: "codex-cli:dollar-tokens",
        commentPrefix: "#",
        content,
        plugin: "dollar-token-test",
      }],
    });
    const expected = (content: string) => [
      userContent.trimEnd(),
      "",
      "# --- prism:codex-cli:dollar-tokens begin ---",
      content.trimEnd(),
      "# --- prism:codex-cli:dollar-tokens end ---",
      "",
    ].join("\n");

    await nodeWriteFile(configPath(), userContent);
    const inserted = await refresh(desired(literalContent));
    expect(kinds(inserted)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toBe(expected(literalContent));

    const updated = await refresh(desired(updatedContent));
    expect(kinds(updated)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toBe(expected(updatedContent));

    const second = await refresh(desired(updatedContent));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(second.converged).toBe(true);
    expect(await readFile(configPath())).toBe(expected(updatedContent));
  });

  test("marker region converges shorthand-like dollar sigil content", async () => {
    const shorthandLikeContent = [
      "# Agent Shorthand",
      "",
      "The `$` sigil marks code or literal blocks.",
      "The `$`-prefixed form is part of the grammar, not decoration.",
      "A literal `$` line must stay literal across refreshes.",
      "A quoted `$` token must not expand into the preceding fence body.",
      "Examples include `$&`, `$'`, `$$`, and `$1` as text.",
      "Backtick token: $`",
      "",
    ].join("\n");
    const desired = (content: string) => desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configPath(),
        regionKey: "codex-cli:agent-shorthand",
        commentPrefix: "#",
        content,
        plugin: "agent-shorthand-test",
      }],
    });
    const expected = (content: string) => [
      userContent.trimEnd(),
      "",
      "# --- prism:codex-cli:agent-shorthand begin ---",
      content.trimEnd(),
      "# --- prism:codex-cli:agent-shorthand end ---",
      "",
    ].join("\n");

    await nodeWriteFile(configPath(), userContent);
    const seeded = await refresh(desired("placeholder\n"));
    expect(kinds(seeded)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toBe(expected("placeholder\n"));

    const updated = await refresh(desired(shorthandLikeContent));
    expect(kinds(updated)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toBe(expected(shorthandLikeContent));

    const second = await refresh(desired(shorthandLikeContent));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(second.converged).toBe(true);
    expect(await readFile(configPath())).toBe(expected(shorthandLikeContent));
  });

  test("json-key region preserves comments and foreign keys in JSONC", async () => {
    const mcpJson = join(root, "mcp.json");
    await nodeWriteFile(mcpJson, [
      "{",
      "  // user comment survives",
      "  \"mcpServers\": {",
      "    \"user-thing\": { \"command\": \"mine\" }",
      "  }",
      "}",
      "",
    ].join("\n"));

    const desired = desiredWith({
      regions: [{
        kind: "json-key" as const,
        targetPath: mcpJson,
        regionKey: "mcpServers.prism-generated-demo",
        jsonPath: ["mcpServers", "prism-generated-demo"],
        value: { command: "bun", args: ["/x/server.mjs"] },
        plugin: "demo",
      }],
    });

    const first = await refresh(desired);
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = await readFile(mcpJson);
    expect(after).toContain("// user comment survives");
    expect(after).toContain("user-thing");
    expect(after).toContain("prism-generated-demo");

    const second = await refresh(desired);
    expect(second.converged).toBe(true);

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = await readFile(mcpJson);
    expect(final).not.toContain("prism-generated-demo");
    expect(final).toContain("user-thing");
    expect(final).toContain("// user comment survives");
  });

  test("anchored marker region lands inside the user's structure, never duplicating it", async () => {
    const configYaml = join(root, "config.yaml");
    await nodeWriteFile(configYaml, [
      "log_level: info",
      "mcp_servers:",
      "  user-server:",
      "    url: https://example.com/mcp",
      "rooms:",
      "  - lobby",
      "",
    ].join("\n"));

    const anchored = desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configYaml,
        regionKey: "hermes.mcp.prism-generated-demo",
        commentPrefix: "#",
        anchor: "mcp_servers:",
        content: "  prism-generated-demo:\n    command: \"bun\"",
        plugin: "demo",
      }],
    });

    const first = await refresh(anchored);
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = await readFile(configYaml);
    // Fence inserted directly under the user's existing mcp_servers: key —
    // no second mcp_servers: line is ever created.
    expect(after.match(/^mcp_servers:$/gm) ?? []).toHaveLength(1);
    expect(after).toContain(
      "mcp_servers:\n# --- prism:hermes.mcp.prism-generated-demo begin ---",
    );
    expect(after).toContain("user-server:");
    expect(after).toContain("rooms:");

    const second = await refresh(anchored);
    expect(second.converged).toBe(true);

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = await readFile(configYaml);
    expect(final).not.toContain("prism-generated-demo");
    expect(final).toContain("user-server:");
  });

  test("anchored marker region creates the anchor line when absent", async () => {
    const configYaml = join(root, "config.yaml");
    await nodeWriteFile(configYaml, "log_level: info\n");

    await refresh(desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configYaml,
        regionKey: "hermes.mcp.prism-generated-demo",
        commentPrefix: "#",
        anchor: "mcp_servers:",
        content: "  prism-generated-demo:\n    command: \"bun\"",
        plugin: "demo",
      }],
    }));

    const after = await readFile(configYaml);
    expect(after).toContain("log_level: info");
    expect(after.match(/^mcp_servers:$/gm) ?? []).toHaveLength(1);
    expect(after).toContain(
      "mcp_servers:\n# --- prism:hermes.mcp.prism-generated-demo begin ---",
    );
  });

  test("anchored TOML scalar marker skips when user config already satisfies it", async () => {
    const configToml = join(root, "config.toml");
    const desired = desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configToml,
        regionKey: "codex.features.hooks",
        commentPrefix: "#",
        anchor: "[features]",
        content: "hooks = true",
        skipIfTomlScalarExists: { table: "features", key: "hooks", value: true },
        plugin: "demo",
      }],
    });

    await nodeWriteFile(configToml, "[features]\nhooks = true\nmodel_widget = true\n");
    const first = await refresh(desired);
    expect(kinds(first)).toEqual(["skip-regions"]);
    const unchanged = await readFile(configToml);
    expect(unchanged).not.toContain("prism:codex.features.hooks");
    expect(unchanged.match(/^hooks = true$/gm) ?? []).toHaveLength(1);
    const snapshotAfterSkip = await readSnapshot({
      prismHome: home,
      harness: "codex-cli",
      root,
    });
    expect(
      snapshotAfterSkip.manifest.entries.some((entry) =>
        entry.regionKey?.includes("codex.features.hooks")
      ),
    ).toBe(false);

    await nodeWriteFile(
      configToml,
      [
        "[features]",
        "# --- prism:codex.features.hooks begin ---",
        "hooks = true",
        "# --- prism:codex.features.hooks end ---",
        "hooks = true",
        "model_widget = true",
        "",
      ].join("\n"),
    );
    const repaired = await refresh(desired);
    expect(kinds(repaired)).toEqual(["patch-regions"]);
    const afterRepair = await readFile(configToml);
    expect(afterRepair).not.toContain("prism:codex.features.hooks");
    expect(afterRepair.match(/^hooks = true$/gm) ?? []).toHaveLength(1);

    await nodeWriteFile(configToml, "[features]\n\"hooks\" = true\n");
    const quoted = await refresh(desired);
    expect(kinds(quoted)).toEqual(["skip-regions"]);
    expect(await readFile(configToml)).not.toContain("prism:codex.features.hooks");

    await nodeWriteFile(configToml, "features.hooks = true\n");
    const dotted = await refresh(desired);
    expect(kinds(dotted)).toEqual(["skip-regions"]);
    expect(await readFile(configToml)).not.toContain("prism:codex.features.hooks");

    await nodeWriteFile(configToml, "[features]\nhooks = false\n");
    const conflicted = await refresh(desired);
    expect(conflicted.blocked).toHaveLength(1);
    expect(conflicted.blocked[0]?.hint).toContain("features.hooks");
    expect(await readFile(configToml)).not.toContain("prism:codex.features.hooks");
  });

  test("json-array-member region owns one element and never rewrites neighbors", async () => {
    const settings = join(root, "settings.json");
    await nodeWriteFile(settings, `${JSON.stringify({
      packages: ["./packages/user-package"],
      theme: "dark",
    }, null, 2)}\n`);

    const member = (value: string) => desiredWith({
      regions: [{
        kind: "json-array-member" as const,
        targetPath: settings,
        regionKey: "packages.prism-generated-demo",
        jsonPath: ["packages"],
        value,
        plugin: "demo",
      }],
    });

    const first = await refresh(member("./packages/prism-generated-demo"));
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = JSON.parse(await readFile(settings)) as { packages: string[]; theme: string };
    expect(after.packages).toEqual(["./packages/user-package", "./packages/prism-generated-demo"]);
    expect(after.theme).toBe("dark");

    const second = await refresh(member("./packages/prism-generated-demo"));
    expect(second.converged).toBe(true);

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = JSON.parse(await readFile(settings)) as { packages: string[] };
    expect(final.packages).toEqual(["./packages/user-package"]);
  });

  test("json-array-member region with memberKey replaces the identified record", async () => {
    const installed = join(root, "plugins", "installed.json");
    await mkdir(join(root, "plugins"), { recursive: true });
    await nodeWriteFile(installed, `${JSON.stringify({
      version: 1,
      plugins: [
        { id: "user-plugin", enabled: true },
        { id: "prism-generated-demo", enabled: false, stale: true },
      ],
    }, null, 2)}\n`);

    const record = { id: "prism-generated-demo", enabled: true, source: "local-path" };
    const first = await refresh(desiredWith({
      regions: [{
        kind: "json-array-member" as const,
        targetPath: installed,
        regionKey: "installed.prism-generated-demo",
        jsonPath: ["plugins"],
        value: record,
        memberKey: ["id"],
        plugin: "demo",
      }],
    }));
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = JSON.parse(await readFile(installed)) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(after.plugins).toEqual([
      { id: "user-plugin", enabled: true },
      record,
    ]);

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = JSON.parse(await readFile(installed)) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(final.plugins).toEqual([{ id: "user-plugin", enabled: true }]);
  });

  test("structurally incompatible shared files classify as blocked, not thrown", async () => {
    const settings = join(root, "settings.json");
    await nodeWriteFile(settings, `${JSON.stringify({ packages: "not-an-array" }, null, 2)}\n`);

    const report = await refresh(desiredWith({
      regions: [{
        kind: "json-array-member" as const,
        targetPath: settings,
        regionKey: "packages.prism-generated-demo",
        jsonPath: ["packages"],
        value: "./packages/prism-generated-demo",
        plugin: "demo",
      }],
    }));
    expect(kinds(report)).toEqual(["blocked"]);
    expect(report.blocked[0]?.hint).toContain("packages.prism-generated-demo");
    expect(await readFile(settings)).toContain("not-an-array");
  });

  test("a directory at a shared config target classifies as blocked; other ops land", async () => {
    const settings = join(root, "settings.json");
    await mkdir(settings, { recursive: true });
    const skill = join(root, "skills", "ok", "SKILL.md");

    const report = await refresh(desiredWith({
      files: [{ targetPath: skill, content: "ok\n", plugin: "ok" }],
      regions: [{
        kind: "json-key" as const,
        targetPath: settings,
        regionKey: "mcpServers.prism-generated-demo",
        jsonPath: ["mcpServers", "prism-generated-demo"],
        value: { command: "bun" },
        plugin: "demo",
      }],
    }));

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]?.hint).toContain("shared config target");
    expect(report.failures).toEqual([]);
    expect(await readFile(skill)).toBe("ok\n");

    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.map((entry) => entry.targetPath)).toEqual([skill]);
  });
});

// Root cause (see src/sync/legacy-prism-entries.ts's module doc): codex,
// hermes, and cursor's now-retired aggregated MCP scheme attributed its one
// shared region/entry to the synthetic union-owner sentinel 'prism#shim'
// (commit be15253), never a real, individually-compilable plugin. A refresh
// is always scoped to a real plugin (`refresh.ts`'s `scopePlugins`), so the
// standard snapshot-driven orphan prune can never fire for that sentinel —
// the entry is carried into every manifest, forever, even on a full refresh.
// Grok and claude-code never had this problem: their per-plugin regions
// (and, for claude-code, whole per-plugin-bundle files) were always
// attributed to a REAL owner plugin, so the existing orphan-prune already
// converges them the moment that plugin stops being an owner. These tests
// exercise the fix: a scope-independent sweep for reserved legacy identities
// that runs on every refresh regardless of snapshot history.
describe("sync engine — legacy Prism MCP entry sweep", () => {
  test("codex: refresh sweeps the retired aggregated marker fence; the plugin's own region and surrounding user bytes survive", async () => {
    const configToml = join(root, "config.toml");
    const legacyFence = [
      "# --- prism:codex.mcp.prism-mcp-shim begin ---",
      '["mcp_servers"."prism-mcp-shim"]',
      'command = "prism"',
      'args = ["mcp", "shim"]',
      "enabled = true",
      "required = false",
      'default_tools_approval_mode = "approve"',
      'enabled_tools = ["booth__context_get", "tower__create_glyph"]',
      '["mcp_servers"."prism-mcp-shim"."env"]',
      'PRISM_SHIM_PLUGINS = "booth,tower"',
      'PRISM_SHIM_HARNESS = "codex-cli"',
      "# --- prism:codex.mcp.prism-mcp-shim end ---",
    ].join("\n");
    await nodeWriteFile(configToml, `# my hand-written config\n\n${legacyFence}\n`);

    const ownServerKey = pluginServerKey("booth");
    const ownRegion = {
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: `codex.mcp.${ownServerKey}`,
      commentPrefix: "#",
      content: [
        `["mcp_servers"."${ownServerKey}"]`,
        'command = "prism"',
        'args = ["mcp", "shim"]',
        "enabled = true",
        'enabled_tools = ["context_get"]',
        `["mcp_servers"."${ownServerKey}"."env"]`,
        'PRISM_SHIM_PLUGINS = "booth"',
        'PRISM_SHIM_HARNESS = "codex-cli"',
        'PRISM_SHIM_NAMING = "per-plugin"',
      ].join("\n"),
      plugin: "booth",
    };

    const report = await refresh(desiredWith({ regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);
    expect(report.failures).toEqual([]);
    expect(report.blocked).toEqual([]);

    const after = await readFile(configToml);
    expect(after).not.toContain("prism-mcp-shim");
    expect(after).toContain("prism:codex.mcp.booth");
    expect(after).toContain(`["mcp_servers"."${ownServerKey}"]`);
    expect(after).toContain("# my hand-written config");

    // Idempotent: nothing left to sweep, converges silently.
    const second = await refresh(desiredWith({ regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
  });

  test("hermes: refresh sweeps the retired aggregated marker fence in config.yaml; the plugin's own region survives", async () => {
    const configYaml = join(root, "config.yaml");
    const legacyFence = [
      "# --- prism:hermes.mcp.prism-mcp-shim begin ---",
      "mcp_servers:",
      "  prism-mcp-shim:",
      '    command: "prism"',
      "    args: [mcp, shim]",
      "    tools:",
      "      include: [booth__context_get]",
      "# --- prism:hermes.mcp.prism-mcp-shim end ---",
    ].join("\n");
    await nodeWriteFile(configYaml, `# hermes hand-written config\n\n${legacyFence}\n`);

    const ownServerKey = pluginServerKey("booth");
    const ownRegion = {
      kind: "marker" as const,
      targetPath: configYaml,
      regionKey: `hermes.mcp.${ownServerKey}`,
      commentPrefix: "#",
      content: [
        "mcp_servers:",
        `  ${ownServerKey}:`,
        '    command: "prism"',
        "    args: [mcp, shim]",
      ].join("\n"),
      plugin: "booth",
    };

    const report = await refresh(desiredWith({ harness: "hermes", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);

    const after = await readFile(configYaml);
    expect(after).not.toContain("prism-mcp-shim");
    expect(after).toContain(`prism:hermes.mcp.${ownServerKey}`);
    expect(after).toContain("# hermes hand-written config");

    const second = await refresh(desiredWith({ harness: "hermes", regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
  });

  test("cursor: refresh sweeps the legacy shim entry AND both dead pre-shim HTTP-era entries (X-Prism-Mcp-Exposure provenance); the plugin's own entry and a hand-authored server survive", async () => {
    const mcpJson = join(root, "mcp.json");
    const legacyContent = {
      mcpServers: {
        "prism-mcp-shim": {
          command: "prism",
          args: ["mcp", "shim"],
          env: { PRISM_SHIM_PLUGINS: "booth,tower", PRISM_SHIM_HARNESS: "cursor" },
        },
        // Pre-shim HTTP-transport era artifacts (docs/mcp-http-goal.md):
        // dead loopback servers, no live daemon behind either port. The
        // X-Prism-Mcp-Exposure header is the real dead pair's provenance —
        // without it, name shape alone must never be grounds for removal.
        "prism-generated-cursor-tools": {
          url: "http://127.0.0.1:53966/mcp",
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-cursor-tools:cursor" },
        },
        p_4b4d1659: {
          url: "http://127.0.0.1:64410/mcp",
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-cursor-tools:cursor" },
        },
        "hand-authored-server": { command: "node", args: ["server.js"] },
      },
    };
    await nodeWriteFile(mcpJson, `${JSON.stringify(legacyContent, null, 2)}\n`);

    const ownServerKey = pluginServerKey("booth");
    const ownRegion = {
      kind: "json-key" as const,
      targetPath: mcpJson,
      regionKey: `mcpServers.${ownServerKey}`,
      jsonPath: ["mcpServers", ownServerKey],
      value: {
        command: "prism",
        args: ["mcp", "shim"],
        env: { PRISM_SHIM_PLUGINS: "booth", PRISM_SHIM_HARNESS: "cursor", PRISM_SHIM_NAMING: "per-plugin" },
      },
      plugin: "booth",
    };

    const report = await refresh(desiredWith({ harness: "cursor", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);

    const parsed = JSON.parse(await readFile(mcpJson)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["hand-authored-server", ownServerKey].sort());
    expect(parsed.mcpServers["hand-authored-server"]).toEqual({ command: "node", args: ["server.js"] });
    expect(parsed.mcpServers[ownServerKey]).toEqual(ownRegion.value);

    const second = await refresh(desiredWith({ harness: "cursor", regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
  });

  test("cursor: provenance gating — a user's own p_<hash8> and prism-generated-<name> servers survive; only genuine prism-provenance legacy is pruned", async () => {
    const mcpJson = join(root, "mcp.json");
    const legacyContent = {
      mcpServers: {
        // Genuine retired Prism artifact: legacy name shape AND real
        // provenance (the dead HTTP-era pair's X-Prism-Mcp-Exposure header)
        // — this one, and only this one, must be pruned.
        p_1a2b3c4d: {
          url: "http://127.0.0.1:9999/mcp",
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-retired:cursor" },
        },
        // A user's OWN server that happens to collide with the bare
        // p_<hash8> namespace shape — no Prism provenance at all.
        p_a1b2c3d4: { command: "my-own-tool", args: ["--serve"] },
        // A user's OWN server literally named with the retired
        // prism-generated- prefix — again, no Prism provenance.
        "prism-generated-my-internal-tool": { url: "https://my.internal/mcp" },
        // An unrelated server, name doesn't even match the legacy shape.
        "my-other-server": { command: "node", args: ["server.js"] },
      },
    };
    await nodeWriteFile(mcpJson, `${JSON.stringify(legacyContent, null, 2)}\n`);

    const ownServerKey = pluginServerKey("booth");
    const ownRegion = {
      kind: "json-key" as const,
      targetPath: mcpJson,
      regionKey: `mcpServers.${ownServerKey}`,
      jsonPath: ["mcpServers", ownServerKey],
      value: {
        command: "prism",
        args: ["mcp", "shim"],
        env: { PRISM_SHIM_PLUGINS: "booth", PRISM_SHIM_HARNESS: "cursor", PRISM_SHIM_NAMING: "per-plugin" },
      },
      plugin: "booth",
    };

    const report = await refresh(desiredWith({ harness: "cursor", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);

    const parsed = JSON.parse(await readFile(mcpJson)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(
      ["my-other-server", "p_a1b2c3d4", "prism-generated-my-internal-tool", ownServerKey].sort(),
    );
    expect(parsed.mcpServers.p_a1b2c3d4).toEqual({ command: "my-own-tool", args: ["--serve"] });
    expect(parsed.mcpServers["prism-generated-my-internal-tool"]).toEqual({ url: "https://my.internal/mcp" });
    expect(parsed.mcpServers["my-other-server"]).toEqual({ command: "node", args: ["server.js"] });
    expect(parsed.mcpServers[ownServerKey]).toEqual(ownRegion.value);
  });

  test("cursor: a live plugin literally named p_deadbeef survives its own compile — no self-cannibalization, snapshot stays truthful, idempotent", async () => {
    // pluginServerKey sanitizes an already-legal name byte-identical, which
    // is ALSO the retired bare p_<hash8> namespace shape — the exact
    // collision the provenance + desired-keys gating must resolve.
    const pluginName = "p_deadbeef";
    expect(pluginServerKey(pluginName)).toBe("p_deadbeef");

    const mcpJson = join(root, "mcp.json");
    const ownRegion = {
      kind: "json-key" as const,
      targetPath: mcpJson,
      regionKey: `mcpServers.${pluginName}`,
      jsonPath: ["mcpServers", pluginName],
      value: {
        command: "prism",
        args: ["mcp", "shim"],
        env: { PRISM_SHIM_PLUGINS: pluginName, PRISM_SHIM_HARNESS: "cursor", PRISM_SHIM_NAMING: "per-plugin" },
      },
      plugin: pluginName,
    };

    const report = await refresh(desiredWith({ harness: "cursor", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);

    const parsed = JSON.parse(await readFile(mcpJson)) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers[pluginName]).toEqual(ownRegion.value);

    // Snapshot must equal disk: the entry actually landed, so it must be
    // recorded — never a snapshot lie about a region written then swept
    // away in the same pass.
    const snapshot = await readSnapshot({ prismHome: home, harness: "cursor", root });
    const entry = snapshot.manifest.entries.find(
      (candidate) => candidate.regionKey?.includes(`mcpServers.${pluginName}`),
    );
    expect(entry).toBeDefined();
    expect(entry?.plugin).toBe(pluginName);

    // Idempotent second pass: no further churn, the entry still survives.
    const second = await refresh(desiredWith({ harness: "cursor", regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
    const parsedAgain = JSON.parse(await readFile(mcpJson)) as { mcpServers: Record<string, unknown> };
    expect(parsedAgain.mcpServers[pluginName]).toEqual(ownRegion.value);
  });

  test("codex: a live plugin whose name sanitizes to prism-mcp-shim survives the marker sweep — snapshot truthful, idempotent", async () => {
    // pluginServerKey("prism.mcp.shim") sanitizes dots to dashes, colliding
    // byte-identical with the retired sentinel's region key. The marker
    // branch must honor its desiredRegions gate exactly like the JSON
    // branch — fence authorship alone does not disambiguate the retired
    // sentinel from a live plugin's current region.
    const pluginName = "prism.mcp.shim";
    expect(pluginServerKey(pluginName)).toBe("prism-mcp-shim");
    const target = join(root, "config.toml");
    await nodeWriteFile(target, "# hand-written\n");
    const regionKey = `codex.mcp.${pluginServerKey(pluginName)}`;
    const ownRegion = {
      kind: "marker" as const,
      targetPath: target,
      regionKey,
      commentPrefix: "#",
      content: `["mcp_servers"."${pluginServerKey(pluginName)}"]\ncommand = "prism"`,
      plugin: pluginName,
    };

    const report = await refresh(desiredWith({ harness: "codex-cli", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);
    const after = await readFile(target);
    expect(after).toContain(`prism:${regionKey} begin`);
    expect(after).toContain('command = "prism"');

    // Snapshot must equal disk — the surviving fence is recorded.
    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    const entry = snapshot.manifest.entries.find(
      (candidate) => candidate.regionKey?.includes(regionKey),
    );
    expect(entry).toBeDefined();

    // Idempotent second pass.
    const second = await refresh(desiredWith({ harness: "codex-cli", regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(await readFile(target)).toContain(`prism:${regionKey} begin`);
  });

  test("hermes: a live plugin whose name sanitizes to prism-mcp-shim survives the marker sweep — snapshot truthful, idempotent", async () => {
    // pluginServerKey("prism.mcp.shim") sanitizes dots to dashes, colliding
    // byte-identical with the retired sentinel's region key. The marker
    // branch must honor its desiredRegions gate exactly like the JSON
    // branch — fence authorship alone does not disambiguate the retired
    // sentinel from a live plugin's current region.
    const pluginName = "prism.mcp.shim";
    expect(pluginServerKey(pluginName)).toBe("prism-mcp-shim");
    const target = join(root, "config.yaml");
    await nodeWriteFile(target, "# hand-written\n");
    const regionKey = `hermes.mcp.${pluginServerKey(pluginName)}`;
    const ownRegion = {
      kind: "marker" as const,
      targetPath: target,
      regionKey,
      commentPrefix: "#",
      content: `["mcp_servers"."${pluginServerKey(pluginName)}"]\ncommand = "prism"`,
      plugin: pluginName,
    };

    const report = await refresh(desiredWith({ harness: "hermes", regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);
    const after = await readFile(target);
    expect(after).toContain(`prism:${regionKey} begin`);
    expect(after).toContain('command = "prism"');

    // Snapshot must equal disk — the surviving fence is recorded.
    const snapshot = await readSnapshot({ prismHome: home, harness: "hermes", root });
    const entry = snapshot.manifest.entries.find(
      (candidate) => candidate.regionKey?.includes(regionKey),
    );
    expect(entry).toBeDefined();

    // Idempotent second pass.
    const second = await refresh(desiredWith({ harness: "hermes", regions: [ownRegion] }));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(await readFile(target)).toContain(`prism:${regionKey} begin`);
  });

  test("a sentinel-owned snapshot entry (prism#shim) is dropped, not carried — doctor never sees owned-but-missing for swept legacy regions", async () => {
    const configToml = join(root, "config.toml");
    await nodeWriteFile(configToml, "# hand-written\n");
    // Seed: a manifest still carrying the retired union scheme's entry.
    await commitSnapshot({
      prismHome: home,
      manifest: {
        version: 1,
        harness: "codex-cli",
        root,
        entries: [{
          targetPath: configToml,
          contentHash: "stale",
          mode: "region" as const,
          regionKey: "marker # codex.mcp.prism-mcp-shim",
          plugin: "prism#shim",
        }],
      },
    });

    // Any real plugin's scoped pass drops the sentinel entry from the manifest.
    const ownRegion = {
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: "codex.mcp.booth",
      commentPrefix: "#",
      content: '["mcp_servers"."booth"]\ncommand = "prism"',
      plugin: "booth",
    };
    await refresh(desiredWith({ harness: "codex-cli", regions: [ownRegion] }));

    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.some((entry) => entry.plugin === "prism#shim")).toBe(false);
    expect(snapshot.manifest.entries.some((entry) => entry.plugin === "booth")).toBe(true);
  });

  test("codex: an unfenced user TOML table literally named prism-mcp-shim survives — the marker fence delimiters are the provenance, not the key name", async () => {
    const configToml = join(root, "config.toml");
    // No `# --- prism:codex.mcp.prism-mcp-shim begin/end ---` fence at all —
    // this is a hand-authored table that merely shares the retired
    // sentinel's name, which the marker sweep must never touch.
    const userContent = [
      "# my hand-written config",
      "",
      '["mcp_servers"."prism-mcp-shim"]',
      'command = "my-own-tool"',
      "",
    ].join("\n");
    await nodeWriteFile(configToml, userContent);

    const ownServerKey = pluginServerKey("booth");
    const ownRegion = {
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: `codex.mcp.${ownServerKey}`,
      commentPrefix: "#",
      content: [
        `["mcp_servers"."${ownServerKey}"]`,
        'command = "prism"',
        'args = ["mcp", "shim"]',
      ].join("\n"),
      plugin: "booth",
    };

    const report = await refresh(desiredWith({ regions: [ownRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);

    const after = await readFile(configToml);
    expect(after).toContain('["mcp_servers"."prism-mcp-shim"]');
    expect(after).toContain('command = "my-own-tool"');
    expect(after).toContain("# my hand-written config");
    expect(after).toContain(`prism:codex.mcp.${ownServerKey}`);
  });

  test("grok: the retired union region grok.mcp.prism is swept; a live plugin sanitizing to prism survives via the desired gate", async () => {
    const configToml = join(root, "config.toml");
    const legacyFence = [
      "# --- prism:grok.mcp.prism begin ---",
      '["mcp_servers"."prism"]',
      'command = "prism"',
      'args = ["mcp", "shim"]',
      "# --- prism:grok.mcp.prism end ---",
    ].join("\n");
    await nodeWriteFile(configToml, `# hand-written\n\n${legacyFence}\n`);

    // An unrelated plugin's pass visits the file; nothing claims the
    // retired key, so the fence is swept.
    const boothRegion = {
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: "grok.mcp.booth",
      commentPrefix: "#",
      content: '["mcp_servers"."booth"]\ncommand = "prism"',
      plugin: "booth",
    };
    const report = await refresh(desiredWith({ harness: "grok", regions: [boothRegion] }));
    expect(kinds(report)).toEqual(["patch-regions"]);
    const after = await readFile(configToml);
    expect(after).not.toContain("grok.mcp.prism");
    expect(after).toContain("# hand-written");

    // A live plugin whose name sanitizes to `prism` claims the key: survives.
    await nodeWriteFile(configToml, `# hand-written\n\n${legacyFence}\n`);
    const ownRegion = {
      kind: "marker" as const,
      targetPath: configToml,
      regionKey: "grok.mcp.prism",
      commentPrefix: "#",
      content: '["mcp_servers"."prism"]\ncommand = "prism"',
      plugin: "prism",
    };
    const claimed = await refresh(desiredWith({ harness: "grok", regions: [ownRegion] }));
    expect(kinds(claimed)).toEqual(["patch-regions"]);
    expect(await readFile(configToml)).toContain("prism:grok.mcp.prism begin");
  });
});

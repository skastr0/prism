import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile as nodeWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import { readSnapshot, snapshotPath } from "../state/store.js";
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

  test("owned files replaced by shared regions are backed up and recreated from regions only", async () => {
    const agentsPath = join(root, "AGENTS.md");
    await refresh(desiredWith({
      files: [{
        targetPath: agentsPath,
        content: "# Old Prism-owned Codex rules\n",
        plugin: "rules-demo",
      }],
    }));

    const migrated = await refresh(desiredWith({
      regions: [{
        kind: "marker",
        targetPath: agentsPath,
        regionKey: "codex.rules.rules-demo",
        commentPrefix: "<!--",
        commentSuffix: " -->",
        content: "# New Codex rules\n",
        plugin: "rules-demo",
      }],
    }));

    expect(migrated.blocked).toEqual([]);
    expect(migrated.ops).toEqual([
      expect.objectContaining({ kind: "prune", targetPath: agentsPath, backup: true }),
      expect.objectContaining({ kind: "patch-regions", targetPath: agentsPath, create: true }),
    ]);
    expect(migrated.backups).toHaveLength(1);
    expect(await readFile(migrated.backups[0]!)).toBe("# Old Prism-owned Codex rules\n");
    const agents = await readFile(agentsPath);
    expect(agents).not.toContain("Old Prism-owned Codex rules");
    expect(agents).toBe(
      "<!-- --- prism:codex.rules.rules-demo begin --- -->\n" +
        "# New Codex rules\n" +
        "<!-- --- prism:codex.rules.rules-demo end --- -->\n",
    );
  });

  test("unmanaged legacy generated shared files can be replaced by lowerer-owned regions", async () => {
    const agentsPath = join(root, "AGENTS.md");
    const legacyGeneratedRules = [
      "<!-- prism:rules source=\"rules/global/qa-rules.md\" -->",
      "---",
      "description: Global QA rules loaded as Prism context",
      "---",
      "",
      "# QA Rules",
      "",
      "Generated by the retired whole-file lowerer.",
      "",
    ].join("\n");
    await nodeWriteFile(
      agentsPath,
      legacyGeneratedRules,
    );

    const migrated = await refresh(desiredWith({
      regions: [{
        kind: "marker",
        targetPath: agentsPath,
        regionKey: "codex.rules.rules-demo",
        commentPrefix: "<!--",
        commentSuffix: " -->",
        content: legacyGeneratedRules,
        resetUnmanagedFileIfContains: "<!-- prism:rules source=",
        plugin: "rules-demo",
      }],
    }));

    expect(migrated.blocked).toEqual([]);
    expect(migrated.ops).toEqual([
      expect.objectContaining({
        kind: "patch-regions",
        targetPath: agentsPath,
        backup: true,
        create: false,
      }),
    ]);
    expect(migrated.backups).toHaveLength(1);
    expect(await readFile(migrated.backups[0]!)).toBe(legacyGeneratedRules);
    expect(await readFile(agentsPath)).toBe(
      "<!-- --- prism:codex.rules.rules-demo begin --- -->\n" +
        legacyGeneratedRules +
        "<!-- --- prism:codex.rules.rules-demo end --- -->\n",
    );
  });

  test("unmanaged AGENTS files that merely mention the legacy marker are preserved", async () => {
    const agentsPath = join(root, "AGENTS.md");
    const original = [
      "# User AGENTS",
      "",
      "Do not treat this hand-written file as generated output.",
      "<!-- prism:rules source=\"global/context.md\" -->",
      "This marker is part of a user note, not whole-file Prism output.",
      "",
      "User footer.",
      "",
    ].join("\n");
    await nodeWriteFile(agentsPath, original);

    const migrated = await refresh(desiredWith({
      regions: [{
        kind: "marker",
        targetPath: agentsPath,
        regionKey: "codex.rules.rules-demo",
        commentPrefix: "<!--",
        commentSuffix: " -->",
        content: "# New Codex rules\n",
        resetUnmanagedFileIfContains: "<!-- prism:rules source=",
        plugin: "rules-demo",
      }],
    }));

    expect(migrated.blocked).toEqual([]);
    expect(migrated.ops).toEqual([
      expect.objectContaining({
        kind: "patch-regions",
        targetPath: agentsPath,
        backup: true,
        create: false,
      }),
    ]);
    expect(migrated.backups).toHaveLength(1);
    expect(await readFile(migrated.backups[0]!)).toBe(original);
    expect(await readFile(agentsPath)).toBe(
      original +
        "\n" +
        "<!-- --- prism:codex.rules.rules-demo begin --- -->\n" +
        "# New Codex rules\n" +
        "<!-- --- prism:codex.rules.rules-demo end --- -->\n",
    );
  });

  test("unmanaged AGENTS files starting with legacy marker and user prose are preserved", async () => {
    const agentsPath = join(root, "AGENTS.md");
    const original = [
      "<!-- prism:rules source=\"global/context.md\" -->",
      "This is a hand-written note that happens to start with the old marker.",
      "It must not be mistaken for retired whole-file Codex output.",
      "",
      "User footer.",
      "",
    ].join("\n");
    await nodeWriteFile(agentsPath, original);

    const migrated = await refresh(desiredWith({
      regions: [{
        kind: "marker",
        targetPath: agentsPath,
        regionKey: "codex.rules.rules-demo",
        commentPrefix: "<!--",
        commentSuffix: " -->",
        content: "# New Codex rules\n",
        resetUnmanagedFileIfContains: "<!-- prism:rules source=",
        plugin: "rules-demo",
      }],
    }));

    expect(migrated.blocked).toEqual([]);
    expect(migrated.ops).toEqual([
      expect.objectContaining({
        kind: "patch-regions",
        targetPath: agentsPath,
        backup: true,
        create: false,
      }),
    ]);
    expect(migrated.backups).toHaveLength(1);
    expect(await readFile(migrated.backups[0]!)).toBe(original);
    expect(await readFile(agentsPath)).toBe(
      original +
        "\n" +
        "<!-- --- prism:codex.rules.rules-demo begin --- -->\n" +
        "# New Codex rules\n" +
        "<!-- --- prism:codex.rules.rules-demo end --- -->\n",
    );
  });

  test("unmanaged AGENTS files with legacy marker and markdown-looking user content are preserved", async () => {
    const agentsPath = join(root, "AGENTS.md");
    const original = [
      "<!-- prism:rules source=\"rules/global/qa-rules.md\" -->",
      "# User AGENTS",
      "",
      "This starts with the retired marker and a heading, but it is user prose.",
      "It must not be reset unless the whole file equals the desired generated payload.",
      "",
    ].join("\n");
    await nodeWriteFile(agentsPath, original);

    const migrated = await refresh(desiredWith({
      regions: [{
        kind: "marker",
        targetPath: agentsPath,
        regionKey: "codex.rules.rules-demo",
        commentPrefix: "<!--",
        commentSuffix: " -->",
        content: "# New Codex rules\n",
        resetUnmanagedFileIfContains: "<!-- prism:rules source=",
        plugin: "rules-demo",
      }],
    }));

    expect(migrated.blocked).toEqual([]);
    expect(migrated.ops).toEqual([
      expect.objectContaining({
        kind: "patch-regions",
        targetPath: agentsPath,
        backup: true,
        create: false,
      }),
    ]);
    expect(migrated.backups).toHaveLength(1);
    expect(await readFile(migrated.backups[0]!)).toBe(original);
    expect(await readFile(agentsPath)).toBe(
      original +
        "\n" +
        "<!-- --- prism:codex.rules.rules-demo begin --- -->\n" +
        "# New Codex rules\n" +
        "<!-- --- prism:codex.rules.rules-demo end --- -->\n",
    );
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

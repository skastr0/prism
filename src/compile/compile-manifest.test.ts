import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import type { AgentCacheDescriptor } from "./cache.js";
import {
  buildCompileManifestForTarget,
  commitCompileManifest,
  compileManifestPath,
  emptyCompileManifest,
  readCompileManifest,
  verifyCompileManifestHash,
} from "./compile-manifest.js";
import type { ComposedAgent } from "./compose.js";
import { emptyRegistry } from "./registry.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-compile-manifest-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const registry = () => emptyRegistry("/tmp/forge", "forge", "1.0.0");

const descriptorFor = (name: string, hash: string): AgentCacheDescriptor => ({
  key: `${name}-key`,
  sourceHash: hash,
  contextHash: `${name}-context`,
  inputs: [{ plugin: "forge", path: `agents/${name}.agent.ts`, contentHash: hash }],
});

const agent = (name: string, hash: string, tools: readonly string[] = []): ComposedAgent => ({
  name,
  description: `${name} agent`,
  body: `# ${name}`,
  color: undefined,
  model: { model: `${name}-model` },
  targetOverride: {},
  skills: ["forge:testing"],
  allowedSkills: ["forge:testing"],
  allowedTools: [...tools],
  toolBindings: tools.map((tool) => ({
    kind: "permission" as const,
    logicalName: tool,
    toolPluginName: "forge",
    toolName: tool,
    toolSourcePath: `/tmp/forge/tools/${tool}.tool.ts`,
  })),
  manifest: {
    traits: [{ id: "forge:builder", ref: "builder" }],
    modelBindings: { modelspace: "forge:models", profile: name },
  },
});

describe("compile manifest writer", () => {
  test("merges target slices and prunes retired agents for the current target", () => {
    const first = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell"]), agent("reviewer", "b".repeat(64))],
      cacheDescriptors: new Map([
        ["builder", descriptorFor("builder", "a".repeat(64))],
        ["reviewer", descriptorFor("reviewer", "b".repeat(64))],
      ]),
    });
    const second = buildCompileManifestForTarget({
      base: first,
      registry: registry(),
      target: "claude-code",
      scope: "global",
      composed: [agent("builder", "a".repeat(64), ["run_shell"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });
    const pruned = buildCompileManifestForTarget({
      base: second,
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell", "read_file"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });

    expect(Object.keys(pruned.agents).sort()).toEqual(["forge:builder"]);
    expect(Object.keys(pruned.agents["forge:builder"]!.composed.perTarget).sort()).toEqual([
      "claude-code",
      "opencode",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.perTarget.opencode?.allowedTools).toEqual([
      "run_shell",
      "read_file",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.perTarget.opencode?.toolGrants).toEqual([
      "forge:run_shell",
      "forge:read_file",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.grants.tools).toEqual([
      "forge:read_file",
      "forge:run_shell",
    ]);
    expect(pruned.compileTargets).toEqual([
      { harness: "claude-code", scope: "global" },
      { harness: "opencode", scope: "project" },
    ]);
    expect(verifyCompileManifestHash(pruned)).toBe(true);
    // tools top-level populated from grants (minimal plugin+name or plugin+toolspace+name, source-free)
    expect(Object.keys(pruned.tools || {}).sort()).toEqual(["forge:read_file", "forge:run_shell"]);
    expect(pruned.tools?.["forge:run_shell"]).toEqual({ plugin: "forge", name: "run_shell" });
    expect(pruned.tools?.["forge:read_file"]).toEqual({ plugin: "forge", name: "read_file" });
    expect(JSON.stringify(pruned.tools)).not.toContain("sourcePath");
    expect(JSON.stringify(pruned.tools)).not.toContain("input");
    expect(JSON.stringify(pruned.tools)).not.toContain("handle");
    // modelspaces populated from bindings (no source paths)
    expect(Object.keys(pruned.modelspaces).sort()).toEqual(["forge:models"]);
    expect(pruned.modelspaces["forge:models"]).toEqual({
      plugin: "forge",
      modelspace: "models",
      profiles: ["builder"],
    });
    // traits populated from per-agent traits only (deduped by id, source-path free)
    expect(Object.keys(pruned.traits).sort()).toEqual(["forge:builder"]);
    expect(pruned.traits["forge:builder"]).toEqual({ id: "forge:builder", ref: "builder" });

    // orbits support: explicit pass on build populates minimal source-free entries for the plugin
    const withOrbits = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
      orbits: [{ name: "delivery-contract" }, { name: "experiment-template" }], // note: caller already filtered templates, but test uses name only
    });
    expect(Object.keys(withOrbits.orbits).sort()).toEqual(["forge:delivery-contract", "forge:experiment-template"]);
    expect(withOrbits.orbits["forge:delivery-contract"]).toEqual({ plugin: "forge", name: "delivery-contract" });
    expect(withOrbits.orbits["forge:experiment-template"]).toEqual({ plugin: "forge", name: "experiment-template" });
    // no sourcePath etc in manifest orbit entries
    expect(JSON.stringify(withOrbits.orbits)).not.toContain("sourcePath");
    expect(verifyCompileManifestHash(withOrbits)).toBe(true);
    // tools also populated (from the agent grants in this build)
    expect(Object.keys(withOrbits.tools || {}).length).toBeGreaterThan(0);
    expect(JSON.stringify(withOrbits.tools)).not.toContain("sourcePath");
  });

  test("commit/read round-trips deterministically and corrupt files quarantine", async () => {
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [agent("builder", "c".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "c".repeat(64))]]),
    });

    await commitCompileManifest({ prismHome: home, manifest });
    const path = compileManifestPath(home);
    const firstBytes = await readFile(path);
    await commitCompileManifest({ prismHome: home, manifest: (await readCompileManifest(home)).manifest });
    expect(await readFile(path)).toBe(firstBytes);

    await nodeWriteFile(path, "{ not json");
    const corrupt = await readCompileManifest(home);
    expect(corrupt.quarantinedPath).toContain(".corrupt-");
    expect(await exists(corrupt.quarantinedPath!)).toBe(true);
    expect(corrupt.manifest.agents).toEqual({});
    expect(verifyCompileManifestHash(corrupt.manifest)).toBe(true);
  });

  test("schema-valid hash drift quarantines instead of poisoning the next write", async () => {
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [agent("builder", "d".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "d".repeat(64))]]),
    });

    await commitCompileManifest({ prismHome: home, manifest });
    const path = compileManifestPath(home);
    await nodeWriteFile(path, (await readFile(path)).replace("builder agent", "tampered agent"));

    const corrupt = await readCompileManifest(home);
    expect(corrupt.quarantinedPath).toContain(".corrupt-");
    expect(await exists(corrupt.quarantinedPath!)).toBe(true);
    expect(corrupt.manifest.agents).toEqual({});
    expect(verifyCompileManifestHash(corrupt.manifest)).toBe(true);
  });
});

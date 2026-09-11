import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  type CompileManifest,
  type CompileManifestAgent,
  computeAgentManifestHash,
  computeCompileManifestHash,
  decodeCompileManifest,
  emptyCompileManifest,
  encodeCompileManifest,
  getCompileManifestAgent,
  getCompileManifestAgentForTarget,
  HarnessIdSchema,
  verifyAgentManifestHash,
  verifyCompileManifestHash,
} from "@skastr0/prism-sdk/compile-manifest";

const withAgentHash = (agent: Omit<CompileManifestAgent, "manifestHash">): CompileManifestAgent => {
  const hashed = { ...agent, manifestHash: "" };
  return { ...hashed, manifestHash: computeAgentManifestHash(hashed) };
};

const withManifestHash = (manifest: Omit<CompileManifest, "manifestHash">): CompileManifest => {
  const hashed = { ...manifest, manifestHash: "" };
  return { ...hashed, manifestHash: computeCompileManifestHash(hashed) };
};

const fixtureManifest = (): CompileManifest => withManifestHash({
  version: 1,
  plugins: {
    forge: { version: "1.4.0", sourceHash: "plugin-source" },
    core: { sourceHash: "core-source" },
  },
  compileTargets: [
    { harness: "grok", scope: "project" },
    { harness: "claude-code", scope: "global" },
  ],
  agents: {
    "forge:builder": withAgentHash({
      name: "builder",
      plugin: "forge",
      description: "Build specialist",
      sourceHash: "agent-source",
      skills: ["forge:build", "core:git"],
      composed: {
        modelBindings: { modelspace: "models", profile: "builder" },
        perTarget: {
          grok: {
            scope: "project",
            model: { model: "grok-code-fast-1", nested: { temperature: 0 } },
          },
          "claude-code": {
            scope: "global",
            model: null,
          },
        },
      },
    }),
  },
  modelspaces: {
    "forge:models": {
      plugin: "forge",
      modelspace: "models",
      profiles: ["builder"],
    },
  },
  skills: {
    "forge:build": { plugin: "forge", name: "build" },
    "core:git": { plugin: "core", name: "git" },
    "agent-core:core-skills": {
      plugin: "agent-core",
      skillspace: "core-skills",
      skills: ["testing"],
    },
  },
  tools: {
    "forge:run_shell": { plugin: "forge", name: "run_shell" },
    "core:create_commit": { plugin: "core", name: "create_commit" },
    "agent-core:inspect": { plugin: "agent-core", name: "inspect" },
  },
  sops: {
    "forge:beacon": {
      plugin: "forge",
      name: "beacon",
      phases: [
        {
          name: "explore",
          purpose: "Map the problem space",
          acceptanceCriteria: ["Hypothesis is falsifiable"],
          escalation: "Ask a human when the audience is unclear",
          input: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] },
        },
      ],
    },
  },
});

test("compile manifest decodes and encodes deterministically", () => {
  const manifest = fixtureManifest();
  const encoded = encodeCompileManifest(manifest);
  const decoded = decodeCompileManifest(encoded);

  expect(decoded._tag).toBe("Right");
  if (decoded._tag !== "Right") throw new Error("manifest did not decode");
  expect(encodeCompileManifest(decoded.right)).toBe(encoded);
  expect(verifyCompileManifestHash(decoded.right)).toBe(true);
  expect(verifyAgentManifestHash(decoded.right.agents["forge:builder"]!)).toBe(true);
  // tools populated as minimal identity refs, source-path free
  expect(Object.keys(decoded.right.tools).sort()).toEqual(["agent-core:inspect", "core:create_commit", "forge:run_shell"]);
  expect(decoded.right.tools["forge:run_shell"]).toEqual({ plugin: "forge", name: "run_shell" });
  expect(decoded.right.tools["core:create_commit"]).toEqual({ plugin: "core", name: "create_commit" });
  expect(JSON.stringify(decoded.right.tools)).not.toContain("sourcePath");
  expect(JSON.stringify(decoded.right.tools)).not.toContain("input");
  expect(JSON.stringify(decoded.right.tools)).not.toContain("handle");
  expect(decoded.right.sops["forge:beacon"]?.phases[0]?.acceptanceCriteria).toEqual([
    "Hypothesis is falsifiable",
  ]);
  expect(decoded.right.sops["forge:beacon"]?.phases[0]?.input).toEqual({
    type: "object",
    properties: { brief: { type: "string" } },
    required: ["brief"],
  });
});

test("compile manifest sorts records and arrays into stable bytes", () => {
  const manifest = fixtureManifest();
  const scrambled: CompileManifest = {
    ...manifest,
    plugins: {
      core: manifest.plugins.core!,
      forge: manifest.plugins.forge!,
    },
    compileTargets: [...manifest.compileTargets].reverse(),
    agents: {
      "forge:builder": {
        ...manifest.agents["forge:builder"]!,
        skills: [...manifest.agents["forge:builder"]!.skills].reverse(),
        composed: {
          ...manifest.agents["forge:builder"]!.composed,
          perTarget: {
            "claude-code": manifest.agents["forge:builder"]!.composed.perTarget["claude-code"]!,
            grok: manifest.agents["forge:builder"]!.composed.perTarget.grok!,
          },
        },
      },
    },
    modelspaces: {
      "forge:models": manifest.modelspaces["forge:models"]!,
    },
    skills: {
      "core:git": manifest.skills["core:git"]!,
      "agent-core:core-skills": {
        ...manifest.skills["agent-core:core-skills"]!,
        skills: [...manifest.skills["agent-core:core-skills"]!.skills].reverse(),
      },
      "forge:build": manifest.skills["forge:build"]!,
    },
    tools: {
      "core:create_commit": manifest.tools["core:create_commit"]!,
      "agent-core:inspect": manifest.tools["agent-core:inspect"]!,
      "forge:run_shell": manifest.tools["forge:run_shell"]!,
    },
    sops: {
      "forge:beacon": manifest.sops["forge:beacon"]!,
    },
  };

  expect(encodeCompileManifest(scrambled)).toBe(encodeCompileManifest(manifest));
  // tools stability: no sourcePath, schemas, or executable details in serialized form
  expect(JSON.stringify(encodeCompileManifest(manifest))).not.toContain("sourcePath");
  expect(JSON.stringify(encodeCompileManifest(manifest))).not.toContain(".tool.ts");
  expect(JSON.stringify(encodeCompileManifest(manifest))).not.toContain("handle");
});

test("compile manifest accessors expose agent and target slices", () => {
  const manifest = fixtureManifest();

  expect(getCompileManifestAgent(manifest, "forge:builder")?.description).toBe("Build specialist");
  expect(getCompileManifestAgentForTarget(manifest, "forge:builder", "grok")?.target.scope).toBe("project");
  expect(getCompileManifestAgentForTarget(manifest, "forge:builder", "codex-cli")).toBeUndefined();
});

test("compile manifest rejects unsupported versions distinctly", () => {
  const decoded = decodeCompileManifest(JSON.stringify({ ...fixtureManifest(), version: 2 }));

  expect(decoded._tag).toBe("UnsupportedCompileManifestVersion");
  if (decoded._tag !== "UnsupportedCompileManifestVersion") throw new Error("expected version error");
  expect(decoded.version).toBe(2);
});

test("compile manifest invalid payload fails schema decode", () => {
  const invalid = {
    ...fixtureManifest(),
    agents: {
      "forge:builder": {
        ...fixtureManifest().agents["forge:builder"]!,
        composed: { modelBindings: {} },
      },
    },
  };
  const decoded = decodeCompileManifest(JSON.stringify(invalid));

  expect(decoded._tag).toBe("Left");
});

test("compile manifest malformed JSON fails schema decode", () => {
  const decoded = decodeCompileManifest("{");

  expect(decoded._tag).toBe("Left");
});

test("empty compile manifest carries a self-consistent hash", () => {
  const manifest = emptyCompileManifest();

  expect(manifest.manifestHash).toBe(computeCompileManifestHash(manifest));
  expect(verifyCompileManifestHash(manifest)).toBe(true);
  expect(manifest.tools).toEqual({});
});

test("manifest hash is byte-stable for non-ASCII sop and tool names regardless of insertion order", () => {
  // Non-ASCII names: café (NFC) and naïve (NFC precomposed) — locale sort vs code-point sort differ on some platforms
  const makeManifest = (sopOrder: "ab" | "ba", toolOrder: "ab" | "ba"): CompileManifest => {
    const sops = {
      ab: {
        "forge:café": { plugin: "forge", name: "café", phases: [] },
        "forge:naïve": { plugin: "forge", name: "naïve", phases: [] },
      },
      ba: {
        "forge:naïve": { plugin: "forge", name: "naïve", phases: [] },
        "forge:café": { plugin: "forge", name: "café", phases: [] },
      },
    }[sopOrder] as CompileManifest["sops"];
    const tools = {
      ab: {
        "forge:résumé": { plugin: "forge", name: "résumé" },
        "forge:über": { plugin: "forge", name: "über" },
      },
      ba: {
        "forge:über": { plugin: "forge", name: "über" },
        "forge:résumé": { plugin: "forge", name: "résumé" },
      },
    }[toolOrder] as CompileManifest["tools"];
    const base: Omit<CompileManifest, "manifestHash"> = {
      version: 1,
      plugins: {},
      compileTargets: [],
      agents: {},
      modelspaces: {},
      skills: {},
      tools,
      sops,
    };
    const withEmpty = { ...base, manifestHash: "" };
    return { ...withEmpty, manifestHash: computeCompileManifestHash(withEmpty) };
  };

  const aa = makeManifest("ab", "ab");
  const ab = makeManifest("ab", "ba");
  const ba = makeManifest("ba", "ab");
  const bb = makeManifest("ba", "ba");

  // All insertion orders must produce the same manifest hash
  expect(aa.manifestHash).toBe(ab.manifestHash);
  expect(aa.manifestHash).toBe(ba.manifestHash);
  expect(aa.manifestHash).toBe(bb.manifestHash);

  // All must verify
  expect(verifyCompileManifestHash(aa)).toBe(true);
  expect(verifyCompileManifestHash(bb)).toBe(true);

  // Encoded output must also be identical
  expect(encodeCompileManifest(aa)).toBe(encodeCompileManifest(bb));
});

test("HarnessIdSchema admits opencode2", () => {
  expect(Schema.is(HarnessIdSchema)("opencode2")).toBe(true);
  expect(Schema.is(HarnessIdSchema)("opencode")).toBe(true);
});

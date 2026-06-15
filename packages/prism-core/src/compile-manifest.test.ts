import { expect, test } from "bun:test";
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
  verifyAgentManifestHash,
  verifyCompileManifestHash,
} from "@skastr0/prism-core/compile-manifest";

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
      traits: [
        { id: "forge:reviewable", ref: "reviewable" },
        { id: "core:committable", ref: "core:committable" },
      ],
      skills: ["forge:build", "core:git"],
      composed: {
        grants: {
          tools: ["forge:workspace/run_shell", "core:create_commit"],
          skills: ["core:git", "forge:build"],
        },
        modelBindings: { modelspace: "models", profile: "builder" },
        perTarget: {
          grok: {
            scope: "project",
            model: { model: "grok-code-fast-1", nested: { temperature: 0 } },
            toolGrants: ["forge:workspace/run_shell", "core:create_commit"],
            allowedTools: ["forge_workspace_run_shell", "core_create_commit"],
            allowedSkills: ["forge:build", "core:git"],
          },
          "claude-code": {
            scope: "global",
            model: null,
            toolGrants: ["forge:workspace/run_shell"],
            allowedTools: ["forge_workspace_run_shell"],
            allowedSkills: ["forge:build"],
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
    "forge:workspace/run_shell": { plugin: "forge", toolspace: "workspace", name: "run_shell" },
    "core:create_commit": { plugin: "core", name: "create_commit" },
    "agent-core:repo/inspect": { plugin: "agent-core", toolspace: "repo", name: "inspect" },
  },
  traits: {
    "forge:reviewable": { id: "forge:reviewable", ref: "reviewable" },
    "core:committable": { id: "core:committable", ref: "core:committable" },
  },
  orbits: {
    "forge:delivery-contract": { plugin: "forge", name: "delivery-contract" },
    "core:experiment": { plugin: "core", name: "experiment" },
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
  expect(Object.keys(decoded.right.tools).sort()).toEqual(["agent-core:repo/inspect", "core:create_commit", "forge:workspace/run_shell"]);
  expect(decoded.right.tools["forge:workspace/run_shell"]).toEqual({ plugin: "forge", toolspace: "workspace", name: "run_shell" });
  expect(decoded.right.tools["core:create_commit"]).toEqual({ plugin: "core", name: "create_commit" });
  expect(JSON.stringify(decoded.right.tools)).not.toContain("sourcePath");
  expect(JSON.stringify(decoded.right.tools)).not.toContain("input");
  expect(JSON.stringify(decoded.right.tools)).not.toContain("handle");
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
        traits: [...manifest.agents["forge:builder"]!.traits].reverse(),
        skills: [...manifest.agents["forge:builder"]!.skills].reverse(),
        composed: {
          ...manifest.agents["forge:builder"]!.composed,
          grants: {
            tools: [...manifest.agents["forge:builder"]!.composed.grants.tools].reverse(),
            skills: [...manifest.agents["forge:builder"]!.composed.grants.skills].reverse(),
          },
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
      "agent-core:repo/inspect": manifest.tools["agent-core:repo/inspect"]!,
      "forge:workspace/run_shell": manifest.tools["forge:workspace/run_shell"]!,
    },
    traits: {
      "forge:reviewable": manifest.traits["forge:reviewable"]!,
      "core:committable": manifest.traits["core:committable"]!,
    },
    orbits: {
      "core:experiment": manifest.orbits["core:experiment"]!,
      "forge:delivery-contract": manifest.orbits["forge:delivery-contract"]!,
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
        composed: { grants: { tools: [] } },
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

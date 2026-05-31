import { expect, test } from "bun:test";
import { getAllHarnessIds } from "./harnesses.js";
import {
  LOWERER_CAPABILITIES,
  LOWERER_SURFACE_IDS,
  LOWERER_SURFACE_KINDS,
} from "./lowerer-capabilities.js";
import { getCompileTargetCapabilities } from "./compile/target-capabilities.js";

const sorted = (values: readonly string[]): string[] => [...values].sort();

test("lowerer capability matrix covers every supported harness and excludes removed Gemini target", () => {
  const harnessIds = getAllHarnessIds();
  const matrixIds = Object.keys(LOWERER_CAPABILITIES);

  expect(sorted(matrixIds)).toEqual(sorted(harnessIds));
  expect(matrixIds).not.toContain("gemini-cli");

  for (const harnessId of harnessIds) {
    const profile = LOWERER_CAPABILITIES[harnessId];
    expect(profile.harness).toBe(harnessId);
    expect(sorted(Object.keys(profile.surfaces))).toEqual(sorted(LOWERER_SURFACE_IDS));
    for (const surface of Object.values(profile.surfaces)) {
      expect(LOWERER_SURFACE_KINDS).toContain(surface.kind);
      expect(surface.summary.length).toBeGreaterThan(0);
    }
  }
});

test("compile target capabilities are derived from lowerer capability profiles", () => {
  const compileSupportedHarnesses = Object.entries(LOWERER_CAPABILITIES)
    .filter(([, profile]) =>
      profile.compile.agents === "supported" ||
      profile.compile.generatedCanonicalTools === "executable" ||
      profile.compile.hooks === "supported"
    )
    .map(([harnessId]) => harnessId);

  expect(sorted(compileSupportedHarnesses)).toEqual(
    sorted([
      "opencode",
      "claude-code",
      "antigravity-cli",
      "codex-cli",
      "amp-code",
      "hermes",
      "grok",
      "factory-droid",
      "pi",
      "kimi-code",
      "cursor",
    ]),
  );

  for (const harnessId of getAllHarnessIds()) {
    expect(getCompileTargetCapabilities(harnessId)).toEqual(
      LOWERER_CAPABILITIES[harnessId].compile,
    );
  }

  expect(getCompileTargetCapabilities("gemini-cli")).toEqual({
    agents: "unsupported",
    generatedCanonicalTools: "unsupported",
    hooks: "unsupported",
    skillPermissions: "unsupported",
  });
  expect(getCompileTargetCapabilities("toString")).toEqual({
    agents: "unsupported",
    generatedCanonicalTools: "unsupported",
    hooks: "unsupported",
    skillPermissions: "unsupported",
  });
});

test("capability profiles distinguish product-native plugin surfaces from MCP and direct files", () => {
  expect(LOWERER_CAPABILITIES["antigravity-cli"].surfaces.pluginBundle.kind).toBe(
    "native-plugin-bundle",
  );
  expect(LOWERER_CAPABILITIES["factory-droid"].surfaces.pluginBundle.kind).toBe(
    "native-plugin-bundle",
  );
  expect(LOWERER_CAPABILITIES["amp-code"].surfaces.pluginBundle.kind).toBe(
    "native-plugin-api",
  );
  expect(LOWERER_CAPABILITIES["amp-code"].surfaces.generatedTools.kind).toBe(
    "native-plugin-api",
  );
  expect(LOWERER_CAPABILITIES["amp-code"].surfaces.commands.kind).toBe(
    "native-plugin-api",
  );
  expect(LOWERER_CAPABILITIES["amp-code"].surfaces.hooks.kind).toBe(
    "native-plugin-api",
  );
  expect(LOWERER_CAPABILITIES["kimi-code"].compile).toEqual({
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  });
  expect(LOWERER_CAPABILITIES["kimi-code"].surfaces.pluginBundle).toMatchObject({
    kind: "native-plugin-bundle",
    path: "<kimi-root>/plugins/managed/prism-generated-<plugin>/",
  });
  expect(LOWERER_CAPABILITIES["kimi-code"].surfaces.hooks).toMatchObject({
    kind: "config-patch",
    path: "<kimi-root>/config.toml#hooks",
  });
  expect(LOWERER_CAPABILITIES.pi.compile).toEqual({
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  });
  expect(LOWERER_CAPABILITIES.pi.surfaces.pluginBundle).toMatchObject({
    kind: "native-plugin-bundle",
    path: "<pi-root>/packages/prism-generated-<plugin>/",
  });
  expect(LOWERER_CAPABILITIES.pi.surfaces.agents).toMatchObject({
    kind: "markdown-file",
    path: "~/.pi/agents/<name>.md or .pi/agents/<name>.md",
  });
  expect(LOWERER_CAPABILITIES.pi.surfaces.skills).toMatchObject({
    kind: "native-plugin-bundle",
    path: "<generated-package>/skills/",
  });
  expect(LOWERER_CAPABILITIES.pi.surfaces.commands.kind).toBe("native-plugin-bundle");
  expect(LOWERER_CAPABILITIES.pi.surfaces.generatedTools.kind).toBe("native-plugin-api");
  expect(LOWERER_CAPABILITIES.pi.surfaces.hooks.kind).toBe("native-plugin-api");
  expect(LOWERER_CAPABILITIES.hermes.surfaces.generatedTools.kind).toBe(
    "generated-mcp",
  );
  expect(LOWERER_CAPABILITIES["codex-cli"].surfaces.agents).toMatchObject({
    kind: "direct-file",
    path: "<codex-root>/agents/<name>.toml",
  });
  expect(LOWERER_CAPABILITIES["codex-cli"].surfaces.mcpConfig.kind).toBe(
    "config-patch",
  );
  expect(LOWERER_CAPABILITIES.openclaw.surfaces.skills.kind).toBe("direct-file");
  expect(LOWERER_CAPABILITIES.cursor.compile).toEqual({
    agents: "unsupported",
    generatedCanonicalTools: "executable",
    hooks: "unsupported",
    skillPermissions: "unsupported",
  });
  expect(LOWERER_CAPABILITIES.cursor.surfaces.generatedTools.kind).toBe(
    "generated-mcp",
  );
  expect(LOWERER_CAPABILITIES.cursor.surfaces.mcpConfig).toMatchObject({
    kind: "config-patch",
    path: "<cursor-root>/mcp.json#mcpServers",
  });
});

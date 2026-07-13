import { expect, test } from "bun:test";
import { getAllHarnessIds } from "./harnesses.js";
import { LOWERER_CAPABILITIES } from "./lowerer-capabilities.js";
import {
  HARNESS_MCP_CONTRACTS,
  MCP_ESSENTIAL_FEATURES,
  getHarnessMcpContract,
  hasSubAgentToolAssignment,
  hasToolAllowlist,
  isMcpSupported,
  mcpSupportedHarnessIds,
} from "./harness-mcp-contract.js";

const sorted = (values: readonly string[]): string[] => [...values].sort();

test("contract table covers exactly the canonical harness set", () => {
  expect(sorted(Object.keys(HARNESS_MCP_CONTRACTS))).toEqual(sorted(getAllHarnessIds()));
  for (const harness of getAllHarnessIds()) {
    expect(getHarnessMcpContract(harness).harness).toBe(harness);
  }
});

test("supported contracts carry the full essential set; unsupported carry a non-empty missing list", () => {
  for (const contract of Object.values(HARNESS_MCP_CONTRACTS)) {
    if (isMcpSupported(contract)) {
      expect(contract.essential).toEqual(MCP_ESSENTIAL_FEATURES);
    } else {
      expect(contract.missingEssential.length).toBeGreaterThan(0);
      for (const missing of contract.missingEssential) {
        expect(MCP_ESSENTIAL_FEATURES).toContain(missing);
      }
    }
  }
});

test("optional feature list is exactly derived from the capability fields", () => {
  for (const contract of Object.values(HARNESS_MCP_CONTRACTS)) {
    if (!isMcpSupported(contract)) continue;
    expect(contract.optional.includes("tool allowlist")).toBe(
      contract.toolAllowlist !== "unsupported",
    );
    expect(contract.optional.includes("sub agent tool assignment")).toBe(
      contract.subAgentToolAssignment === "supported",
    );
    expect(contract.optional.includes("per invocation permissions")).toBe(
      contract.perInvocationPermissions !== "unsupported",
    );
  }
});

test("configSurface is derived from LOWERER_CAPABILITIES, never re-listed", () => {
  for (const contract of Object.values(HARNESS_MCP_CONTRACTS)) {
    if (!isMcpSupported(contract)) continue;
    expect(contract.configSurface).toBe(
      LOWERER_CAPABILITIES[contract.harness].surfaces.mcpConfig,
    );
  }
});

test("grounded facts: grok has no server-config tool allowlist but keeps sub-agent assignment", () => {
  const grok = HARNESS_MCP_CONTRACTS.grok;
  expect(grok.mcpSupport).toBe("supported");
  if (!isMcpSupported(grok)) throw new Error("unreachable");
  expect(grok.toolAllowlist).toBe("unsupported"); // verified live
  expect(grok.subAgentToolAssignment).toBe("supported");
  expect(grok.mcpServersShape).toBe("single-global-config");
  expect(hasToolAllowlist(grok)).toBe(false);
  expect(hasSubAgentToolAssignment(grok)).toBe(true);
});

test("grounded facts: kimi and factory-droid attach servers per-plugin manifest/dir only", () => {
  const kimi = HARNESS_MCP_CONTRACTS["kimi-code"];
  const droid = HARNESS_MCP_CONTRACTS["factory-droid"];
  if (!isMcpSupported(kimi) || !isMcpSupported(droid)) throw new Error("unreachable");
  expect(kimi.mcpServersShape).toBe("per-plugin-manifest");
  expect(kimi.toolAllowlist).toBe("within-server");
  expect(droid.mcpServersShape).toBe("per-plugin-manifest");
  expect(droid.toolAllowlist).toBe("global-prefixed");
});

test("grounded facts: opencode has the fullest surface", () => {
  const opencode = HARNESS_MCP_CONTRACTS.opencode;
  if (!isMcpSupported(opencode)) throw new Error("unreachable");
  expect(opencode.toolAllowlist).not.toBe("unsupported");
  expect(opencode.subAgentToolAssignment).toBe("supported");
  expect(opencode.perInvocationPermissions).toBe("supported");
  expect(opencode.optional.length).toBe(3);
});
test("grounded facts: OMP supports MCP without permission-only assignment", () => {
  const omp = HARNESS_MCP_CONTRACTS.omp;
  if (!isMcpSupported(omp)) throw new Error("unreachable");
  expect(omp.mcpServersShape).toBe("single-global-config");
  expect(omp.toolAllowlist).toBe("unsupported");
  expect(omp.subAgentToolAssignment).toBe("unsupported");
  expect(omp.perInvocationPermissions).toBe("unsupported");
});

test("grounded facts: allowlist shapes for hermes, codex, claude", () => {
  const hermes = HARNESS_MCP_CONTRACTS.hermes;
  const codex = HARNESS_MCP_CONTRACTS["codex-cli"];
  const claude = HARNESS_MCP_CONTRACTS["claude-code"];
  if (!isMcpSupported(hermes) || !isMcpSupported(codex) || !isMcpSupported(claude)) {
    throw new Error("unreachable");
  }
  expect(hermes.toolAllowlist).toBe("within-server"); // tools.include
  expect(codex.toolAllowlist).toBe("within-server"); // enabled_tools
  expect(codex.perInvocationPermissions).toBe("config-scoped"); // approval_policy
  expect(claude.toolAllowlist).toBe("global-prefixed"); // mcp__<server>__<tool>
  expect(claude.mcpServersShape).toBe("plugin-bundle-file");
});

test("unsupported arm: openclaw, pi, and devin are marked unsupported, not emulated", () => {
  expect(HARNESS_MCP_CONTRACTS.openclaw.mcpSupport).toBe("unsupported");
  expect(HARNESS_MCP_CONTRACTS.pi.mcpSupport).toBe("unsupported");
  expect(HARNESS_MCP_CONTRACTS.devin.mcpSupport).toBe("unsupported");
  expect(sorted(mcpSupportedHarnessIds())).toEqual(
    sorted(
      getAllHarnessIds().filter(
        (id) => id !== "openclaw" && id !== "pi" && id !== "devin",
      ),
    ),
  );
});

test("narrowing helpers reject the unsupported arm", () => {
  const openclaw = HARNESS_MCP_CONTRACTS.openclaw;
  expect(isMcpSupported(openclaw)).toBe(false);
  expect(hasToolAllowlist(openclaw)).toBe(false);
  expect(hasSubAgentToolAssignment(openclaw)).toBe(false);
});

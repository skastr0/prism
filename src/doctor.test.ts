import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorExitCode, pluginIsServable, runDoctor } from "./doctor.js";
import { EXIT_CODES } from "./exit.js";
import { computeContentHash, computeMcpHttpConfigContentHash } from "./content-hash.js";
import { commitSnapshot, snapshotPath } from "./state/store.js";
import { createCanonicalCompileFixture } from "./compile/test-fixtures.js";
import { prismMcpServerPath } from "./compile/mcp-runtime-path.js";
import { pluginServerKey, shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import { pluginDaemonLogPath } from "@skastr0/prism-sdk/mcp/daemon-resolver";
import { registerDaemon } from "@skastr0/prism-sdk/mcp/uds-registry";
import type { RegistryEntry, RegistryResult } from "@skastr0/prism-sdk/mcp/uds-registry";

let root: string;
let originalHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prism-doctor-"));
  originalHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(root, { recursive: true, force: true });
});

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

test("doctor reports invalid Codex TOML", async () => {
  const configPath = join(process.env.HOME!, ".codex", "config.toml");
  await writeText(configPath, `[mcp_servers.demo]\nurl = "http://127.0.0.1:38463/mcp"\n=\n`);

  const report = await runDoctor({
    harnesses: ["codex-cli"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: false,
  });

  expect(report.schema).toBe("prism.doctor.report.v1");
  expect(report.findings.map((finding) => finding.code)).toContain("config.toml.invalid");
  expect(doctorExitCode(report)).toBe(EXIT_CODES.domainFailure);
});

test("doctor exit code is success for a clean report", async () => {
  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: false,
  });

  expect(report.findings).toEqual([]);
  expect(doctorExitCode(report)).toBe(EXIT_CODES.success);
});

test("doctor includes shared workflow harness detection data without creating findings", async () => {
  const report = await runDoctor({
    harnesses: ["opencode", "cursor"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: false,
  });

  expect(report.findings).toEqual([]);
  expect(report.workflowHarnesses?.map((item) => item.harness)).toEqual(["opencode"]);
  expect(report.workflowHarnesses?.[0]?.schema).toBe("prism.workflow-harness-detection.v1");
});

test("doctor --fix returns environment failure when convergence remains blocked", async () => {
  const pluginRoot = join(root, "blocked-plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "blocked-plugin",
      version: "0.1.0",
      targets: { commands: ["opencode"] },
    }, null, 2)}\n`,
  );
  await writeText(join(pluginRoot, "commands", "review.md"), "managed\n");
  await writeText(
    join(process.env.HOME!, ".config", "opencode", "commands", "review.md"),
    "foreign\n",
  );

  const report = await runDoctor({
    pluginPath: pluginRoot,
    harnesses: ["opencode"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: true,
  });

  expect(report.findings.map((finding) => finding.code)).toContain("sync.blocked");
  expect(doctorExitCode(report)).toBe(EXIT_CODES.environment);
});

test("doctor --fix exits success after converging direct refresh outputs", async () => {
  const pluginRoot = join(root, "direct-plugin");
  const commandPath = join(process.env.HOME!, ".config", "opencode", "commands", "review.md");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "direct-plugin",
      version: "0.1.0",
      targets: { commands: ["opencode"] },
    }, null, 2)}\n`,
  );
  await writeText(join(pluginRoot, "commands", "review.md"), "managed\n");

  const report = await runDoctor({
    pluginPath: pluginRoot,
    harnesses: ["opencode"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: true,
  });

  expect(await Bun.file(commandPath).exists()).toBe(true);
  expect(report.findings).toEqual([]);
  expect(doctorExitCode(report)).toBe(EXIT_CODES.success);
});

test("doctor --fix compiles targeted plugin outputs before refresh inspection", async () => {
  const pluginRoot = join(root, "compile-plugin");
  const projectRoot = join(root, "project-root");
  await createCanonicalCompileFixture({
    pluginRoot,
    projectRoot,
    withCanonicalToolBindings: false,
  });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "canonical-compile-fixture",
      version: "0.1.0",
      deps: {
        "agent-core": "./deps/agent-core",
        "protocol-core": "./deps/protocol-core",
      },
      targets: {
        agents: ["opencode"],
        orbits: ["opencode"],
        toolspaces: ["opencode"],
        modelspaces: ["opencode"],
      },
    }, null, 2)}\n`,
  );

  const report = await runDoctor({
    pluginPath: pluginRoot,
    harnesses: ["opencode"],
    scope: "global",
    prismHome: join(root, "prism-home"),
    fix: true,
  });

  expect(
    await Bun.file(join(process.env.HOME!, ".config", "opencode", "agents", "builder.md")).exists(),
  ).toBe(true);
  expect(report.findings).toEqual([]);
  expect(doctorExitCode(report)).toBe(EXIT_CODES.success);
});

test("doctor reports snapshot drift region integrity and namespace strays", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".config", "opencode");
  const ownedPath = join(harnessRoot, "agents", "reviewer.md");
  const configPath = join(harnessRoot, "AGENTS.md");
  const marker =
    "<!-- --- prism:demo.region begin --- -->\nmanaged\n<!-- --- prism:demo.region end --- -->";
  await writeText(ownedPath, "drifted\n");
  await writeText(configPath, `${marker}\n\n${marker}\n`);
  await writeText(join(harnessRoot, "plugins", "prism-generated-stray", "dist", "server.mjs"), "x\n");

  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "opencode",
      root: harnessRoot,
      entries: [
        {
          targetPath: ownedPath,
          contentHash: computeContentHash("managed\n"),
          mode: "owned",
          plugin: "demo",
        },
        {
          targetPath: configPath,
          contentHash: computeContentHash(marker),
          mode: "region",
          regionKey: 'marker-v2 {"prefix":"<!--","suffix":" -->","key":"demo.region"}',
          plugin: "demo",
        },
      ],
    },
  });

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const codes = report.findings.map((finding) => finding.code);
  expect(codes).toContain("snapshot.owned-drift");
  expect(codes).toContain("region.marker-count");
  expect(codes).toContain("namespace.unowned-prism-path");
});

test("doctor does not flag Kimi Code's own plugin.json/prism.lock as strays, but still flags a real unowned file", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".kimi-code");
  const pluginDir = join(harnessRoot, "plugins", "managed", "prism-generated-tower");

  // Kimi Code's own plugin manager writes these two as install-time side
  // effects; Prism never writes them, so they must not show up as strays.
  await writeText(join(pluginDir, "plugin.json"), "kimi.plugin.json\n");
  await writeText(join(pluginDir, "prism.lock"), "{}\n");
  // A genuinely unowned file in the same directory must still be flagged --
  // the allowance is scoped to the two known Kimi-manager basenames only.
  await writeText(join(pluginDir, "unexpected.txt"), "stray\n");

  const report = await runDoctor({
    harnesses: ["kimi-code"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const strayPaths = report.findings
    .filter((finding) => finding.code === "namespace.unowned-prism-path")
    .map((finding) => finding.path);
  expect(strayPaths).not.toContain(join(pluginDir, "plugin.json"));
  expect(strayPaths).not.toContain(join(pluginDir, "prism.lock"));
  expect(strayPaths).toContain(join(pluginDir, "unexpected.txt"));
});

test("doctor does not flag a grok .mcp.json port change as drift, but still flags a real content change (PQ-167)", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".grok");
  const mcpPath = join(harnessRoot, "plugins", "prism-generated-demo", ".mcp.json");

  const renderMcpConfig = (port: number, extraServers?: Record<string, unknown>): string =>
    JSON.stringify({
      mcpServers: {
        p_f3119df0: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-demo:grok" },
        },
        ...extraServers,
      },
    }, null, 2) + "\n";

  // The snapshot was recorded against one port; the daemon has since rebound
  // to a different one and the on-disk file reflects only that.
  await writeText(mcpPath, renderMcpConfig(61742));
  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "grok",
      root: harnessRoot,
      entries: [
        {
          targetPath: mcpPath,
          contentHash: computeMcpHttpConfigContentHash(renderMcpConfig(50953)),
          mode: "owned",
          plugin: "demo",
        },
      ],
    },
  });

  const portOnlyReport = await runDoctor({
    harnesses: ["grok"],
    scope: "global",
    prismHome,
    fix: false,
  });
  expect(portOnlyReport.findings.map((finding) => finding.code)).not.toContain("snapshot.owned-drift");

  // A genuine content change (a new server entry) must still be caught.
  await writeText(
    mcpPath,
    renderMcpConfig(61742, {
      p_other: { type: "http", url: "http://127.0.0.1:9999/mcp" },
    }),
  );
  const realDriftReport = await runDoctor({
    harnesses: ["grok"],
    scope: "global",
    prismHome,
    fix: false,
  });
  expect(realDriftReport.findings.map((finding) => finding.code)).toContain("snapshot.owned-drift");
});

test("doctor accepts a legacy raw-hash grok snapshot (pre-PQ-167) as clean when byte-identical, and still flags a real change", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".grok");
  const mcpPath = join(harnessRoot, "plugins", "prism-generated-demo", ".mcp.json");

  const renderMcpConfig = (port: number, extraServers?: Record<string, unknown>): string =>
    JSON.stringify({
      mcpServers: {
        p_f3119df0: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { "X-Prism-Mcp-Exposure": "prism-generated-demo:grok" },
        },
        ...extraServers,
      },
    }, null, 2) + "\n";

  // Simulate a snapshot committed by pre-fix Prism: it stored the plain
  // (unnormalized) content hash, not the normalized one.
  const content = renderMcpConfig(61742);
  await writeText(mcpPath, content);
  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "grok",
      root: harnessRoot,
      entries: [
        {
          targetPath: mcpPath,
          contentHash: computeContentHash(content),
          mode: "owned",
          plugin: "demo",
        },
      ],
    },
  });

  const byteIdenticalReport = await runDoctor({
    harnesses: ["grok"],
    scope: "global",
    prismHome,
    fix: false,
  });
  expect(byteIdenticalReport.findings.map((finding) => finding.code)).not.toContain("snapshot.owned-drift");

  // A genuine content change against that same legacy raw-hash snapshot must
  // still be caught.
  await writeText(
    mcpPath,
    renderMcpConfig(61742, {
      p_other: { type: "http", url: "http://127.0.0.1:9999/mcp" },
    }),
  );
  const realDriftReport = await runDoctor({
    harnesses: ["grok"],
    scope: "global",
    prismHome,
    fix: false,
  });
  expect(realDriftReport.findings.map((finding) => finding.code)).toContain("snapshot.owned-drift");
});

test("doctor --fix drops snapshots for dead roots", async () => {
  const prismHome = join(root, "prism-home");
  const deadRoot = join(root, "dead-opencode-root");
  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "opencode",
      root: deadRoot,
      entries: [],
    },
  });

  const path = snapshotPath(prismHome, deadRoot);
  expect(await Bun.file(path).exists()).toBe(true);

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: true,
  });

  expect(report.findings.map((finding) => finding.code)).toContain("snapshot.dead-root-dropped");
  expect(await Bun.file(path).exists()).toBe(false);
});

test("doctor --fix drops stale snapshot entries for missing owned files", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".config", "opencode");
  const missingPath = join(harnessRoot, "agents", "removed.md");
  const livePath = join(harnessRoot, "agents", "live.md");
  await writeText(livePath, "live\n");
  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "opencode",
      root: harnessRoot,
      entries: [
        {
          targetPath: missingPath,
          contentHash: computeContentHash("removed\n"),
          mode: "owned",
          plugin: "removed-plugin",
        },
        {
          targetPath: livePath,
          contentHash: computeContentHash("live\n"),
          mode: "owned",
          plugin: "live-plugin",
        },
      ],
    },
  });

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: true,
  });

  expect(report.findings.map((finding) => finding.code)).toContain("snapshot.stale-entry-dropped");
  const read = await import("./state/store.js").then((m) => m.readSnapshot({ prismHome, harness: "opencode", root: harnessRoot }));
  expect(read.manifest.entries.map((entry) => entry.targetPath)).toEqual([livePath]);
});

test("doctor --fix drops stale snapshot region entries for missing marker fences", async () => {
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(process.env.HOME!, ".codex");
  const configPath = join(harnessRoot, "config.toml");
  const marker =
    "# --- prism:removed.hooks begin ---\nmanaged\n# --- prism:removed.hooks end ---";
  await writeText(configPath, "[features]\n");
  await commitSnapshot({
    prismHome,
    manifest: {
      version: 1,
      harness: "codex-cli",
      root: harnessRoot,
      entries: [
        {
          targetPath: configPath,
          contentHash: computeContentHash(marker),
          mode: "region",
          regionKey: "marker # removed.hooks",
          plugin: "removed-plugin",
        },
      ],
    },
  });

  const report = await runDoctor({
    harnesses: ["codex-cli"],
    scope: "global",
    prismHome,
    fix: true,
  });

  expect(report.findings.map((finding) => finding.code)).toContain("snapshot.stale-entry-dropped");
  const read = await import("./state/store.js").then((m) => m.readSnapshot({ prismHome, harness: "codex-cli", root: harnessRoot }));
  expect(read.manifest.entries).toEqual([]);
});

test("doctor validates generated harness config references", async () => {
  const prismHome = join(root, "prism-home");
  const codexServerName = shimServerKey("codex-cli");
  // Claude Code's per-plugin server is keyed by the owner plugin's own name
  // (`pluginServerKey`), not the retired shared `shimServerKey("claude-code")`.
  const claudeServerName = pluginServerKey("demo");
  // Codex: a legacy remnant (old HTTP-era `command`/`args`, no PRISM_SHIM_*
  // env, non-array enabled_tools) under the *correct* stdio-shim server key
  // -- every stdio-shim shape check should fire.
  await writeText(
    join(process.env.HOME!, ".codex", "config.toml"),
    [
      `["mcp_servers"."${codexServerName}"]`,
      'command = "bun"',
      'args = ["/missing/prism/server.mjs"]',
      'enabled_tools = "not-an-array"',
      "",
    ].join("\n"),
  );
  await writeText(
    join(process.env.HOME!, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ plugin: ["file:///missing/prism-generated-demo"] }, null, 2)}\n`,
  );
  // Claude: a well-formed shim command/args/env, but referencing an owner
  // plugin ("demo") with no compiled MCP bundle on disk, plus an allowlist
  // entry that isn't wire-naming shaped.
  await writeText(
    join(process.env.HOME!, ".claude", "skills", "prism-generated-demo", ".mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        [claudeServerName]: {
          command: "prism",
          args: ["mcp", "shim"],
          env: {
            PRISM_SHIM_PLUGINS: "demo",
            PRISM_SHIM_HARNESS: "claude-code",
          },
        },
      },
    }, null, 2)}\n`,
  );
  await writeText(
    join(process.env.HOME!, ".claude", "skills", "prism-generated-demo", "hooks", "hooks.json"),
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/missing.mjs"' }] }] } }, null, 2)}\n`,
  );
  // Grok: a broken shim entry under an owner-plugin server key in
  // config.toml (grok's only resolvable MCP registration surface) — wrong
  // command/args, env harness naming another harness, no PRISM_SHIM_PLUGINS.
  const grokServerName = pluginServerKey("demo");
  await writeText(
    join(process.env.HOME!, ".grok", "config.toml"),
    [
      `["mcp_servers"."${grokServerName}"]`,
      'command = "bun"',
      'args = ["/missing/prism/server.mjs"]',
      `["mcp_servers"."${grokServerName}"."env"]`,
      'PRISM_SHIM_HARNESS = "cursor"',
      "",
    ].join("\n"),
  );

  const report = await runDoctor({
    harnesses: ["codex-cli", "opencode", "claude-code", "grok"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const codesFor = (harness: string): string[] =>
    report.findings.filter((f) => f.harness === harness).map((f) => f.code);
  const codexCodes = codesFor("codex-cli");
  expect(codexCodes).toContain("config.codex-enabled-tools-invalid");
  expect(codexCodes).toContain("config.mcp-shim-command-unresolvable");
  expect(codexCodes).toContain("config.mcp-shim-args-invalid");
  expect(codexCodes).toContain("config.mcp-shim-env-harness-mismatch");
  expect(codexCodes).toContain("config.mcp-shim-env-plugins-missing");
  // Surviving under the legacy aggregated key at all is itself a migration
  // artifact now that codex renders one server per owner plugin.
  expect(codexCodes).toContain("config.mcp-shim-legacy-aggregated-entry");

  const grokCodes = codesFor("grok");
  expect(grokCodes).toContain("config.mcp-shim-command-unresolvable");
  expect(grokCodes).toContain("config.mcp-shim-args-invalid");
  expect(grokCodes).toContain("config.mcp-shim-env-harness-mismatch");
  expect(grokCodes).toContain("config.mcp-shim-env-plugins-missing");

  const claudeCodes = codesFor("claude-code");
  expect(claudeCodes).toContain("config.mcp-shim-plugin-bundle-missing");
  expect(claudeCodes).toContain("config.claude-hook-command-missing");
  // The well-formed command/args/env on the Claude entry must NOT trip the
  // shape checks that only the (deliberately broken) Codex entry violates.
  expect(claudeCodes).not.toContain("config.mcp-shim-command-unresolvable");
  expect(claudeCodes).not.toContain("config.mcp-shim-args-invalid");
  expect(claudeCodes).not.toContain("config.mcp-shim-env-harness-mismatch");

  const codes = report.findings.map((finding) => finding.code);
  expect(codes).toContain("config.opencode-plugin-missing");
});

test("a real refresh sweeps the retired aggregated shim key, and the legacy-aggregated-entry advisory finds nothing afterward", async () => {
  const prismHome = join(root, "prism-home");
  const configPath = join(process.env.HOME!, ".codex", "config.toml");
  await writeText(prismMcpServerPath(prismHome, "booth"), "search\n");

  // The exact live shape this advisory was written to catch: the retired
  // union-owner's fenced entry, keyed by the reserved `prism-mcp-shim`
  // sentinel — codex/hermes/cursor's aggregated scheme, retired in favor of
  // one region per owner plugin (see src/sync/legacy-prism-entries.ts).
  const legacyFence = [
    "# --- prism:codex.mcp.prism-mcp-shim begin ---",
    '["mcp_servers"."prism-mcp-shim"]',
    'command = "prism"',
    'args = ["mcp", "shim"]',
    "enabled = true",
    "required = false",
    'default_tools_approval_mode = "approve"',
    'enabled_tools = ["booth__context_get"]',
    '["mcp_servers"."prism-mcp-shim"."env"]',
    'PRISM_SHIM_PLUGINS = "booth"',
    'PRISM_SHIM_HARNESS = "codex-cli"',
    "# --- prism:codex.mcp.prism-mcp-shim end ---",
  ].join("\n");
  await writeText(configPath, `${legacyFence}\n`);

  // A real refresh: the sync engine's own entry point (`syncDesiredRoot`,
  // what `refreshPlugin` calls per harness root), scoped to the live
  // plugin "booth" the way `refresh.ts` always scopes a real compile —
  // never to the retired sentinel — proving the sweep does not depend on
  // scope to reach the legacy entry.
  const { syncDesiredRoot } = await import("./sync/run.js");
  const codexServerName = pluginServerKey("booth");
  await syncDesiredRoot({
    prismHome,
    dryRun: false,
    scopePlugins: new Set(["booth"]),
    desired: {
      harness: "codex-cli",
      root: join(process.env.HOME!, ".codex"),
      files: [],
      regions: [{
        kind: "marker",
        targetPath: configPath,
        regionKey: `codex.mcp.${codexServerName}`,
        commentPrefix: "#",
        content: [
          `["mcp_servers"."${codexServerName}"]`,
          'command = "prism"',
          'args = ["mcp", "shim"]',
          "enabled = true",
          'enabled_tools = ["context_get"]',
          `["mcp_servers"."${codexServerName}"."env"]`,
          'PRISM_SHIM_PLUGINS = "booth"',
          'PRISM_SHIM_HARNESS = "codex-cli"',
          'PRISM_SHIM_NAMING = "per-plugin"',
        ].join("\n"),
        plugin: "booth",
      }],
    },
  });

  const afterRefresh = await Bun.file(configPath).text();
  expect(afterRefresh).not.toContain("prism-mcp-shim");
  expect(afterRefresh).toContain(`prism:codex.mcp.${codexServerName}`);

  const report = await runDoctor({
    harnesses: ["codex-cli"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const codexCodes = report.findings.filter((f) => f.harness === "codex-cli").map((f) => f.code);
  expect(codexCodes).not.toContain("config.mcp-shim-legacy-aggregated-entry");
  // The surviving per-plugin entry is well-formed — no other shim finding.
  expect(codexCodes.filter((code) => code.startsWith("config.mcp-shim"))).toEqual([]);
});

test("doctor reports zero findings for a correctly-generated stdio-shim MCP config (claude-code, codex-cli, hermes, grok)", async () => {
  const prismHome = join(root, "prism-home");
  await writeText(prismMcpServerPath(prismHome, "demo"), "search\n");

  const claudeServerName = pluginServerKey("demo");
  await writeText(
    join(process.env.HOME!, ".claude", "skills", "prism-generated-demo", ".mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        [claudeServerName]: {
          command: "prism",
          args: ["mcp", "shim"],
          env: { PRISM_SHIM_PLUGINS: "demo", PRISM_SHIM_HARNESS: "claude-code", PRISM_SHIM_NAMING: "per-plugin" },
        },
      },
    }, null, 2)}\n`,
  );

  const codexServerName = pluginServerKey("demo");
  await writeText(
    join(process.env.HOME!, ".codex", "config.toml"),
    [
      `["mcp_servers"."${codexServerName}"]`,
      'command = "prism"',
      'args = ["mcp", "shim"]',
      "enabled = true",
      "required = false",
      `enabled_tools = ["search"]`,
      `["mcp_servers"."${codexServerName}"."env"]`,
      'PRISM_SHIM_PLUGINS = "demo"',
      'PRISM_SHIM_HARNESS = "codex-cli"',
      'PRISM_SHIM_NAMING = "per-plugin"',
      "",
    ].join("\n"),
  );

  const grokShimServer = pluginServerKey("demo");
  await writeText(
    join(process.env.HOME!, ".grok", "config.toml"),
    [
      `# --- prism:grok.mcp.${grokShimServer} begin ---`,
      `["mcp_servers"."${grokShimServer}"]`,
      'command = "prism"',
      'args = ["mcp", "shim"]',
      "enabled = true",
      `["mcp_servers"."${grokShimServer}"."env"]`,
      'PRISM_SHIM_PLUGINS = "demo"',
      'PRISM_SHIM_HARNESS = "grok"',
      'PRISM_SHIM_NAMING = "per-plugin"',
      `# --- prism:grok.mcp.${grokShimServer} end ---`,
      "",
    ].join("\n"),
  );

  const hermesServerName = pluginServerKey("demo");
  await writeText(
    join(process.env.HOME!, ".hermes", "config.yaml"),
    [
      "mcp_servers:",
      `# --- prism:hermes.mcp.${hermesServerName} begin ---`,
      `  ${hermesServerName}:`,
      "    command: prism",
      "    args:",
      "      - mcp",
      "      - shim",
      "    enabled: true",
      "    env:",
      "      PRISM_SHIM_PLUGINS: demo",
      "      PRISM_SHIM_HARNESS: hermes",
      "      PRISM_SHIM_NAMING: per-plugin",
      "    tools:",
      "      include:",
      "        - search",
      `# --- prism:hermes.mcp.${hermesServerName} end ---`,
      "",
    ].join("\n"),
  );

  const report = await runDoctor({
    harnesses: ["claude-code", "codex-cli", "hermes", "grok"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const mcpShimFindings = report.findings.filter((f) => f.code.startsWith("config.mcp-shim-"));
  expect(mcpShimFindings).toEqual([]);
});

test("doctor accepts an OpenCode plugin entry that already targets the bundle file (PQ-167)", async () => {
  const prismHome = join(root, "prism-home");
  const bundlePath = join(root, "plugins", "prism-generated-quasar", "dist", "server.mjs");
  await writeText(bundlePath, "export {};\n");
  await writeText(
    join(process.env.HOME!, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ plugin: [`file://${bundlePath}`] }, null, 2)}\n`,
  );

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const codes = report.findings.map((finding) => finding.code);
  expect(codes).not.toContain("config.opencode-plugin-missing");
  expect(codes).not.toContain("config.opencode-plugin-bundle-missing");
});

test("doctor reports a single correct path when a file-form OpenCode bundle is actually missing (PQ-167)", async () => {
  const prismHome = join(root, "prism-home");
  const bundlePath = join(root, "plugins", "prism-generated-quasar", "dist", "server.mjs");
  // Note: bundlePath is intentionally never written to disk.
  await writeText(
    join(process.env.HOME!, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ plugin: [`file://${bundlePath}`] }, null, 2)}\n`,
  );

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const findings = report.findings.filter((finding) => finding.code.startsWith("config.opencode-plugin"));
  expect(findings).toHaveLength(1);
  const message = findings[0]?.message ?? "";
  // Must reference the bundle path exactly once, never doubled into
  // ".../dist/server.mjs/dist/server.mjs".
  expect(message.split(bundlePath)).toHaveLength(2);
  expect(message).not.toContain("dist/server.mjs/dist/server.mjs");
});

test("doctor still resolves legacy directory-form OpenCode plugin entries (PQ-167)", async () => {
  const prismHome = join(root, "prism-home");
  const pluginRoot = join(root, "plugins", "prism-generated-quasar");
  await mkdir(pluginRoot, { recursive: true });
  // Directory exists, but its dist/server.mjs bundle does not.
  await writeText(
    join(process.env.HOME!, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ plugin: [`file://${pluginRoot}`] }, null, 2)}\n`,
  );

  const report = await runDoctor({
    harnesses: ["opencode"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const findings = report.findings.filter((finding) => finding.code.startsWith("config.opencode-plugin"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("config.opencode-plugin-bundle-missing");
  const expectedServerPath = join(pluginRoot, "dist", "server.mjs");
  expect(findings[0]?.message).toContain(expectedServerPath);
});

test("doctor warns when Codex hooks.json contains Prism-managed hooks", async () => {
  const prismHome = join(root, "prism-home");
  await writeText(
    join(process.env.HOME!, ".codex", "hooks.json"),
    `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "node '/Users/someone/.codex/hooks/prism-generated-demo-session-start.mjs'" },
              { type: "command", command: "bash '/Users/someone/.codex/herdr-agent-state.sh' session" },
            ],
          },
        ],
      },
    }, null, 2)}\n`,
  );

  const report = await runDoctor({
    harnesses: ["codex-cli"],
    scope: "global",
    prismHome,
    fix: false,
  });

  const splitFinding = report.findings.find((finding) => finding.code === "config.codex-hooks-json-split");
  expect(splitFinding).toBeDefined();
  expect(splitFinding?.severity).toBe("warning");
  expect(splitFinding?.data).toBeDefined();
  const prismCommands = splitFinding?.data?.prismCommands as unknown[];
  expect(Array.isArray(prismCommands)).toBe(true);
  expect(prismCommands).toHaveLength(1);
  expect(String(prismCommands[0])).toContain("prism-generated-demo");
});

// ---------------------------------------------------------------------------
// pluginIsServable -- the true precondition config.mcp-shim-plugin-bundle-missing
// validates (see doctor.ts's grounding comment on the function itself). The
// UDS registry lookup (`getDaemon`) resolves via `node:os`'s `homedir()`,
// which Bun freezes at process start and never re-reads from this file's
// per-test `process.env.HOME` override -- so these deliberately inject fakes
// for the daemon-registry branch rather than exercising the real
// `@skastr0/prism-sdk` functions, which would silently touch the actual
// invoking machine's real `~/.prism/runtime/mcp` state.
// ---------------------------------------------------------------------------

const absentDaemon = async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "absent" });

test("pluginIsServable: a compiled bundle at rest is servable -- lazy first-spawn, never even consults the registry", async () => {
  const prismHome = join(root, "prism-home");
  await writeText(prismMcpServerPath(prismHome, "demo"), "search\n");

  const servable = await pluginIsServable(prismHome, "demo", {
    getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => {
      throw new Error("must not consult the daemon registry when the bundle exists on disk");
    },
  });
  expect(servable).toBe(true);
});

test("pluginIsServable: no bundle and no registered daemon is genuinely unservable", async () => {
  const prismHome = join(root, "prism-home");
  const servable = await pluginIsServable(prismHome, "never-compiled", { getDaemon: absentDaemon });
  expect(servable).toBe(false);
});

test("pluginIsServable: no bundle but a live registered daemon is servable -- already running, nothing to spawn", async () => {
  const prismHome = join(root, "prism-home");
  const entry: RegistryEntry = { pid: 4242, sock: "/tmp/prism-doctor-test.sock", bundleHash: "deadbeef", startedAt: 0, lastUsed: 0 };
  const servable = await pluginIsServable(prismHome, "demo", {
    getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "ok", value: entry }),
    probeSocketLiveness: async () => "live",
  });
  expect(servable).toBe(true);
});

test("pluginIsServable: no bundle and a registered-but-dead daemon is genuinely unservable", async () => {
  const prismHome = join(root, "prism-home");
  const entry: RegistryEntry = { pid: 4242, sock: "/tmp/prism-doctor-test.sock", bundleHash: "deadbeef", startedAt: 0, lastUsed: 0 };
  const servable = await pluginIsServable(prismHome, "demo", {
    getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "ok", value: entry }),
    probeSocketLiveness: async () => "stale",
  });
  expect(servable).toBe(false);
});

test("doctor's mcp.health finding for an unhealthy daemon points at the daemon's log file (OBS-001)", async () => {
  const pluginRoot = join(root, "mcp-health-plugin");
  // Short, dedicated prismHome (not the shared root-nested convention used
  // elsewhere in this file): this is the one doctor test that reaches the
  // real `pluginDaemonLogPath` -> `udsPathFor`, which asserts a 100-byte
  // sun_path budget (see daemon-resolver.test.ts) that the shared `root`'s
  // long mkdtemp prefix plus "/prism-home" would blow before the plugin
  // name is even counted.
  const prismHome = await mkdtemp(join(tmpdir(), "ph"));
  const pluginName = "m";

  try {
    await writeText(
      join(pluginRoot, "plugin.json"),
      `${JSON.stringify({
        name: pluginName,
        version: "0.1.0",
        targets: { tools: ["hermes"] },
      }, null, 2)}\n`,
    );

    // A registered daemon whose socket is never bound classifies as
    // "stale-pid" (lifecycle.ts's classifyStatus) -- the cheapest way to
    // force a non-running/non-stopped finding without compiling a real
    // bundle.
    await registerDaemon(
      pluginName,
      { pid: 999999, sock: join(prismHome, "never-bound.sock"), bundleHash: "deadbeef", startedAt: 0, lastUsed: 0 },
      prismHome,
    );

    const report = await runDoctor({
      pluginPath: pluginRoot,
      harnesses: ["hermes"],
      scope: "global",
      prismHome,
      fix: false,
    });

    const mcpHealthFindings = report.findings.filter((f) => f.family === "mcp.health");
    expect(mcpHealthFindings).toHaveLength(1);
    expect(mcpHealthFindings[0]?.code).toBe("mcp.stale-pid");
    expect(mcpHealthFindings[0]?.data?.logPath).toBe(pluginDaemonLogPath(pluginName, prismHome));
  } finally {
    await rm(prismHome, { recursive: true, force: true }).catch(() => undefined);
  }
});

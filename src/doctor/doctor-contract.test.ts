import { expect, test } from "bun:test";
import { join } from "node:path";
import { runDoctorOnWorld, withDoctorWorld, type DoctorWorld } from "./test-fixtures.js";
import { FINDING_CATALOG } from "./finding-catalog.js";
import { readSnapshot } from "../state/store.js";
import type { HarnessId } from "../types.js";

const codesOf = (report: { readonly findings: ReadonlyArray<{ readonly code: string }> }): string[] =>
  report.findings.map((finding) => finding.code);

interface ContractCase {
  readonly code: string;
  readonly description: string;
  readonly harnesses: readonly HarnessId[];
  readonly trigger: (world: DoctorWorld) => Promise<void>;
  readonly clean: (world: DoctorWorld) => Promise<void>;
  /** Run the positive assertion with `--fix` enabled (for gc-only info codes). */
  readonly positiveUsesFix?: boolean;
  /** Whether `doctor --fix` is expected to clear the finding on a follow-up run. */
  readonly expectFixCleared: boolean;
  readonly verifyFix?: (world: DoctorWorld) => Promise<void>;
}

const CONTRACT_CASES: ContractCase[] = [
  {
    code: "config.toml.invalid",
    description: "invalid Codex TOML config",
    harnesses: ["codex-cli"],
    trigger: async (world) => {
      await world.withCodexToml("[features]\n=\n");
    },
    clean: async () => {
      // no Codex config file means no finding
    },
    expectFixCleared: false,
  },
  {
    code: "namespace.unowned-prism-path",
    description: "unowned prism-generated path under OpenCode",
    harnesses: ["opencode"],
    trigger: async (world) => {
      await world.writeText(
        join(world.rootFor("opencode"), "plugins", "prism-generated-stray", "dist", "server.mjs"),
        "stray\n",
      );
    },
    clean: async () => {
      // no prism-looking paths means no finding
    },
    expectFixCleared: false,
  },
  {
    code: "snapshot.dead-root-dropped",
    description: "snapshot for a deleted root is dropped by --fix",
    harnesses: ["opencode"],
    positiveUsesFix: true,
    trigger: async (world) => {
      const deadRoot = join(world.sandbox.root, "dead-opencode-root");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root: deadRoot,
        entries: [],
      });
    },
    clean: async () => {
      // no snapshot means no dead-root finding
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const deadRoot = join(world.sandbox.root, "dead-opencode-root");
      const read = await readSnapshot({
        prismHome: world.sandbox.prismHome,
        harness: "opencode",
        root: deadRoot,
      });
      expect(read.manifest.entries).toEqual([]);
    },
  },
  {
    code: "snapshot.stale-entry-dropped",
    description: "stale owned entry is dropped by --fix",
    harnesses: ["opencode"],
    positiveUsesFix: true,
    trigger: async (world) => {
      const root = world.rootFor("opencode");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root,
        entries: [
          {
            targetPath: join(root, "agents", "removed.md"),
            contentHash: world.hash("removed\n"),
            mode: "owned",
            plugin: "demo",
          },
        ],
      });
    },
    clean: async (world) => {
      const root = world.rootFor("opencode");
      // entry target exists, so it is not stale
      await world.writeText(join(root, "agents", "kept.md"), "kept\n");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root,
        entries: [
          {
            targetPath: join(root, "agents", "kept.md"),
            contentHash: world.hash("kept\n"),
            mode: "owned",
            plugin: "demo",
          },
        ],
      });
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const read = await readSnapshot({
        prismHome: world.sandbox.prismHome,
        harness: "opencode",
        root: world.rootFor("opencode"),
      });
      expect(read.manifest.entries).toEqual([]);
    },
  },
  {
    code: "snapshot.owned-missing",
    description: "owned file recorded in snapshot is missing",
    harnesses: ["opencode"],
    trigger: async (world) => {
      const root = world.rootFor("opencode");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root,
        entries: [
          {
            targetPath: join(root, "agents", "missing.md"),
            contentHash: world.hash("missing\n"),
            mode: "owned",
            plugin: "demo",
          },
        ],
      });
    },
    clean: async (world) => {
      const root = world.rootFor("opencode");
      // entry target exists with matching hash
      await world.writeText(join(root, "agents", "present.md"), "present\n");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root,
        entries: [
          {
            targetPath: join(root, "agents", "present.md"),
            contentHash: world.hash("present\n"),
            mode: "owned",
            plugin: "demo",
          },
        ],
      });
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const read = await readSnapshot({
        prismHome: world.sandbox.prismHome,
        harness: "opencode",
        root: world.rootFor("opencode"),
      });
      expect(read.manifest.entries).toEqual([]);
    },
  },
  {
    code: "sync.create",
    description: "managed command file needs to be created",
    harnesses: ["opencode"],
    trigger: async (world) => {
      await world.withPlugin(
        "create-demo",
        { targets: { commands: ["opencode"] } },
        { "commands/review.md": "managed command\n" },
      );
    },
    clean: async () => {
      // no plugin means no sync plan
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const commandPath = join(world.rootFor("opencode"), "commands", "review.md");
      expect(await Bun.file(commandPath).exists()).toBe(true);
      expect(await Bun.file(commandPath).text()).toContain("managed command");
    },
  },
  {
    code: "namespace.unowned-mcp-entry",
    description: "orphaned prism-fingerprinted MCP entry outside any owned patch region — cursor (JSON)",
    harnesses: ["cursor"],
    trigger: async (world) => {
      await world.writeText(
        join(world.rootFor("cursor"), "mcp.json"),
        JSON.stringify(
          { mcpServers: { "prism-generated-retired-tool": { command: "prism", args: ["mcp", "shim"] } } },
          null,
          2,
        ),
      );
    },
    clean: async () => {
      // no cursor mcp.json means no orphan finding
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const configPath = join(world.rootFor("cursor"), "mcp.json");
      const parsed = JSON.parse(await Bun.file(configPath).text());
      expect(Object.keys(parsed.mcpServers ?? {})).toEqual([]);
    },
  },
  {
    code: "namespace.unowned-mcp-entry",
    description: "orphaned prism-fingerprinted MCP entry outside any owned patch region — codex-cli (unfenced TOML)",
    harnesses: ["codex-cli"],
    trigger: async (world) => {
      await world.withCodexToml(
        [
          '["mcp_servers"."prism-generated-old-tool"]',
          'command = "prism"',
          'args = ["mcp", "shim"]',
          '["mcp_servers"."prism-generated-old-tool"."env"]',
          'PRISM_SHIM_PLUGINS = "old-tool"',
          "",
        ].join("\n"),
      );
    },
    clean: async () => {
      // no codex config.toml means no orphan finding
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const configPath = join(world.rootFor("codex-cli"), "config.toml");
      const content = await Bun.file(configPath).text();
      expect(content).not.toContain("prism-generated-old-tool");
    },
  },
  {
    code: "namespace.unowned-mcp-entry",
    description: "orphaned prism-fingerprinted MCP entry outside any owned patch region — grok (unfenced TOML)",
    harnesses: ["grok"],
    trigger: async (world) => {
      await world.writeText(
        join(world.rootFor("grok"), "config.toml"),
        [
          '["mcp_servers"."p_deadbeef"]',
          'command = "prism"',
          'args = ["mcp", "shim"]',
          "",
        ].join("\n"),
      );
    },
    clean: async () => {
      // no grok config.toml means no orphan finding
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const configPath = join(world.rootFor("grok"), "config.toml");
      const content = await Bun.file(configPath).text();
      expect(content).not.toContain("p_deadbeef");
    },
  },
  {
    code: "namespace.unowned-mcp-entry",
    description: "orphaned prism-fingerprinted MCP entry outside any owned patch region — hermes (unfenced YAML)",
    harnesses: ["hermes"],
    trigger: async (world) => {
      await world.writeText(
        join(world.rootFor("hermes"), "config.yaml"),
        [
          "mcp_servers:",
          "  prism-generated-old-tool:",
          '    command: "prism"',
          "    args:",
          "      - mcp",
          "      - shim",
          "",
        ].join("\n"),
      );
    },
    clean: async () => {
      // no hermes config.yaml means no orphan finding
    },
    expectFixCleared: true,
    verifyFix: async (world) => {
      const configPath = join(world.rootFor("hermes"), "config.yaml");
      const content = await Bun.file(configPath).text();
      expect(content).not.toContain("prism-generated-old-tool");
    },
  },
  {
    code: "region.json-invalid",
    description: "shared JSON config with Prism regions is not parseable",
    harnesses: ["opencode"],
    trigger: async (world) => {
      const root = world.rootFor("opencode");
      const configPath = join(root, "AGENTS.md");
      await world.writeText(configPath, "not json");
      await world.withSnapshot({
        version: 1,
        harness: "opencode",
        root,
        entries: [
          {
            targetPath: configPath,
            contentHash: world.hash("not json"),
            mode: "region",
            regionKey: 'json demo ["section"]',
            plugin: "demo",
          },
        ],
      });
    },
    clean: async () => {
      // no snapshot means no region integrity finding
    },
    expectFixCleared: false,
  },
];

test.each(CONTRACT_CASES)(
  "$code — $description",
  async (case_) => {
    const catalogEntry = FINDING_CATALOG.find((entry) => entry.code === case_.code);
    expect(catalogEntry).toBeDefined();

    // Positive: the finding is present when the trigger state is set up.
    await withDoctorWorld(async (world) => {
      await case_.trigger(world);
      const report = await runDoctorOnWorld(world, {
        harnesses: case_.harnesses,
        fix: case_.positiveUsesFix ?? false,
      });
      const codes = codesOf(report);
      expect(codes).toContain(case_.code);
      const finding = report.findings.find((f) => f.code === case_.code);
      expect(finding).toMatchObject({
        family: catalogEntry!.family,
        severity: catalogEntry!.severity,
      });
    });

    // Negative: the finding is absent when the clean state is set up.
    await withDoctorWorld(async (world) => {
      await case_.clean(world);
      const report = await runDoctorOnWorld(world, {
        harnesses: case_.harnesses,
        fix: false,
      });
      expect(codesOf(report)).not.toContain(case_.code);
    });

    // Fix path: automated fixes converge; manual fixes persist.
    await withDoctorWorld(async (world) => {
      await case_.trigger(world);
      const fixReport = await runDoctorOnWorld(world, {
        harnesses: case_.harnesses,
        fix: true,
      });

      if (case_.expectFixCleared) {
        // Some gc-only codes are only emitted during --fix, so the fix report
        // itself may contain them. We assert durable convergence on a follow-up
        // no-fix run.
        const afterFixReport = await runDoctorOnWorld(world, {
          harnesses: case_.harnesses,
          fix: false,
        });
        expect(codesOf(afterFixReport)).not.toContain(case_.code);
        if (case_.verifyFix) await case_.verifyFix(world);
      } else {
        expect(codesOf(fixReport)).toContain(case_.code);
      }
    });
  },
  30000,
);

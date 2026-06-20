import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { challengeFinish } from "../../examples/prism-harness-qa/workflows/challenge-proof";
import { CONFIG_SEED_RULES, evaluateHarnessChecks } from "./workflow-e2e-matrix";

describe("workflow-e2e live config seeding", () => {
  test("copies only the explicit auth/config files needed by seeded temp runs", () => {
    const paths = CONFIG_SEED_RULES.map((rule) => rule.from).sort();

    expect(paths).toEqual([
      ".claude.json",
      ".claude/.credentials.json",
      ".claude/settings.json",
      ".codex/auth.json",
      ".codex/config.toml",
      ".codex/models_cache.json",
      ".config/amp/settings-haiku.json",
      ".config/amp/settings.json",
      ".config/opencode/opencode.json",
      ".grok/auth.json",
      ".grok/models_cache.json",
      ".grok/version.json",
      ".hermes/auth.json",
      ".hermes/config.yaml",
      ".kimi-code/config.toml",
      ".kimi-code/credentials",
      ".kimi-code/device_id",
      ".kimi-code/oauth",
      ".local/share/amp/device-id.json",
      ".local/share/amp/secrets.json",
      ".local/share/amp/session.json",
      ".local/share/opencode/auth.json",
    ].sort());
  });

  test("does not seed broad harness roots or runtime identity sentinels", () => {
    const paths = CONFIG_SEED_RULES.map((rule) => rule.from);

    expect(paths).not.toContain(".codex");
    expect(paths).not.toContain(".grok");
    expect(paths).not.toContain(".hermes");
    expect(paths).not.toContain(".local/share/amp");
    expect(paths).not.toContain(".local/share/opencode");
    expect(paths).not.toContain(".codex/installation_id");
    expect(paths).not.toContain(".grok/agent_id");
    expect(paths).not.toContain(".grok/.metadata_version");
  });
});

describe("workflow-e2e challenge proof finish criteria", () => {
  test("fails closed on schema-valid false proof instead of requesting repair", async () => {
    const finish = challengeFinish("unit-challenge");
    const criterion = finish.criteria?.[0];

    expect(finish.maxRepairs).toBe(1);
    expect(criterion?.kind).toBe("judge");
    if (criterion?.kind !== "judge") throw new Error("expected judge finish criterion");

    const verdict = await Effect.runPromise(criterion.evaluate({
      goal: "unit",
      evidence: null,
      task: {
        id: "verify-challenge",
        agent: { plugin: "prism-harness-qa", name: "qa-tester" },
      },
      output: {
        challenge: "unit-challenge",
        proof: "TOOL_UNREACHABLE",
        source: "prism-generated-tool" as const,
      },
    }));

    expect(verdict.verdict).toBe("fail");
    expect("repairPrompt" in criterion).toBe(false);
  });
});

describe("workflow-e2e matrix evidence checks", () => {
  const completedRun = {
    command: ["worker"],
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    durationMs: 10,
  } as const;

  test("records pass checks for intended OpenCode worker, model, and agent", () => {
    const checks = evaluateHarnessChecks(
      {
        harness: "opencode",
        workflow: "smoke-opencode.workflow.ts",
        challenge: "opencode-2026-06-20-001",
        expectedModel: "ollama-cloud/deepseek-v4-flash",
      },
      {
        run: completedRun,
        proof: {
          pass: true,
          output: {
            challenge: "opencode-2026-06-20-001",
            proof: "prism-tool-proof:opencode-2026-06-20-001",
            source: "prism-generated-tool",
          },
          metadata: {
            adapter: "opencode-cli",
            nativeAgent: "qa-tester",
            model: "ollama-cloud/deepseek-v4-flash",
            finish: { repairs: 0 },
          },
        },
      },
    );

    expect(checks.every((item) => item.status !== "fail")).toBe(true);
    expect(checks.map((item) => item.name)).toContain("no-default-agent-fallback");
  });

  test("flags default-agent fallback and blocked tool output", () => {
    const checks = evaluateHarnessChecks(
      {
        harness: "claude-code",
        workflow: "smoke-claude-code.workflow.ts",
        challenge: "claude-code-2026-06-20-001",
        expectedModel: "sonnet",
      },
      {
        run: {
          ...completedRun,
          stderr: "tool use blocked by policy",
        },
        proof: {
          pass: true,
          metadata: {
            adapter: "claude-code",
            nativeAgent: "default",
            model: "sonnet",
            finish: { repairs: 0 },
          },
        },
      },
    );

    expect(checks.filter((item) => item.status === "fail").map((item) => item.name)).toEqual([
      "intended-agent-selection",
      "no-default-agent-fallback",
      "no-blocked-tool-interruption",
    ]);
  });

  test("does not flag informational blocked wording as a tool interruption", () => {
    const checks = evaluateHarnessChecks(
      {
        harness: "opencode",
        workflow: "smoke-opencode.workflow.ts",
        challenge: "opencode-2026-06-20-001",
        expectedModel: "ollama-cloud/deepseek-v4-flash",
      },
      {
        run: {
          ...completedRun,
          stderr: "tool configuration blocked by policy pack is unavailable",
        },
        proof: {
          pass: true,
          metadata: {
            adapter: "opencode-cli",
            nativeAgent: "qa-tester",
            model: "ollama-cloud/deepseek-v4-flash",
            finish: { repairs: 0 },
          },
        },
      },
    );

    expect(checks.find((item) => item.name === "no-blocked-tool-interruption")?.status).toBe("pass");
  });

  test("flags model mismatches", () => {
    const checks = evaluateHarnessChecks(
      {
        harness: "opencode",
        workflow: "smoke-opencode.workflow.ts",
        challenge: "opencode-2026-06-20-001",
        expectedModel: "ollama-cloud/deepseek-v4-flash",
      },
      {
        run: completedRun,
        proof: {
          pass: true,
          metadata: {
            adapter: "opencode-cli",
            nativeAgent: "qa-tester",
            model: "provider/wrong-model",
            finish: { repairs: 0 },
          },
        },
      },
    );

    expect(checks.find((item) => item.name === "model-resolved")).toEqual({
      name: "model-resolved",
      status: "fail",
      detail: "expected ollama-cloud/deepseek-v4-flash, got provider/wrong-model",
    });
  });

  test("marks metadata-dependent checks skipped when the workflow did not complete", () => {
    const checks = evaluateHarnessChecks(
      {
        harness: "opencode",
        workflow: "smoke-opencode.workflow.ts",
        challenge: "opencode-2026-06-20-001",
        expectedModel: "ollama-cloud/deepseek-v4-flash",
      },
      {
        run: {
          ...completedRun,
          exitCode: 1,
          stderr: "auth setup missing",
        },
        proof: {
          pass: false,
          detail: "workflow run exited non-zero",
        },
      },
    );

    expect(checks.find((item) => item.name === "intended-worker")?.status).toBe("skipped");
    expect(checks.find((item) => item.name === "model-resolved")?.status).toBe("skipped");
    expect(checks.find((item) => item.name === "no-finish-repairs")?.status).toBe("skipped");
  });

  test("accepts prompted-contract metadata for Hermes and Kimi Code", () => {
    for (const harness of ["hermes", "kimi-code"] as const) {
      const checks = evaluateHarnessChecks(
        {
          harness,
          workflow: `smoke-${harness}.workflow.ts`,
          challenge: `${harness}-2026-06-20-001`,
          expectedModel: harness === "hermes" ? "grok-composer-2.5-fast" : "kimi-code/kimi-for-coding",
        },
        {
          run: completedRun,
          proof: {
            pass: true,
            metadata: {
              adapter: harness,
              agentSelection: "prompted-contract",
              agent: { name: "qa-tester" },
              model: harness === "hermes" ? "grok-composer-2.5-fast" : "kimi-code/kimi-for-coding",
              finish: { repairs: 0 },
            },
          },
        },
      );

      expect(checks.every((item) => item.status !== "fail")).toBe(true);
    }
  });

  test("rejects flattened prompted-contract metadata for Hermes and Kimi Code", () => {
    for (const harness of ["hermes", "kimi-code"] as const) {
      const checks = evaluateHarnessChecks(
        {
          harness,
          workflow: `smoke-${harness}.workflow.ts`,
          challenge: `${harness}-2026-06-20-001`,
          expectedModel: harness === "hermes" ? "grok-composer-2.5-fast" : "kimi-code/kimi-for-coding",
        },
        {
          run: completedRun,
          proof: {
            pass: true,
            metadata: {
              adapter: harness,
              agentSelection: "prompted-contract",
              agentName: "qa-tester",
              model: harness === "hermes" ? "grok-composer-2.5-fast" : "kimi-code/kimi-for-coding",
              finish: { repairs: 0 },
            },
          },
        },
      );

      expect(checks.find((item) => item.name === "intended-agent-selection")?.status).toBe("fail");
      expect(checks.find((item) => item.name === "no-default-agent-fallback")?.status).toBe("pass");
    }
  });

  test("marks Codex CLI and Amp Code agent-selection checks not applicable", () => {
    const entries = [
      {
        harness: "codex-cli" as const,
        workflow: "smoke-codex-cli.workflow.ts",
        challenge: "codex-cli-2026-06-20-001",
        expectedModel: "gpt-5.4-mini",
        metadata: { adapter: "codex-cli", model: "gpt-5.4-mini", finish: { repairs: 0 } },
      },
      {
        harness: "amp-code" as const,
        workflow: "smoke-amp-code-deep.workflow.ts",
        challenge: "amp-code-deep-2026-06-20-001",
        expectedModel: "deep",
        metadata: { adapter: "amp-code", model: "deep", finish: { repairs: 0 } },
      },
    ];

    for (const { metadata, ...entry } of entries) {
      const checks = evaluateHarnessChecks(entry, {
        run: completedRun,
        proof: { pass: true, metadata },
      });

      expect(checks.find((item) => item.name === "intended-agent-selection")?.status).toBe("not-applicable");
      expect(checks.find((item) => item.name === "no-default-agent-fallback")?.status).toBe("not-applicable");
      expect(checks.every((item) => item.status !== "fail")).toBe(true);
    }
  });
});

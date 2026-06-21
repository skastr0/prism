import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { challengeFinish } from "../../examples/prism-harness-qa/workflows/challenge-proof";
import {
  CONFIG_SEED_RULES,
  classifySetupBlocker,
  evaluateHarnessChecks,
  evaluateInvalidModelSelectionCheck,
  evaluateModelSelectionChecks,
  OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  TOWER_COMMENT_FAMILY,
  WORKFLOW_E2E_PROOF_PREFIX,
} from "./workflow-e2e-matrix";

describe("workflow-e2e Tower evidence", () => {
  test("uses the Tower glyphs comment family", () => {
    expect(TOWER_COMMENT_FAMILY).toBe("glyphs");
  });
});

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

describe("workflow-e2e setup blocker classification", () => {
  const failedRun = (stderr: string) => ({
    exitCode: 1,
    stdout: "",
    stderr,
  });

  test("classifies current auth/setup blockers without treating them as pass", () => {
    expect(classifySetupBlocker(
      { harness: "grok" },
      failedRun("Workflow run failed: grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry"),
    )).toEqual({
      harness: "grok",
      code: "grok-oauth-login-required",
      message: "Grok requires xAI OAuth login before workflow run.",
      retryCommand: "grok login",
    });

    expect(classifySetupBlocker(
      { harness: "hermes" },
      failedRun("hermes exited with 1: xAI OAuth state is missing access_token. Re-authenticate with `hermes model`."),
    )).toEqual({
      harness: "hermes",
      code: "hermes-xai-oauth-access-token-missing",
      message: "Hermes xAI OAuth state is missing an access token.",
      retryCommand: "hermes model",
    });

    expect(classifySetupBlocker(
      { harness: "kimi-code" },
      failedRun("Workflow run failed: kimi-code requires OAuth login before workflow run; run `kimi login` or refresh Kimi Code credentials, then retry"),
    )).toEqual({
      harness: "kimi-code",
      code: "kimi-oauth-login-required",
      message: "Kimi Code requires OAuth login before workflow run.",
      retryCommand: "kimi login",
    });
  });

  test("does not classify unrelated harness failures as setup blockers", () => {
    expect(classifySetupBlocker(
      { harness: "opencode" },
      failedRun("workflow output failed schema validation"),
    )).toBeUndefined();
    expect(classifySetupBlocker(
      { harness: "grok" },
      { exitCode: 0, stdout: "{}", stderr: "" },
    )).toBeUndefined();
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
            stderrExcerpt: "tool prism_harness_qa_challenge_echo {\"challenge\":\"opencode-2026-06-20-001\"}",
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
            claudeToolCallNames: ["mcp__prism-generated-prism-harness-qa__prism_harness_qa_challenge_echo"],
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
    const entries = [
      {
        harness: "opencode" as const,
        workflow: "smoke-opencode.workflow.ts",
        challenge: "opencode-2026-06-20-001",
        expectedModel: "ollama-cloud/deepseek-v4-flash",
        metadata: {
          adapter: "opencode-cli",
          nativeAgent: "qa-tester",
          model: "ollama-cloud/deepseek-v4-flash",
          stderrExcerpt: "tool prism_harness_qa_challenge_echo {\"challenge\":\"opencode-2026-06-20-001\"}",
          finish: { repairs: 0 },
        },
      },
      {
        harness: "grok" as const,
        workflow: "smoke-grok.workflow.ts",
        challenge: "grok-2026-06-20-001",
        expectedModel: "grok-build",
        metadata: {
          adapter: "grok-cli",
          nativeAgent: "qa-tester",
          model: "grok-build",
          finish: { repairs: 0 },
        },
      },
    ];

    for (const { metadata, ...entry } of entries) {
      const checks = evaluateHarnessChecks(entry, {
        run: {
          ...completedRun,
          stderr: "tool configuration blocked by policy pack is unavailable",
        },
        proof: { pass: true, metadata },
      });

      expect(checks.find((item) => item.name === "no-blocked-tool-interruption")?.status).toBe("pass");
    }
  });

  test("requires Claude stream-json tool-use telemetry for generated MCP proof", () => {
    const entry = {
      harness: "claude-code" as const,
      workflow: "smoke-claude-code.workflow.ts",
      challenge: "claude-code-2026-06-20-001",
      expectedModel: "sonnet",
    };

    const passing = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "claude-code",
          nativeAgent: "qa-tester",
          model: "sonnet",
          claudeToolCallNames: ["mcp__prism-generated-prism-harness-qa__prism_harness_qa_challenge_echo"],
          finish: { repairs: 0 },
        },
      },
    });
    expect(passing.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("pass");

    const missingToolUse = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "claude-code",
          nativeAgent: "qa-tester",
          model: "sonnet",
          claudeToolCallNames: [],
          finish: { repairs: 0 },
        },
      },
    });
    expect(missingToolUse.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Claude stream-json tool_use for challenge_echo, got <none>",
    });
  });

  test("requires OpenCode stderr evidence to look like a generated tool call", () => {
    const entry = {
      harness: "opencode" as const,
      workflow: "smoke-opencode.workflow.ts",
      challenge: "opencode-2026-06-20-001",
      expectedModel: "ollama-cloud/deepseek-v4-flash",
    };

    const passing = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "opencode-cli",
          nativeAgent: "qa-tester",
          model: "ollama-cloud/deepseek-v4-flash",
          stderrExcerpt: "tool prism_harness_qa_challenge_echo {\"challenge\":\"opencode-2026-06-20-001\"}",
          finish: { repairs: 0 },
        },
      },
    });
    expect(passing.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("pass");

    const mentionOnly = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "opencode-cli",
          nativeAgent: "qa-tester",
          model: "ollama-cloud/deepseek-v4-flash",
          stderrExcerpt: "challenge_echo was mentioned in a prompt but no tool call was logged",
          finish: { repairs: 0 },
        },
      },
    });
    expect(mentionOnly.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected OpenCode stderr excerpt to include a challenge_echo call with matching JSON challenge input",
    });

    const wrongChallenge = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "opencode-cli",
          nativeAgent: "qa-tester",
          model: "ollama-cloud/deepseek-v4-flash",
          stderrExcerpt: "tool prism_harness_qa_challenge_echo {\"challenge\":\"other-challenge\"}",
          finish: { repairs: 0 },
        },
      },
    });
    expect(wrongChallenge.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected OpenCode stderr excerpt to include a challenge_echo call with matching JSON challenge input",
    });
  });

  test("requires Codex stderr evidence to show generated MCP challenge_echo execution", () => {
    const entry = {
      harness: "codex-cli" as const,
      workflow: "smoke-codex-cli.workflow.ts",
      challenge: "codex-cli-2026-06-20-001",
      expectedModel: "gpt-5.4-mini",
    };

    const passing = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo started",
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":\"prism-tool-proof:codex-cli-2026-06-20-001\",\"source\":\"prism-generated-tool\"}",
          ].join("\n"),
          finish: { repairs: 0 },
        },
      },
    });
    expect(passing.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("pass");

    const wrongChallenge = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo started",
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "{\"challenge\":\"other-challenge\",\"proof\":\"prism-tool-proof:other-challenge\",\"source\":\"prism-generated-tool\"}",
          ].join("\n"),
          finish: { repairs: 0 },
        },
      },
    });
    expect(wrongChallenge.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });

    const wrongSource = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":\"prism-tool-proof:codex-cli-2026-06-20-001\",\"source\":\"fallback-json\"}",
          ].join("\n"),
          finish: { repairs: 0 },
        },
      },
    });
    expect(wrongSource.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });

    const missingJsonOutput = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
          finish: { repairs: 0 },
        },
      },
    });
    expect(missingJsonOutput.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });

    const malformedJsonOutput = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":",
          ].join("\n"),
          finish: { repairs: 0 },
        },
      },
    });
    expect(malformedJsonOutput.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });

    const interleavedMcpOutput = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "mcp: other-server/other_tool (completed)",
            "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":\"prism-tool-proof:codex-cli-2026-06-20-001\",\"source\":\"prism-generated-tool\"}",
          ].join("\n"),
          finish: { repairs: 0 },
        },
      },
    });
    expect(interleavedMcpOutput.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });

    const missingStderr = evaluateHarnessChecks(entry, {
      run: completedRun,
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          finish: { repairs: 0 },
        },
      },
    });
    expect(missingStderr.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: "expected Codex stderr excerpt to include generated MCP challenge_echo completion with matching JSON challenge output",
    });
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
            stderrExcerpt: "tool prism_harness_qa_challenge_echo {\"challenge\":\"opencode-2026-06-20-001\"}",
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

  test("reports generated-tool telemetry gaps without stale auth-blocked wording", () => {
    const entries = [
      {
        harness: "grok" as const,
        workflow: "smoke-grok.workflow.ts",
        challenge: "grok-2026-06-20-001",
        expectedModel: "grok-build",
        metadata: {
          adapter: "grok-cli",
          nativeAgent: "qa-tester",
          model: "grok-build",
          finish: { repairs: 0 },
        },
      },
      {
        harness: "hermes" as const,
        workflow: "smoke-hermes.workflow.ts",
        challenge: "hermes-2026-06-20-001",
        expectedModel: "grok-composer-2.5-fast",
        metadata: {
          adapter: "hermes",
          agentSelection: "prompted-contract",
          agent: { name: "qa-tester" },
          model: "grok-composer-2.5-fast",
          finish: { repairs: 0 },
        },
      },
      {
        harness: "kimi-code" as const,
        workflow: "smoke-kimi-code.workflow.ts",
        challenge: "kimi-code-2026-06-20-001",
        expectedModel: "kimi-code/kimi-for-coding",
        metadata: {
          adapter: "kimi-code",
          agentSelection: "prompted-contract",
          agent: { name: "qa-tester" },
          model: "kimi-code/kimi-for-coding",
          finish: { repairs: 0 },
        },
      },
    ];

    for (const { metadata, ...entry } of entries) {
      const checks = evaluateHarnessChecks(entry, {
        run: completedRun,
        proof: { pass: true, metadata },
      });
      const telemetry = checks.find((item) => item.name === "generated-tool-call-observed");

      expect(telemetry?.status).toBe("not-applicable");
      expect(telemetry?.detail).toContain("does not expose structured generated-tool telemetry");
      expect(telemetry?.detail).not.toContain("auth-blocked");
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
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          stderrExcerpt: [
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo started",
            "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
            "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":\"prism-tool-proof:codex-cli-2026-06-20-001\",\"source\":\"prism-generated-tool\"}",
          ].join("\n"),
          finish: { repairs: 0 },
        },
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

  test("accepts Amp Code deep and rush mode metadata", () => {
    for (const mode of ["deep", "rush"] as const) {
      const checks = evaluateHarnessChecks(
        {
          harness: "amp-code",
          workflow: `smoke-amp-code-${mode}.workflow.ts`,
          challenge: `amp-code-${mode}-2026-06-20-001`,
          expectedModel: mode,
        },
        {
          run: completedRun,
          proof: {
            pass: true,
            metadata: { adapter: "amp-code", model: mode, finish: { repairs: 0 } },
          },
        },
      );

      expect(checks.find((item) => item.name === "model-resolved")?.status).toBe("pass");
      expect(checks.find((item) => item.name === "no-finish-repairs")?.status).toBe("pass");
      expect(checks.every((item) => item.status !== "fail")).toBe(true);
    }
  });
});

describe("workflow-e2e model selection evidence checks", () => {
  const modelSelectionRun = (overrides: Record<string, { readonly model?: string; readonly proof?: string; readonly repairs?: number }> = {}) => ({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      tasks: [
        ["agent-default-modelspace", "model-agent-default-2026-06-20-001"],
        ["explicit-model-profile", "model-explicit-profile-2026-06-20-001"],
        ["raw-model-override", "model-raw-override-2026-06-20-001"],
        ["model-resolver", "model-resolver-2026-06-20-001"],
      ].map(([id, challenge]) => {
        const override = overrides[id] ?? {};
        return {
          id,
          output: {
            challenge,
            proof: override.proof ?? `${WORKFLOW_E2E_PROOF_PREFIX}${challenge}`,
            source: "prism-generated-tool",
          },
          metadata: {
            model: override.model ?? OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
            finish: { repairs: override.repairs ?? 0 },
          },
        };
      }),
    }),
  });

  test("passes agent-default, explicit profile, raw override, and modelResolver evidence", () => {
    const checks = evaluateModelSelectionChecks(modelSelectionRun());

    expect(checks.every((item) => item.status !== "fail")).toBe(true);
    expect(checks.map((item) => item.name)).toContain("agent-default-modelspace-model");
    expect(checks.map((item) => item.name)).toContain("explicit-model-profile-model");
    expect(checks.map((item) => item.name)).toContain("raw-model-override-model");
    expect(checks.map((item) => item.name)).toContain("model-resolver-model");
  });

  test("flags model-selection proof, model, and finish-repair regressions", () => {
    const checks = evaluateModelSelectionChecks(modelSelectionRun({
      "agent-default-modelspace": { proof: "TOOL_UNREACHABLE" },
      "explicit-model-profile": { model: "provider/wrong" },
      "model-resolver": { repairs: 1 },
    }));

    expect(checks.filter((item) => item.status === "fail").map((item) => item.name)).toEqual([
      "agent-default-modelspace-proof",
      "explicit-model-profile-model",
      "model-resolver-no-finish-repairs",
    ]);
  });

  test("flags skipped and non-zero model-selection runs", () => {
    expect(evaluateModelSelectionChecks(undefined)).toEqual([{
      name: "model-selection-run",
      status: "skipped",
      detail: "workflow was not run",
    }]);

    expect(evaluateModelSelectionChecks({
      exitCode: 1,
      stdout: "",
      stderr: "failed",
    })).toEqual([{
      name: "model-selection-run",
      status: "fail",
      detail: "model-selection workflow exited non-zero",
    }]);
  });

  test("passes invalid modelspace fail-closed checks only on the expected diagnostic", () => {
    expect(evaluateInvalidModelSelectionCheck({
      exitCode: 1,
      stdout: "",
      stderr: "modelspace profile prism-harness-qa:qa-models/unavailable has no concrete model for workflow worker 'opencode'",
    }).status).toBe("pass");

    expect(evaluateInvalidModelSelectionCheck({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    })).toEqual({
      name: "invalid-modelspace-fail-closed",
      status: "fail",
      detail: "invalid modelspace workflow unexpectedly succeeded",
    });

    expect(evaluateInvalidModelSelectionCheck({
      exitCode: 1,
      stdout: "",
      stderr: "some other workflow failure",
    })).toEqual({
      name: "invalid-modelspace-fail-closed",
      status: "fail",
      detail: "missing expected modelspace fail-closed diagnostic",
    });
  });
});

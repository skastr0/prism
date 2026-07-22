import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CHALLENGE_PROOF_SECRET_ENV,
  keyedChallengeProof,
} from "../../examples/prism-harness-qa/tools/proof";
import { challengeFinish } from "../../examples/prism-harness-qa/workflows/challenge-proof";
import {
  CLAUDE_CHALLENGE_TOOL_NAME,
  CODEX_CHALLENGE_COMPLETED_LINE,
  CONFIG_SEED_RULES,
  cleanupWorkflowE2EQaArtifacts,
  classifySetupBlocker,
  evaluateHarnessChecks,
  evaluateInvalidModelSelectionCheck,
  evaluateModelSelectionChecks,
  hermesAuthHasXaiOauthCredential,
  isMutableLiveConfigSeedPath,
  OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  removeWorkflowE2ETempRoots,
  resolveHermesAuthScopeForE2E,
  resolveHermesProfileForE2E,
  TOWER_COMMENT_FAMILY,
} from "./workflow-e2e-matrix";

const TEST_PROOF_SECRET = "workflow-e2e-unit-secret";
const proofFor = (challenge: string): string => keyedChallengeProof(challenge, TEST_PROOF_SECRET);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessRunning = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processIsRunning(pid)) return;
    await delay(50);
  }
  throw new Error(`process ${pid} did not start`);
};

describe("workflow-e2e Tower evidence", () => {
  test("uses the Tower glyphs comment family", () => {
    expect(TOWER_COMMENT_FAMILY).toBe("glyphs");
  });
});

describe("workflow-e2e live config seeding", () => {
  test("copies only the explicit non-secret config files needed by seeded temp runs", () => {
    const paths = CONFIG_SEED_RULES.map((rule) => rule.from).sort();

    expect(paths).toEqual([
      ".claude/settings.json",
      ".codex/config.toml",
      ".codex/models_cache.json",
      ".config/amp/settings-haiku.json",
      ".config/amp/settings.json",
      ".config/opencode/opencode.json",
      ".grok/models_cache.json",
      ".grok/version.json",
      ".hermes/config.yaml",
      ".kimi-code/config.toml",
    ].sort());
  });

  test("does not seed broad harness roots, OAuth state, or runtime identity sentinels", () => {
    const paths = CONFIG_SEED_RULES.map((rule) => rule.from);

    expect(paths.filter(isMutableLiveConfigSeedPath)).toEqual([]);
    expect(paths).not.toContain(".codex");
    expect(paths).not.toContain(".codex/auth.json");
    expect(paths).not.toContain(".grok");
    expect(paths).not.toContain(".grok/auth.json");
    expect(paths).not.toContain(".hermes");
    expect(paths).not.toContain(".hermes/auth.json");
    expect(paths).not.toContain(".kimi-code/credentials");
    expect(paths).not.toContain(".kimi-code/device_id");
    expect(paths).not.toContain(".kimi-code/oauth");
    expect(paths).not.toContain(".local/share/amp");
    expect(paths).not.toContain(".local/share/amp/device-id.json");
    expect(paths).not.toContain(".local/share/amp/secrets.json");
    expect(paths).not.toContain(".local/share/amp/session.json");
    expect(paths).not.toContain(".local/share/opencode");
    expect(paths).not.toContain(".local/share/opencode/auth.json");
    expect(paths).not.toContain(".claude.json");
    expect(paths).not.toContain(".claude/.credentials.json");
    expect(paths).not.toContain(".codex/installation_id");
    expect(paths).not.toContain(".grok/agent_id");
    expect(paths).not.toContain(".grok/.metadata_version");
  });

  test("classifies mutable live config seed paths as unsafe", () => {
    expect([
      ".claude.json",
      ".claude/.credentials.json",
      ".codex/auth.json",
      ".grok/auth.json",
      ".hermes/auth.json",
      ".hermes/profiles/lyra03/auth.json",
      ".kimi-code/credentials",
      ".kimi-code/device_id",
      ".kimi-code/oauth",
      ".local/share/amp/device-id.json",
      ".local/share/amp/secrets.json",
      ".local/share/amp/session.json",
      ".local/share/opencode/auth.json",
    ].filter((path) => !isMutableLiveConfigSeedPath(path))).toEqual([]);

    expect([
      ".claude/settings.json",
      ".codex/config.toml",
      ".codex/models_cache.json",
      ".config/amp/settings.json",
      ".config/opencode/opencode.json",
      ".grok/models_cache.json",
      ".hermes/config.yaml",
      ".kimi-code/config.toml",
    ].filter(isMutableLiveConfigSeedPath)).toEqual([]);
  });

  test("defaults Hermes seeded runs to root auth and requires explicit profile scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-hermes-profile-test-"));
    try {
      await mkdir(join(root, ".hermes", "profiles", "empty"), { recursive: true });
      await mkdir(join(root, ".hermes", "profiles", "lyra03"), { recursive: true });
      await writeFile(join(root, ".hermes", "profiles", "empty", "auth.json"), `${JSON.stringify({
        providers: { "xai-oauth": { tokens: { id_token: "present" } } },
        credential_pool: { "xai-oauth": [] },
      })}\n`);
      await writeFile(join(root, ".hermes", "profiles", "lyra03", "auth.json"), `${JSON.stringify({
        providers: { "xai-oauth": { tokens: { id_token: "present" } } },
        credential_pool: { "xai-oauth": [{ access_token: "present", refresh_token: "present" }] },
      })}\n`);

      expect(hermesAuthHasXaiOauthCredential({
        credential_pool: { "xai-oauth": [{ access_token: "present" }] },
      })).toBe(true);
      expect(resolveHermesAuthScopeForE2E(undefined, undefined)).toBe("root");
      expect(resolveHermesAuthScopeForE2E("root", "lyra03")).toBe("root");
      expect(resolveHermesAuthScopeForE2E("profile", undefined)).toBe("profile");
      expect(() => resolveHermesAuthScopeForE2E(undefined, "lyra03")).toThrow("requires PRISM_E2E_HERMES_AUTH_SCOPE=profile");
      expect(await resolveHermesProfileForE2E(root, undefined)).toBe("lyra03");
      expect(await resolveHermesProfileForE2E(root, "manual-profile")).toBe("manual-profile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workflow-e2e temp cleanup", () => {
  test.skip("reaps MCP servers before deleting temp roots (MCP excised)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-e2e-cleanup-test-"));
    const server = join(root, "runtime", "mcp", "fixture", "server.mjs");
    await mkdir(join(root, "runtime", "mcp", "fixture"), { recursive: true });
    await writeFile(server, "setInterval(() => {}, 1000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, server],
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForProcessRunning(proc.pid);
      expect(processIsRunning(proc.pid)).toBe(true);

      await removeWorkflowE2ETempRoots([root]);

      expect(processIsRunning(proc.pid)).toBe(false);
      expect(await pathExists(root)).toBe(false);
    } finally {
      if (processIsRunning(proc.pid)) {
        process.kill(proc.pid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes QA hot-path artifacts even when sync state is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-e2e-qa-cleanup-test-"));
    const prismHome = join(root, "prism-home");
    const opencodeRoot = join(root, "opencode");
    const codexRoot = join(root, "codex");
    const hermesRoot = join(root, "hermes");
    const kimiRoot = join(root, "kimi");

    try {
      await mkdir(join(opencodeRoot, "plugins", "prism-generated-prism-harness-qa", "dist"), { recursive: true });
      await mkdir(join(opencodeRoot, "agents"), { recursive: true });
      await mkdir(join(opencodeRoot, "skills", "qa-helper"), { recursive: true });
      await mkdir(join(opencodeRoot, "skills", "qa-orbit"), { recursive: true });
      await writeFile(join(opencodeRoot, "plugins", "prism-generated-prism-harness-qa", "dist", "server.mjs"), "");
      await writeFile(join(opencodeRoot, "agents", "qa-tester.md"), "");
      await writeFile(join(opencodeRoot, "skills", "qa-helper", "SKILL.md"), "");
      await writeFile(join(opencodeRoot, "skills", "qa-orbit", "SKILL.md"), "");
      await writeFile(join(opencodeRoot, "opencode.json"), `${JSON.stringify({
        agent: { "qa-tester": { model: "test" }, keeper: { model: "ok" } },
        permission: { "prism_harness_qa_*": "allow", keep: "allow" },
        plugin: [
          "file:///tmp/plugins/prism-generated-prism-harness-qa/dist/server.mjs",
          "file:///tmp/plugins/prism-generated-keeper/dist/server.mjs",
        ],
      }, null, 2)}\n`);

      await mkdir(codexRoot, { recursive: true });
      await writeFile(join(codexRoot, "config.toml"), `
[mcp_servers."keeper"]
url = "http://127.0.0.1:1111/mcp"

# --- prism:codex.mcp.prism-generated-prism-harness-qa begin ---
[mcp_servers."prism-generated-prism-harness-qa"]
url = "http://127.0.0.1:2222/mcp"
# --- prism:codex.mcp.prism-generated-prism-harness-qa end ---
`);

      await mkdir(hermesRoot, { recursive: true });
      await writeFile(join(hermesRoot, "config.yaml"), `mcp_servers:
  prism-generated-prism-harness-qa:
    url: http://127.0.0.1:2222/mcp
    tools:
      include:
      - prism_harness_qa_challenge_echo
  prism-generated-keeper:
    url: http://127.0.0.1:1111/mcp
`);

      await mkdir(join(kimiRoot, "plugins", "managed", "prism-generated-prism-harness-qa"), { recursive: true });
      await mkdir(join(kimiRoot, "plugins"), { recursive: true });
      await writeFile(join(kimiRoot, "plugins", "managed", "prism-generated-prism-harness-qa", "kimi.plugin.json"), "{}");
      await writeFile(join(kimiRoot, "plugins", "installed.json"), `${JSON.stringify({
        plugins: [
          { id: "prism-generated-keeper", root: "/tmp/keeper" },
          { id: "prism-generated-prism-harness-qa", root: "/tmp/qa" },
        ],
      }, null, 2)}\n`);
      await mkdir(join(prismHome, "runtime", "mcp", "prism-harness-qa"), { recursive: true });
      await writeFile(join(prismHome, "runtime", "mcp", "prism-harness-qa", "server.mjs"), "");

      const cleanup = await cleanupWorkflowE2EQaArtifacts({
        prismHome,
        harnesses: new Set(["opencode", "codex-cli", "hermes", "kimi-code"]),
        harnessRoots: {
          opencode: opencodeRoot,
          "codex-cli": codexRoot,
          hermes: hermesRoot,
          "kimi-code": kimiRoot,
        },
      });

      expect(cleanup.success).toBe(true);
      expect(await pathExists(join(opencodeRoot, "plugins", "prism-generated-prism-harness-qa"))).toBe(false);
      expect(await pathExists(join(opencodeRoot, "agents", "qa-tester.md"))).toBe(false);
      expect(await pathExists(join(opencodeRoot, "skills", "qa-helper"))).toBe(false);
      expect(await pathExists(join(kimiRoot, "plugins", "managed", "prism-generated-prism-harness-qa"))).toBe(false);
      expect(await pathExists(join(prismHome, "runtime", "mcp", "prism-harness-qa"))).toBe(false);

      const opencodeConfig = await readFile(join(opencodeRoot, "opencode.json"), "utf8");
      expect(opencodeConfig).not.toContain("qa-tester");
      expect(opencodeConfig).not.toContain("prism_harness_qa_*");
      expect(opencodeConfig).not.toContain("prism-generated-prism-harness-qa");
      expect(opencodeConfig).toContain("keeper");

      const codexConfig = await readFile(join(codexRoot, "config.toml"), "utf8");
      expect(codexConfig).not.toContain("prism-generated-prism-harness-qa");
      expect(codexConfig).toContain("keeper");

      const hermesConfig = await readFile(join(hermesRoot, "config.yaml"), "utf8");
      expect(hermesConfig).not.toContain("prism-generated-prism-harness-qa");
      expect(hermesConfig).not.toContain("prism_harness_qa_challenge_echo");
      expect(hermesConfig).toContain("prism-generated-keeper");

      const kimiInstalled = await readFile(join(kimiRoot, "plugins", "installed.json"), "utf8");
      expect(kimiInstalled).not.toContain("prism-generated-prism-harness-qa");
      expect(kimiInstalled).toContain("prism-generated-keeper");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workflow-e2e challenge proof finish criteria", () => {
  const judgeVerdict = async (proof: string) => {
    const finish = challengeFinish("unit-challenge");
    const criterion = finish.criteria?.[0];

    expect(finish.maxRepairs).toBe(1);
    expect(criterion?.kind).toBe("judge");
    if (criterion?.kind !== "judge") throw new Error("expected judge finish criterion");
    expect("repairPrompt" in criterion).toBe(false);

    return Effect.runPromise(criterion.evaluate({
      goal: "unit",
      evidence: null,
      task: {
        id: "verify-challenge",
        agent: { plugin: "prism-harness-qa", name: "qa-tester" },
      },
      output: {
        challenge: "unit-challenge",
        proof,
        source: "prism-generated-tool" as const,
      },
    }));
  };

  const withProofSecretEnv = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = process.env[CHALLENGE_PROOF_SECRET_ENV];
    process.env[CHALLENGE_PROOF_SECRET_ENV] = TEST_PROOF_SECRET;
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env[CHALLENGE_PROOF_SECRET_ENV];
      } else {
        process.env[CHALLENGE_PROOF_SECRET_ENV] = previous;
      }
    }
  };

  test("fails closed on schema-valid false proof instead of requesting repair", async () => {
    const verdict = await judgeVerdict("TOOL_UNREACHABLE");
    expect(verdict.verdict).toBe("fail");
  });

  test("accepts only the keyed proof when the run secret is present", async () => {
    await withProofSecretEnv(async () => {
      expect((await judgeVerdict(proofFor("unit-challenge"))).verdict).toBe("pass");
      // The prompt-derivable legacy string must not pass a keyed run.
      expect((await judgeVerdict("prism-tool-proof:unit-challenge")).verdict).toBe("fail");
    });
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
        expectedProof: proofFor("opencode-2026-06-20-001"),
        proof: {
          pass: true,
          output: {
            challenge: "opencode-2026-06-20-001",
            proof: proofFor("opencode-2026-06-20-001"),
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
        expectedProof: proofFor("claude-code-2026-06-20-001"),
        proof: {
          pass: true,
          metadata: {
            adapter: "claude-code",
            nativeAgent: "default",
            model: "sonnet",
            claudeToolCallNames: [CLAUDE_CHALLENGE_TOOL_NAME],
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
        expectedProof: proofFor(entry.challenge),
        proof: { pass: true, metadata },
      });

      expect(checks.find((item) => item.name === "no-blocked-tool-interruption")?.status).toBe("pass");
    }
  });

  test.skip("requires Claude stream-json tool-use telemetry for generated MCP proof (MCP excised)", () => {
    const entry = {
      harness: "claude-code" as const,
      workflow: "smoke-claude-code.workflow.ts",
      challenge: "claude-code-2026-06-20-001",
      expectedModel: "sonnet",
    };
    const claudeInput = (claudeToolCallNames: readonly string[]) => ({
      run: completedRun,
      expectedProof: proofFor(entry.challenge),
      proof: {
        pass: true,
        metadata: {
          adapter: "claude-code",
          nativeAgent: "qa-tester",
          model: "sonnet",
          claudeToolCallNames,
          finish: { repairs: 0 },
        },
      },
    });

    expect(CLAUDE_CHALLENGE_TOOL_NAME).toBe("mcp__prism-harness-qa__challenge_echo");

    const passing = evaluateHarnessChecks(entry, claudeInput([CLAUDE_CHALLENGE_TOOL_NAME]));
    expect(passing.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("pass");

    const missingToolUse = evaluateHarnessChecks(entry, claudeInput([]));
    expect(missingToolUse.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: `expected Claude stream-json tool_use ${CLAUDE_CHALLENGE_TOOL_NAME}, got <none>`,
    });

    // The pre-shim transport is deleted; its tool_use name must not pass.
    const preShimName = evaluateHarnessChecks(
      entry,
      claudeInput(["mcp__prism-generated-prism-harness-qa__prism_harness_qa_challenge_echo"]),
    );
    expect(preShimName.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");
  });

  test("marks OpenCode tool-call telemetry not applicable (no channel carries it)", () => {
    const entry = {
      harness: "opencode" as const,
      workflow: "smoke-opencode.workflow.ts",
      challenge: "opencode-2026-06-20-001",
      expectedModel: "ollama-cloud/deepseek-v4-flash",
    };

    const checks = evaluateHarnessChecks(entry, {
      run: completedRun,
      expectedProof: proofFor(entry.challenge),
      proof: {
        pass: true,
        metadata: {
          adapter: "opencode-cli",
          nativeAgent: "qa-tester",
          model: "ollama-cloud/deepseek-v4-flash",
          finish: { repairs: 0 },
        },
      },
    });
    const telemetry = checks.find((item) => item.name === "generated-tool-call-observed");

    expect(telemetry?.status).toBe("not-applicable");
    expect(telemetry?.detail).toContain("keyed challenge proof");
  });

  test.skip("requires Codex stderr evidence to show shim MCP challenge_echo execution (MCP excised)", () => {
    const entry = {
      harness: "codex-cli" as const,
      workflow: "smoke-codex-cli.workflow.ts",
      challenge: "codex-cli-2026-06-20-001",
      expectedModel: "gpt-5.4-mini",
    };
    const failDetail = "expected Codex stderr excerpt to include shim MCP challenge_echo completion with matching keyed JSON output";
    const codexInput = (stderrExcerpt?: string) => ({
      run: completedRun,
      expectedProof: proofFor(entry.challenge),
      proof: {
        pass: true,
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.4-mini",
          ...(stderrExcerpt !== undefined ? { stderrExcerpt } : {}),
          finish: { repairs: 0 },
        },
      },
    });
    const toolOutputLine = (challenge: string, proof: string, source = "prism-generated-tool") =>
      JSON.stringify({ challenge, proof, source });

    expect(CODEX_CHALLENGE_COMPLETED_LINE).toBe(
      "mcp: prism-harness-qa/challenge_echo (completed)",
    );

    const passing = evaluateHarnessChecks(entry, codexInput([
      "mcp: prism-harness-qa/challenge_echo started",
      CODEX_CHALLENGE_COMPLETED_LINE,
      toolOutputLine(entry.challenge, proofFor(entry.challenge)),
    ].join("\n")));
    expect(passing.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("pass");

    // The pre-shim server name is deleted; its completion line must not pass.
    const preShimServer = evaluateHarnessChecks(entry, codexInput([
      "mcp: prism-generated-prism-harness-qa/prism_harness_qa_challenge_echo (completed)",
      toolOutputLine(entry.challenge, proofFor(entry.challenge)),
    ].join("\n")));
    expect(preShimServer.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: failDetail,
    });

    const wrongChallenge = evaluateHarnessChecks(entry, codexInput([
      CODEX_CHALLENGE_COMPLETED_LINE,
      toolOutputLine("other-challenge", proofFor("other-challenge")),
    ].join("\n")));
    expect(wrongChallenge.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    // A prompt-derivable legacy proof must not pass a keyed run.
    const unkeyedProof = evaluateHarnessChecks(entry, codexInput([
      CODEX_CHALLENGE_COMPLETED_LINE,
      toolOutputLine(entry.challenge, `prism-tool-proof:${entry.challenge}`),
    ].join("\n")));
    expect(unkeyedProof.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    const wrongSource = evaluateHarnessChecks(entry, codexInput([
      CODEX_CHALLENGE_COMPLETED_LINE,
      toolOutputLine(entry.challenge, proofFor(entry.challenge), "fallback-json"),
    ].join("\n")));
    expect(wrongSource.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    const missingJsonOutput = evaluateHarnessChecks(entry, codexInput(CODEX_CHALLENGE_COMPLETED_LINE));
    expect(missingJsonOutput.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    const malformedJsonOutput = evaluateHarnessChecks(entry, codexInput([
      CODEX_CHALLENGE_COMPLETED_LINE,
      "{\"challenge\":\"codex-cli-2026-06-20-001\",\"proof\":",
    ].join("\n")));
    expect(malformedJsonOutput.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    const interleavedMcpOutput = evaluateHarnessChecks(entry, codexInput([
      CODEX_CHALLENGE_COMPLETED_LINE,
      "mcp: other-server/other_tool (completed)",
      toolOutputLine(entry.challenge, proofFor(entry.challenge)),
    ].join("\n")));
    expect(interleavedMcpOutput.find((item) => item.name === "generated-tool-call-observed")?.status).toBe("fail");

    const missingStderr = evaluateHarnessChecks(entry, codexInput());
    expect(missingStderr.find((item) => item.name === "generated-tool-call-observed")).toEqual({
      name: "generated-tool-call-observed",
      status: "fail",
      detail: failDetail,
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
        expectedProof: proofFor("opencode-2026-06-20-001"),
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
        expectedProof: proofFor("opencode-2026-06-20-001"),
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
          expectedProof: proofFor(`${harness}-2026-06-20-001`),
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

  test("requires explicit profile scope before accepting Hermes profile metadata", () => {
    const entry = {
      harness: "hermes" as const,
      workflow: "smoke-hermes.workflow.ts",
      challenge: "hermes-2026-06-20-001",
      expectedModel: "grok-composer-2.5-fast",
    };
    const proof = {
      pass: true,
      metadata: {
        adapter: "hermes",
        agentSelection: "profile",
        profile: "lyra03",
        agent: { name: "qa-tester" },
        model: "grok-composer-2.5-fast",
        finish: { repairs: 0 },
      },
    };

    const rootChecks = evaluateHarnessChecks(
      entry,
      {
        run: completedRun,
        expectedProof: proofFor(entry.challenge),
        proof,
      },
    );

    expect(rootChecks.filter((item) => item.status === "fail").map((item) => item.name)).toEqual([
      "intended-agent-selection",
      "no-default-agent-fallback",
    ]);

    const profileChecks = evaluateHarnessChecks(
      entry,
      {
        run: completedRun,
        expectedProof: proofFor(entry.challenge),
        proof,
      },
      { hermesAuthScope: "profile" },
    );

    expect(profileChecks.every((item) => item.status !== "fail")).toBe(true);
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
        expectedProof: proofFor(entry.challenge),
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
          expectedProof: proofFor(`${harness}-2026-06-20-001`),
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
            "mcp: prism-harness-qa/challenge_echo started",
            CODEX_CHALLENGE_COMPLETED_LINE,
            JSON.stringify({
              challenge: "codex-cli-2026-06-20-001",
              proof: proofFor("codex-cli-2026-06-20-001"),
              source: "prism-generated-tool",
            }),
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
        expectedProof: proofFor(entry.challenge),
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
          expectedProof: proofFor(`amp-code-${mode}-2026-06-20-001`),
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
            proof: override.proof ?? proofFor(challenge ?? ""),
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
    const checks = evaluateModelSelectionChecks(modelSelectionRun(), proofFor);

    expect(checks.every((item) => item.status !== "fail")).toBe(true);
    expect(checks.map((item) => item.name)).toContain("agent-default-modelspace-model");
    expect(checks.map((item) => item.name)).toContain("explicit-model-profile-model");
    expect(checks.map((item) => item.name)).toContain("raw-model-override-model");
    expect(checks.map((item) => item.name)).toContain("model-resolver-model");
  });

  test("flags model-selection proof, model, and finish-repair regressions", () => {
    const checks = evaluateModelSelectionChecks(modelSelectionRun({
      // The prompt-derivable legacy string must fail a keyed run.
      "agent-default-modelspace": { proof: "prism-tool-proof:model-agent-default-2026-06-20-001" },
      "explicit-model-profile": { model: "provider/wrong" },
      "model-resolver": { repairs: 1 },
    }), proofFor);

    expect(checks.filter((item) => item.status === "fail").map((item) => item.name)).toEqual([
      "agent-default-modelspace-proof",
      "explicit-model-profile-model",
      "model-resolver-no-finish-repairs",
    ]);
  });

  test("flags skipped and non-zero model-selection runs", () => {
    expect(evaluateModelSelectionChecks(undefined, proofFor)).toEqual([{
      name: "model-selection-run",
      status: "skipped",
      detail: "workflow was not run",
    }]);

    expect(evaluateModelSelectionChecks({
      exitCode: 1,
      stdout: "",
      stderr: "failed",
    }, proofFor)).toEqual([{
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

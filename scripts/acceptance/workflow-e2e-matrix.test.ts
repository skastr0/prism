import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { challengeFinish } from "../../examples/prism-harness-qa/workflows/challenge-proof";
import { CONFIG_SEED_RULES } from "./workflow-e2e-matrix";

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

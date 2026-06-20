import { describe, expect, test } from "bun:test";
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
      ".hermes/config.yaml",
      ".kimi-code/config.toml",
      ".kimi-code/credentials",
      ".kimi-code/device_id",
      ".kimi-code/oauth",
      ".local/share/opencode/auth.json",
    ].sort());
  });

  test("does not seed broad harness roots or runtime identity sentinels", () => {
    const paths = CONFIG_SEED_RULES.map((rule) => rule.from);

    expect(paths).not.toContain(".codex");
    expect(paths).not.toContain(".grok");
    expect(paths).not.toContain(".local/share/opencode");
    expect(paths).not.toContain(".codex/installation_id");
    expect(paths).not.toContain(".grok/agent_id");
    expect(paths).not.toContain(".grok/.metadata_version");
  });
});

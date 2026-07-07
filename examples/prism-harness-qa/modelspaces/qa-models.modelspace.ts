import type { ModelspaceSource } from "prism";

export default {
  name: "qa-models",
  description: "Harness smoke-test model profiles for Prism workflow E2E checks.",
  profiles: {
    smoke: {
      description: "Default smoke-test model profile used by qa-tester.",
      targets: {
        "amp-code": { model: "deep" },
        "claude-code": { model: "sonnet" },
        "codex-cli": { model: "gpt-5.4-mini" },
        // Not "grok-build" — fails config validation against a restricted
        // custom --agent file (every Prism-generated agent); see PQ-176.
        grok: { model: "grok-composer-2.5-fast" },
        // Hermes multiplexes providers; grok models live behind xai-oauth.
        // Bare model without --provider hits the synthetic default and fails.
        hermes: { model: "grok-composer-2.5-fast", provider: "xai-oauth" },
        "kimi-code": { model: "kimi-code/kimi-for-coding" },
        opencode: { model: "ollama-cloud/deepseek-v4-flash" },
      },
    },
    explicit: {
      description: "Secondary profile used by workflow model-ref tests.",
      targets: {
        "amp-code": { model: "rush" },
        "claude-code": { model: "opus" },
        "codex-cli": { model: "gpt-5.5" },
        grok: { model: "grok-composer-2.5-fast" },
        hermes: { model: "grok-4.20-reasoning", provider: "xai-oauth" },
        "kimi-code": { model: "kimi-code/kimi-for-coding" },
        opencode: {
          strategy: "ordered",
          models: [
            { model: "ollama-cloud/deepseek-v4-flash" },
            { model: "ollama-cloud/glm-5.2" },
          ],
        },
      },
    },
    unavailable: {
      description: "Negative test profile intentionally omits opencode.",
      targets: {
        "claude-code": { model: "sonnet" },
      },
    },
  },
} satisfies ModelspaceSource;

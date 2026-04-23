import { defineLifecycle, lifecycleRef } from "../../../src/index.ts";

export default defineLifecycle({
  name: "sdlc-experiment",
  description: "Evaluate whether async commits should become the canonical SDLC path in sdlc-core",
  produces: "A go/no-go decision for async commits in sdlc-core",
  phases: [
    {
      name: "Async commits latency experiment",
      lifecycle_binding: {
        lifecycle: lifecycleRef("experiment"),
        bindings: {
          H: "Async commits reduce end-to-end latency without hurting correctness",
          App: "sdlc-core",
        },
      },
      signal_in: "Latency complaints and commit-path observations from the current SDLC toolchain",
      termination: "A concrete decision exists for async commits in sdlc-core",
    },
  ],
  taste_checkpoints: [
    {
      after: "Async commits latency experiment",
      note: "Review whether the evidence is strong enough to change the canonical commit path.",
    },
  ],
  evolution: "If the hypothesis fails, tighten the queueing model before proposing another async path.",
  body: "This concrete lifecycle shows how a reusable experiment template stays source-only until another lifecycle binds it with a specific hypothesis and application context.",
});

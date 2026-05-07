import { defineOrbit, orbitRef } from "prism";

export default defineOrbit({
  name: "release-experiment",
  description: "Evaluate whether async approvals should become the canonical release path",
  produces: "A go/no-go decision for async release approvals",
  phases: [
    {
      name: "Async commits latency experiment",
      orbit_binding: {
        orbit: orbitRef("experiment"),
        bindings: {
          H: "Async approvals reduce end-to-end latency without hurting correctness",
          App: "release pipeline",
        },
      },
      notes: {
        Input: "Latency complaints and approval-path observations from the current release pipeline",
        Done: "A concrete decision exists for async release approvals",
      },
    },
  ],
  pulsar_checkpoints: [
    {
      after: "Async commits latency experiment",
      note: "Review whether the evidence is strong enough to change the canonical release path.",
    },
  ],
  evolution: "If the hypothesis fails, tighten the queueing model before proposing another async path.",
  body: "This concrete orbit shows how a reusable experiment template stays source-only until another orbit binds it with a specific hypothesis and application context.",
});

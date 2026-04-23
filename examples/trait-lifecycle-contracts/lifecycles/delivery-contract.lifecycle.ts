import { agentRef, defineLifecycle, traitRef } from "../../../src/index.ts";

export default defineLifecycle({
  name: "delivery-contract",
  description: "Compile-time orchestration contract over assigned trait-conforming agents",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
      signal_in: "Work item is ready to build",
      termination: "Implementation is ready for review",
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
      signal_in: "Implementation is ready for review",
      termination: "Review findings are recorded",
    },
    {
      name: "Hand off work",
      agents: [agentRef("builder"), agentRef("reviewer")],
      requires: [{ all: [traitRef("submittable")], min: 2 }],
      signal_in: "Build and review are complete",
      termination: "Work has been handed off cleanly",
    },
  ],
  body: "Use this example when you want lifecycle phases to prove, at compile time, that the assigned agents expose the required capabilities.",
});

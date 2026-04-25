import { agentRef, defineLifecycle, traitRef } from "agentpkg";

export default defineLifecycle({
  name: "delivery-contract",
  description: "Compile-time orchestration contract over assigned trait-conforming agents",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
      notes: {
        Input: "Work item is ready to build",
        Done: "Implementation is ready for review",
      },
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
      notes: {
        Input: "Implementation is ready for review",
        Done: "Review findings are recorded",
      },
    },
    {
      name: "Hand off work",
      agents: [agentRef("builder"), agentRef("reviewer")],
      requires: [{ all: [traitRef("submittable")], min: 2 }],
      notes: {
        Input: "Build and review are complete",
        Done: "Work has been handed off cleanly",
      },
    },
  ],
  body: "Use this example when you want lifecycle phases to prove, at compile time, that the assigned agents expose the required capabilities.",
});

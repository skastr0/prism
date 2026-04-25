import { defineLifecycle } from "agentpkg";

export default defineLifecycle({
  name: "experiment",
  description: "Reusable experiment lifecycle for ${H} in ${App}",
  produces: "A clear decision on whether ${H} should change the canonical path in ${App}",
  parameters: [
    {
      name: "H",
      description: "Hypothesis being tested",
    },
    {
      name: "App",
      description: "Application context",
    },
  ],
  phases: [
    {
      name: "Frame the hypothesis for ${App}",
      notes: {
        Input: "Hypothesis ${H}",
        Done: "A falsifiable experiment brief exists for ${App}",
      },
    },
    {
      name: "Run the experiment in ${App}",
      notes: {
        Input: "Approved brief for ${H}",
        Done: "Concrete evidence exists for ${H} in ${App}",
      },
    },
    {
      name: "Evaluate the result for ${App}",
      notes: {
        Input: "Evidence packet for ${H}",
        Done: "A decision is recorded for ${App}",
      },
    },
  ],
  taste_checkpoints: [
    {
      after: "Frame the hypothesis for ${App}",
      note: "Confirm that ${H} is sharp enough to test before spending implementation effort.",
    },
  ],
  evolution: "Record what ${App} learned from testing ${H} and update the next experiment accordingly.",
  body: "Use this template when a product or business needs the same experiment shape with different concrete hypotheses and application contexts.",
});

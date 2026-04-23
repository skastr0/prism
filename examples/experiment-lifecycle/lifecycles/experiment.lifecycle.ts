import { defineLifecycle } from "../../../src/index.ts";

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
      signal_in: "Hypothesis ${H}",
      termination: "A falsifiable experiment brief exists for ${App}",
    },
    {
      name: "Run the experiment in ${App}",
      signal_in: "Approved brief for ${H}",
      termination: "Concrete evidence exists for ${H} in ${App}",
    },
    {
      name: "Evaluate the result for ${App}",
      signal_in: "Evidence packet for ${H}",
      termination: "A decision is recorded for ${App}",
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

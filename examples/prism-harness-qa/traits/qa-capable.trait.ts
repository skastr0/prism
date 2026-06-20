import { defineTrait, skillRef, toolRef } from "prism";

export default defineTrait({
  name: "qa-capable",
  description: "Grants an agent the deterministic challenge tool and QA helper skill visibility needed for harness QA tasks.",
  tools: {
    challenge_echo: {
      ref: "challenge_echo",
    },
  },
  access: {
    skills: [skillRef("qa-helper")],
  },
  require: {
    tools: ["challenge_echo"],
  },
});

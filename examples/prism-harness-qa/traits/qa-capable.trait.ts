import { defineTrait, skillRef, toolRef } from "prism";

export default defineTrait({
  name: "qa-capable",
  description: "Grants an agent the echo tool and QA helper skill visibility needed for harness QA tasks.",
  tools: {
    echo: {
      ref: "echo",
    },
  },
  access: {
    skills: [skillRef("qa-helper")],
  },
  require: {
    tools: ["echo"],
  },
});

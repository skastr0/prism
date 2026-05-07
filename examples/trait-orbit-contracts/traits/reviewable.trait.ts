import { defineTrait, toolGroupRef } from "prism";

export default defineTrait({
  name: "reviewable",
  description: "Can submit review findings",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
  tools: {
    submit_review: {
      ref: "submit_review",
    },
  },
  require: {
    tools: ["submit_review"],
  },
});

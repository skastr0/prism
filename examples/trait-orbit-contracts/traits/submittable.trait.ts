import type { TraitSource } from "prism";

export default {
  name: "submittable",
  description: "Adds the submit_work tool interface.",
  tools: {
    submit_work: {
      ref: "submit_work",
    },
  },
  require: {
    tools: ["submit_work"],
  },
} satisfies TraitSource;

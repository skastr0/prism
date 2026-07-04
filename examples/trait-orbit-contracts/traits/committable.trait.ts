import type { TraitSource } from "prism";

export default {
  name: "committable",
  description: "Can create implementation commits",
  tools: {
    commit_work: {
      ref: "commit_work",
    },
  },
  require: {
    tools: ["commit_work"],
  },
} satisfies TraitSource;

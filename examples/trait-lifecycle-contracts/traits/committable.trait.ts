import { defineTrait } from "../../../src/index.ts";

export default defineTrait({
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
});

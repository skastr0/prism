import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "submittable",
  description: "Adds the submit_work tool surface.",
  tools: {
    submit_work: {
      ref: "submit_work",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});

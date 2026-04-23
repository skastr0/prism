import { defineTrait, toolGroupRef } from "../../../src/index.ts";

export default defineTrait({
  name: "self-assessing",
  description: "Runs validation before handing work off",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
  inject: {
    skills: ["testing"],
  },
  require: {
    skills: ["testing"],
  },
});

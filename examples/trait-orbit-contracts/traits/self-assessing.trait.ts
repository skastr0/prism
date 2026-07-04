import { toolGroupRef, type TraitSource } from "prism";

export default {
  name: "self-assessing",
  description: "Runs validation before handing work off",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
} satisfies TraitSource;

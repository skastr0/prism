import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "rlc-practitioner",
  description: "Can use RLC method skills for research lifecycle work",
  access: {
    skills: [
      globalSkill("rlc"),
      globalSkill("research"),
      globalSkill("web-research"),
      globalSkill("repo-research"),
      globalSkill("model-intelligence"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
});

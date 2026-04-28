import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "mlc-practitioner",
  description: "Can use MLC method skills for marketing lifecycle work",
  access: {
    skills: [
      globalSkill("mlc"),
      globalSkill("marketing"),
      globalSkill("copy-engineering"),
      globalSkill("brand-positioning"),
      globalSkill("persuasion-architecture"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
});

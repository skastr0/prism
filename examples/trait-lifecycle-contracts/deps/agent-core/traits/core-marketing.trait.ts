import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "core-marketing",
  description: "Can use core marketing and offer-design skills",
  access: {
    skills: [
      globalSkill("marketing"),
      globalSkill("copy-engineering"),
      globalSkill("brand-positioning"),
      globalSkill("persuasion-architecture"),
      globalSkill("offer-architecture"),
      globalSkill("subscription-wedge"),
    ],
  },
});

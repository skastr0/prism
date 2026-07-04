import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
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
} satisfies TraitSource;

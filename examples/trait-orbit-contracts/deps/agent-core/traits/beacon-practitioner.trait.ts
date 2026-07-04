import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
  name: "beacon-practitioner",
  description: "Can use Beacon method skills for marketing orbit work",
  access: {
    skills: [
      globalSkill("beacon"),
      globalSkill("marketing"),
      globalSkill("copy-engineering"),
      globalSkill("brand-positioning"),
      globalSkill("persuasion-architecture"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
} satisfies TraitSource;

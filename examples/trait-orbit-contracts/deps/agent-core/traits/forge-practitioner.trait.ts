import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
  name: "forge-practitioner",
  description: "Can use Forge method skills for software delivery work",
  access: {
    skills: [
      globalSkill("forge"),
      globalSkill("requirements"),
      globalSkill("build"),
      globalSkill("review"),
      globalSkill("commit"),
      globalSkill("testing"),
      globalSkill("evolve"),
      globalSkill("backpressure"),
    ],
  },
} satisfies TraitSource;

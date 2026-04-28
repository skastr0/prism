import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "functional-thinking",
  description: "Can use functional and type-level modeling skills",
  access: {
    skills: [
      globalSkill("effect"),
      globalSkill("type-level"),
      globalSkill("ddd"),
      globalSkill("contracts"),
      globalSkill("testing"),
    ],
  },
});

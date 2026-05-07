import { defineTrait, skillspaceRef } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "survey-practitioner",
  description: "Can use Survey method skills for research orbit work",
  access: {
    skills: [
      globalSkill("survey"),
      globalSkill("research"),
      globalSkill("web-research"),
      globalSkill("repo-research"),
      globalSkill("model-intelligence"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
});

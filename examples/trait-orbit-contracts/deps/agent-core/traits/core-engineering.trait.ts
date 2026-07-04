import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
  name: "core-engineering",
  description: "Can use core engineering skills for implementation and review",
  access: {
    skills: [
      globalSkill("build"),
      globalSkill("code-reviewer"),
      globalSkill("testing"),
      globalSkill("contracts"),
      globalSkill("harness-programming"),
      globalSkill("repo-research"),
      globalSkill("security-reviewer"),
      globalSkill("semgrep-usage"),
      globalSkill("ast-grep"),
      globalSkill("unslop"),
    ],
  },
} satisfies TraitSource;

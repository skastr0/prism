import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
  name: "research-practice",
  description: "Can use research and source-discovery skills",
  access: {
    skills: [
      globalSkill("research"),
      globalSkill("web-research"),
      globalSkill("repo-research"),
      globalSkill("video-research"),
      globalSkill("model-intelligence"),
    ],
  },
} satisfies TraitSource;

import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
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
});

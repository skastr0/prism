import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "writing-and-publishing",
  description: "Can use writing, voice, and social publishing skills",
  access: {
    skills: [
      globalSkill("wlc"),
      globalSkill("voice-profile"),
      globalSkill("copy-engineering"),
      globalSkill("content-mining"),
      globalSkill("platform-twitter"),
      globalSkill("typefully-cli"),
    ],
  },
});

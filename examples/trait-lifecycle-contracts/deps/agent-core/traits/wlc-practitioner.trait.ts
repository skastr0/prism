import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "wlc-practitioner",
  description: "Can use WLC method skills for writing lifecycle work",
  access: {
    skills: [
      globalSkill("wlc"),
      globalSkill("voice-profile"),
      globalSkill("copy-engineering"),
      globalSkill("content-mining"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
});

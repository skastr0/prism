import { skillspaceRef, type TraitSource } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default {
  name: "writing-and-publishing",
  description: "Can use writing, voice, and social publishing skills",
  access: {
    skills: [
      globalSkill("scribe"),
      globalSkill("voice-profile"),
      globalSkill("copy-engineering"),
      globalSkill("content-mining"),
      globalSkill("platform-twitter"),
      globalSkill("typefully-cli"),
    ],
  },
} satisfies TraitSource;

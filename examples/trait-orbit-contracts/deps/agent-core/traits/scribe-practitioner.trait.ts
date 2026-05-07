import { defineTrait, skillspaceRef } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "scribe-practitioner",
  description: "Can use Scribe method skills for writing orbit work",
  access: {
    skills: [
      globalSkill("scribe"),
      globalSkill("voice-profile"),
      globalSkill("copy-engineering"),
      globalSkill("content-mining"),
      globalSkill("review"),
      globalSkill("evolve"),
    ],
  },
});

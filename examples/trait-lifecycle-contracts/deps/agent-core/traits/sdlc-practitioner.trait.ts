import { defineTrait, skillspaceRef } from "agentpkg";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "sdlc-practitioner",
  description: "Can use SDLC method skills for software delivery work",
  access: {
    skills: [
      globalSkill("sdlc"),
      globalSkill("requirements"),
      globalSkill("build"),
      globalSkill("review"),
      globalSkill("commit"),
      globalSkill("testing"),
      globalSkill("evolve"),
      globalSkill("backpressure"),
    ],
  },
});

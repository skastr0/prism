import { defineTrait, skillspaceRef } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "media-generation-practice",
  description: "Can use media-generation workflow and model-selection skills",
  access: {
    skills: [
      globalSkill("media-generation"),
      globalSkill("fal-models"),
      globalSkill("mg-schema"),
      globalSkill("mg-workflow-authoring"),
      globalSkill("mg-3d-workflow-authoring"),
      globalSkill("suno-music-prompting"),
      globalSkill("video-research"),
    ],
  },
});

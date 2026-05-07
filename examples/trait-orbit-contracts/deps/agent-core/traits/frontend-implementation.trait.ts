import { defineTrait, skillspaceRef } from "prism";

const globalSkill = (name: string) => skillspaceRef("agent-core", "global-skills", name);

export default defineTrait({
  name: "frontend-implementation",
  description: "Can use frontend implementation and product UI skills",
  access: {
    skills: [
      globalSkill("frontend-design"),
      globalSkill("build"),
      globalSkill("testing"),
      globalSkill("legend-state"),
      globalSkill("vercel-react-native-skills"),
    ],
  },
});

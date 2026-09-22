import { join } from "node:path";

export const prismWorkflowAuthoringDir = (prismHome: string): string =>
  join(prismHome, "runtime", "workflow-authoring");

export const prismWorkflowAuthoringSkillPath = (prismHome: string): string =>
  join(prismWorkflowAuthoringDir(prismHome), "SKILL.md");

export const prismWorkflowModelsSkillPath = (prismHome: string): string =>
  join(prismWorkflowAuthoringDir(prismHome), "models", "SKILL.md");

/**
 * Compose phase: take a ResolvedAgent and produce a target-agnostic
 * ComposedAgent for the lowerers.
 */

import type {
  Lifecycle,
  NormalizedLifecyclePhase as LifecyclePhase,
} from "./sources.js";
import type { ResolvedAgent, ResolvedContractBinding } from "./resolve.js";

export interface ComposedAgent {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly color: string | undefined;
  readonly model: Record<string, unknown> | undefined;
  readonly targetOverride: Record<string, unknown>;
  readonly skills: ReadonlyArray<string>;
  readonly allowedSkills: ReadonlyArray<string>;
  readonly toolBindings: ReadonlyArray<ResolvedContractBinding>;
  readonly allowedTools: ReadonlyArray<string>;
}

export interface ComposedLifecyclePhaseReference {
  readonly label: string;
  readonly detailLines: ReadonlyArray<string>;
}

const renderPersonalitySection = (resolved: ResolvedAgent): string | undefined => {
  const personality = resolved.personality;
  if (!personality) return undefined;

  const lines: string[] = ["## Personality", ""];
  if (personality.temperament) lines.push(`- **Temperament**: ${personality.temperament}`);
  if (personality.orientation) lines.push(`- **Orientation**: ${personality.orientation}`);
  if (personality.virtues) lines.push(`- **Virtues**: ${personality.virtues}`);
  if (personality.integration) lines.push(`- **Integration**: ${personality.integration}`);
  if (personality.communication) lines.push(`- **Communication**: ${personality.communication}`);

  if (personality.body.length > 0) {
    lines.push("", personality.body);
  }

  return lines.join("\n");
};

const renderSkillsSection = (resolved: ResolvedAgent): string | undefined => {
  if (resolved.skills.length === 0) return undefined;
  const lines: string[] = [
    "## Recommended Skills",
    "",
    "Load when the work calls for them:",
    "",
  ];
  for (const skill of resolved.skills) {
    lines.push(`- \`${skill}\``);
  }
  return lines.join("\n");
};

const renderTraitInstructionsSection = (resolved: ResolvedAgent): string | undefined => {
  const instructionBlocks = resolved.traits
    .map((trait) => ({
      name: trait.trait.name,
      instructions: trait.trait.instructions,
    }))
    .filter((trait) => trait.instructions.length > 0);

  if (instructionBlocks.length === 0) return undefined;

  const lines: string[] = ["## Trait Instructions"];
  for (const trait of instructionBlocks) {
    lines.push("", `### ${trait.name}`, "");
    lines.push(...trait.instructions);
  }

  return lines.join("\n");
};

const splitTitleAndBody = (body: string): { title: string; rest: string } => {
  const lines = body.split("\n");
  if (lines.length === 0 || !lines[0]!.startsWith("# ")) {
    return { title: "", rest: body };
  }
  let index = 1;
  while (index < lines.length && lines[index]!.trim() === "") index++;
  const title = lines.slice(0, index).join("\n").trimEnd();
  const rest = lines.slice(index).join("\n").trimStart();
  return { title, rest };
};

export const composeAgent = (resolved: ResolvedAgent): ComposedAgent => {
  const { title, rest } = splitTitleAndBody(resolved.identity.body);

  const sections: string[] = [];
  if (title) sections.push(title);

  const personality = renderPersonalitySection(resolved);
  if (personality) sections.push(personality);

  if (rest) sections.push(rest);

  const skills = renderSkillsSection(resolved);
  if (skills) sections.push(skills);

  const traitInstructions = renderTraitInstructionsSection(resolved);
  if (traitInstructions) sections.push(traitInstructions);

  const body = sections.filter((section) => section.length > 0).join("\n\n");

  return {
    name: resolved.agent.name,
    description: resolved.agent.description,
    body,
    color: resolved.agent.color,
    model: resolved.resolvedModel,
    targetOverride: (resolved.agent.targets as Record<string, unknown>) || {},
    skills: resolved.skills,
    allowedSkills: resolved.allowedSkills,
    toolBindings: resolved.toolBindings,
    allowedTools: resolved.allowedTools,
  };
};

export const composeLifecycleOrchestratorSection = (
  lifecycle: Lifecycle,
): ReadonlyArray<string> => {
  if (!lifecycle.orchestrator) return [];
  const lines: string[] = ["## Orchestrator", ""];
  lines.push(
    `The orchestrator agent for this lifecycle is \`${lifecycle.orchestrator.agent}\`. It owns work-item state transitions and signal handling, and is not a phase agent.`,
  );
  if (lifecycle.orchestrator.tools.length > 0) {
    lines.push("", "Orchestrator-only tools:", "");
    for (const tool of lifecycle.orchestrator.tools) {
      lines.push(`- \`${tool.logicalName}\` (canonical \`${tool.ref}\`)`);
    }
  }
  return lines;
};

export const composeLifecycleWideToolsSection = (
  lifecycle: Lifecycle,
): ReadonlyArray<string> => {
  if (lifecycle.tool_permissions.length === 0) return [];
  const lines: string[] = [
    "## Tools available to every phase agent",
    "",
    "These tools are granted to every phase agent of this lifecycle:",
    "",
  ];
  for (const tool of lifecycle.tool_permissions) {
    lines.push(`- \`${tool.logicalName}\` (canonical \`${tool.ref}\`)`);
  }
  return lines;
};

export const composeLifecyclePhaseReference = (
  phase: LifecyclePhase,
): ComposedLifecyclePhaseReference => {
  if (phase.lifecycle_binding) {
    const bindings = Object.entries(phase.lifecycle_binding.bindings ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `\`${name}=${value}\``);

    return {
      label: `lifecycle \`${phase.lifecycle_binding.lifecycle}\``,
      detailLines:
        bindings.length > 0 ? [`- **Bindings**: ${bindings.join(", ")}`] : [],
    };
  }

  if (phase.lifecycle) {
    return {
      label: `lifecycle \`${phase.lifecycle}\``,
      detailLines: [],
    };
  }

  if (phase.agents.length === 1) {
    return {
      label: `agent \`${phase.agents[0]}\``,
      detailLines: [],
    };
  }

  if (phase.agents.length > 1) {
    return {
      label: `agents ${phase.agents.map((agent) => `\`${agent}\``).join(", ")}`,
      detailLines: [],
    };
  }

  return {
    label: "(no reference)",
    detailLines: [],
  };
};

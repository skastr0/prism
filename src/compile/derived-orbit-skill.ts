/**
 * Derived orbit skill rendering.
 *
 * Harness lowerers each emit a SKILL.md per concrete orbit. The structured
 * content of that SKILL.md is identical across harnesses; only the frontmatter
 * format varies. This module owns the structured body so all lowerers stay
 * aligned.
 *
 * The body is composed from data the compiler already resolved: the orbit
 * itself, the agents assigned to its phases, their identities, and
 * personalities. Hand-authored prose lives in `orbit.body` for
 * content that is genuinely free-form.
 */

import { composeOrbitPhaseReference } from "./compose.js";
import { parseNamedRef, registryForRef } from "./refs.js";
import type {
  Agent,
  Orbit,
  OrbitDefinitionEntry,
  NormalizedOrbitPhase as OrbitPhase,
  Personality,
} from "./sources.js";
import type { PluginRegistry } from "./registry.js";

const lookupRegistry = (
  ref: string,
  current: PluginRegistry,
): PluginRegistry | undefined => {
  return registryForRef(ref, current);
};

const lookupAgent = (
  ref: string,
  registry: PluginRegistry,
): { agent: Agent; registry: PluginRegistry } | undefined => {
  const reg = lookupRegistry(ref, registry);
  if (!reg) return undefined;
  const name = parseNamedRef(ref).name;
  const agent = reg.agents.get(name);
  if (!agent) return undefined;
  return { agent, registry: reg };
};

const lookupPersonality = (
  ref: string,
  registry: PluginRegistry,
): Personality | undefined => {
  const reg = lookupRegistry(ref, registry);
  if (!reg) return undefined;
  const name = parseNamedRef(ref).name;
  return reg.personalities.get(name);
};

const sortStrings = (values: ReadonlyArray<string>): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const sectionHeader = (level: number, text: string): string =>
  `${"#".repeat(level)} ${text}`;

const personalityLine = (personality: Personality): string => {
  const description = personality.description.replace(/\.+$/, "");
  return `**Personality**: \`${personality.name}\` — ${description}.`;
};

interface PhaseAgentView {
  readonly ref: string;
  readonly agent: Agent;
  readonly registry: PluginRegistry;
  readonly personality: Personality | undefined;
}

const collectPhaseAgents = (
  phase: OrbitPhase,
  registry: PluginRegistry,
): PhaseAgentView[] => {
  const views: PhaseAgentView[] = [];
  for (const ref of phase.agents) {
    const found = lookupAgent(ref, registry);
    if (!found) continue;
    const personality = found.agent.personality
      ? lookupPersonality(found.agent.personality, found.registry)
      : undefined;
    views.push({
      ref,
      agent: found.agent,
      registry: found.registry,
      personality,
    });
  }
  return views;
};

const orchestratorAgentView = (
  orbit: Orbit,
  registry: PluginRegistry,
): PhaseAgentView | undefined => {
  if (!orbit.orchestrator) return undefined;
  const ref = orbit.orchestrator.agent;
  const found = lookupAgent(ref, registry);
  if (!found) return undefined;
  const personality = found.agent.personality
    ? lookupPersonality(found.agent.personality, found.registry)
    : undefined;
  return { ref, agent: found.agent, registry: found.registry, personality };
};

const renderAgentSubsection = (
  view: PhaseAgentView,
  level: number,
  lines: string[],
): void => {
  lines.push(sectionHeader(level, `Agent \`${view.agent.name}\``), "");
  if (view.agent.description) {
    lines.push(view.agent.description, "");
  }

  if (view.personality) {
    lines.push(personalityLine(view.personality));
    lines.push("");
  }
};

const hasWorkflow = (phase: OrbitPhase): boolean => {
  const workflow = phase.workflow;
  if (!workflow) return false;
  return (
    Boolean(workflow.when) ||
    Boolean(workflow.coordination) ||
    Boolean(workflow.escalation) ||
    (workflow.inputs?.length ?? 0) > 0 ||
    (workflow.outputs?.length ?? 0) > 0 ||
    (workflow.sequence?.length ?? 0) > 0 ||
    (workflow.finish_criteria?.length ?? 0) > 0
  );
};

const renderInlineList = (values: ReadonlyArray<string>): string =>
  values.map((value) => value.trim()).filter(Boolean).join("; ");

const renderPhaseWorkflowSummary = (
  phase: OrbitPhase,
  lines: string[],
): void => {
  const workflow = phase.workflow;
  if (!workflow || !hasWorkflow(phase)) return;

  if (workflow.when) lines.push(`- **Workflow trigger**: ${workflow.when}`);
  if (workflow.inputs && workflow.inputs.length > 0) {
    lines.push(`- **Workflow inputs**: ${renderInlineList(workflow.inputs)}`);
  }
  if (workflow.outputs && workflow.outputs.length > 0) {
    lines.push(`- **Workflow outputs**: ${renderInlineList(workflow.outputs)}`);
  }
  if (workflow.sequence && workflow.sequence.length > 0) {
    lines.push(`- **Workflow sequence**: ${renderInlineList(workflow.sequence)}`);
  }
  if (workflow.coordination) {
    lines.push(`- **Workflow coordination**: ${workflow.coordination}`);
  }
  if (workflow.finish_criteria && workflow.finish_criteria.length > 0) {
    lines.push(
      `- **Workflow finish criteria**: ${renderInlineList(workflow.finish_criteria)}`,
    );
  }
  if (workflow.escalation) {
    lines.push(`- **Workflow escalation**: ${workflow.escalation}`);
  }
};

const renderPhasesSection = (
  orbit: Orbit,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (orbit.phases.length === 0) return;
  lines.push("## Phases", "");
  orbit.phases.forEach((phase, index) => {
    const reference = composeOrbitPhaseReference(phase);
    lines.push(`### ${index + 1}. ${phase.name} — ${reference.label}`, "");
    for (const detail of reference.detailLines) lines.push(detail);
    if (phase.telos) lines.push(`- **Telos**: ${phase.telos}`);
    if (phase.real_world_change) {
      lines.push(`- **Real-world change**: ${phase.real_world_change}`);
    }
    if (phase.cold_pickup_test) {
      lines.push(`- **Cold-pickup test**: ${phase.cold_pickup_test}`);
    }
    renderPhaseWorkflowSummary(phase, lines);
    if (phase.notes) {
      for (const [key, value] of Object.entries(phase.notes)) {
        lines.push(`- **${key}**: ${value}`);
      }
    }
    if ((phase.body && phase.body.trim().length > 0) || hasWorkflow(phase)) {
      lines.push(
        `- **Reference**: see \`references/${phase.name}.md\` for the full phase download.`,
      );
    }
    lines.push("");

    const phaseAgents = collectPhaseAgents(phase, registry);
    if (phaseAgents.length > 1) {
      lines.push(
        "Multiple agents may fulfil this phase. Pick the one whose identity and personality best match the work in front of you.",
        "",
      );
    }
    for (const view of phaseAgents) {
      renderAgentSubsection(view, 4, lines);
    }
  });
};

const renderOrchestratorSection = (
  orbit: Orbit,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (!orbit.orchestrator) return;
  const view = orchestratorAgentView(orbit, registry);

  lines.push("## Orchestrator", "");
  if (view) {
    lines.push(
      `The orchestrator agent for this orbit is \`${view.agent.name}\`. It owns work-item state transitions and signal handling, and is not a phase agent.`,
      "",
    );
    if (view.agent.description) {
      lines.push(view.agent.description, "");
    }
    if (view.personality) {
      lines.push(personalityLine(view.personality));
      lines.push("");
    }
  } else {
    // Fallback when the orchestrator agent is non-local (cross-plugin).
    lines.push(
      `The orchestrator agent for this orbit is \`${orbit.orchestrator.agent}\`.`,
      "",
    );
  }
};

const renderPhaseTransitionsSection = (
  orbit: Orbit,
  lines: string[],
): void => {
  if (orbit.phases.length === 0) return;
  lines.push("## Phase transitions", "");
  lines.push(
    "Orbit work moves through the phase sequence declared here. The orchestrator owns transitions when an orchestrator is declared; phase agents stay inside the current phase contract until their output lands.",
    "",
    "Use the phase workflow, telos, real-world change, and cold-pickup test to decide whether a phase is complete. Userland orbits may define stricter state names, queues, or artifact families in their own metadata and tools.",
    "",
    "Phase ownership of state transitions:",
    "",
  );
  for (const phase of orbit.phases) {
    if (phase.agents.length === 0) continue;
    const owners = sortStrings(phase.agents).map((agent) => `\`${agent}\``).join(", ");
    lines.push(`- **${phase.name}** — owned by ${owners}.`);
  }
  if (orbit.orchestrator) {
    lines.push(
      `- **Transitions, signal claim/consume, and work-item state mutations** — owned by orchestrator \`${orbit.orchestrator.agent}\`.`,
    );
  }
  lines.push("");
};

const renderProducesSection = (orbit: Orbit, lines: string[]): void => {
  if (!orbit.produces) return;
  lines.push("## Produces", "", orbit.produces, "");
};

const renderDefinitionEntry = (
  heading: string,
  role: OrbitDefinitionEntry | undefined,
  lines: string[],
): void => {
  if (!role) return;
  lines.push(`### ${heading}`, "", role.purpose, "");
  const sections: ReadonlyArray<[string, ReadonlyArray<string> | undefined]> = [
    ["Contains", role.contains],
    ["Boundaries", role.boundaries],
    ["Avoid", role.avoid],
  ];
  for (const [label, values] of sections) {
    if (!values || values.length === 0) continue;
    lines.push(`**${label}**`);
    for (const value of values) lines.push(`- ${value}`);
    lines.push("");
  }
};

const renderDefinitionsSection = (orbit: Orbit, lines: string[]): void => {
  if (!orbit.definitions) return;
  const { glyphs, dispatches, chatter, signals } = orbit.definitions;
  if (!glyphs && !dispatches && !chatter && !signals) return;
  lines.push("## Definitions", "");
  lines.push(
    "Use the active orbit's definitions to interpret glyphs, dispatches, chatter, and signals. IDs and board state are routing metadata; these definitions provide the orbit's vocabulary and boundaries.",
    "",
  );
  renderDefinitionEntry("Glyphs", glyphs, lines);
  renderDefinitionEntry("Dispatches", dispatches, lines);
  renderDefinitionEntry("Chatter", chatter, lines);
  renderDefinitionEntry("Signals", signals, lines);
};

const renderTasteCheckpointsSection = (orbit: Orbit, lines: string[]): void => {
  if (orbit.pulsar_checkpoints.length === 0) return;
  lines.push("## Pulsar Checkpoints", "");
  for (const checkpoint of orbit.pulsar_checkpoints) {
    const parts: string[] = [];
    if (checkpoint.after) parts.push(`after: ${checkpoint.after}`);
    if (checkpoint.before) parts.push(`before: ${checkpoint.before}`);
    if (checkpoint.note) parts.push(`note: ${checkpoint.note}`);
    lines.push(`- ${parts.join(" — ")}`);
  }
  lines.push("");
};

const renderEvolutionSection = (orbit: Orbit, lines: string[]): void => {
  if (!orbit.evolution) return;
  lines.push("## Evolution", "", orbit.evolution.trim(), "");
};

const renderBodySection = (orbit: Orbit, lines: string[]): void => {
  const trimmed = orbit.body.trim();
  if (trimmed.length === 0) return;
  lines.push(trimmed, "");
};

const renderParametricStub = (orbit: Orbit, lines: string[]): void => {
  lines.push(
    "_This orbit is parameterized and remains a template until another orbit binds it. The derived skill content above describes the abstract shape; concrete behaviour appears only in instantiated orbits._",
    "",
  );
};

/**
 * Render the body of a orbit SKILL.md from a resolved orbit and the
 * compiler registry.
 *
 * The output starts with `# <name>` and the description and ends with the
 * free-form body content (when present). Frontmatter is the lowerer's
 * responsibility.
 */
export const renderDerivedOrbitSkillBody = (
  orbit: Orbit,
  registry: PluginRegistry,
): string => {
  const lines: string[] = [];
  lines.push(`# ${orbit.name}`, "");
  lines.push(orbit.description, "");
  lines.push(
    "_Runtime-facing lowering of a concrete orbit. This skill is derived from the agents wired into the orbit definition; treat it as the authoritative orchestration surface._",
    "",
  );

  if (orbit.parameters.length > 0) {
    renderParametricStub(orbit, lines);
  }

  renderProducesSection(orbit, lines);
  renderDefinitionsSection(orbit, lines);
  renderOrchestratorSection(orbit, registry, lines);
  renderPhasesSection(orbit, registry, lines);
  renderPhaseTransitionsSection(orbit, lines);
  renderTasteCheckpointsSection(orbit, lines);
  renderEvolutionSection(orbit, lines);
  renderBodySection(orbit, lines);

  return lines.join("\n");
};

export interface OrbitPhaseReferenceFile {
  /** Filename relative to the orbit's `references/` folder, e.g., `build.md`. */
  readonly filename: string;
  /** Markdown body of the reference file. */
  readonly content: string;
}

const renderWorkflowReferenceSection = (
  phase: OrbitPhase,
  lines: string[],
): void => {
  const workflow = phase.workflow;
  if (!workflow || !hasWorkflow(phase)) return;

  lines.push("## Workflow", "");
  if (workflow.when) lines.push("### When to use this workflow", "", workflow.when.trim(), "");
  const listSections: ReadonlyArray<[string, ReadonlyArray<string> | undefined]> = [
    ["Inputs", workflow.inputs],
    ["Outputs", workflow.outputs],
    ["Sequence", workflow.sequence],
    ["Finish criteria", workflow.finish_criteria],
  ];
  for (const [heading, values] of listSections) {
    if (!values || values.length === 0) continue;
    lines.push(`### ${heading}`, "");
    for (const value of values) lines.push(`- ${value}`);
    lines.push("");
  }
  if (workflow.coordination) {
    lines.push("### Coordination", "", workflow.coordination.trim(), "");
  }
  if (workflow.escalation) {
    lines.push("### Escalation", "", workflow.escalation.trim(), "");
  }
};

/**
 * Render reference files for orbit phases that declare a `body` or workflow.
 * Each file
 * lands at `<orbit-skill-folder>/references/<phase-name>.md` and carries the
 * full per-phase download (telos, real-world change, cold-pickup test,
 * workflow, then the hand-authored body). Phases without body or workflow
 * produce nothing.
 */
export const renderDerivedOrbitPhaseReferences = (
  orbit: Orbit,
): ReadonlyArray<OrbitPhaseReferenceFile> => {
  const files: OrbitPhaseReferenceFile[] = [];
  for (const phase of orbit.phases) {
    const hasBody = Boolean(phase.body && phase.body.trim().length > 0);
    if (!hasBody && !hasWorkflow(phase)) continue;

    const lines: string[] = [];
    lines.push(`# ${orbit.name}:${phase.name}`, "");
    lines.push(
      `_Phase reference for the **${phase.name}** phase of the **${orbit.name}** orbit. The orbit SKILL.md carries the cross-phase frame; this file is the full download for this phase specifically._`,
      "",
    );
    if (phase.telos) lines.push("## Telos", "", phase.telos.trim(), "");
    if (phase.real_world_change) {
      lines.push(
        "## Real-world change",
        "",
        phase.real_world_change.trim(),
        "",
      );
    }
    if (phase.cold_pickup_test) {
      lines.push(
        "## Cold-pickup test",
        "",
        phase.cold_pickup_test.trim(),
        "",
      );
    }
    renderWorkflowReferenceSection(phase, lines);
    if (hasBody) lines.push(phase.body!.trim(), "");

    files.push({
      filename: `${phase.name}.md`,
      content: lines.join("\n"),
    });
  }
  return files;
};

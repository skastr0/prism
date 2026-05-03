/**
 * Derived lifecycle skill rendering.
 *
 * The four harness lowerers each emit a SKILL.md per concrete lifecycle. The
 * structured content of that SKILL.md is identical across harnesses; only the
 * frontmatter format and owner-marker comment vary. This module owns the
 * structured body so all four lowerers stay aligned.
 *
 * The body is composed from data the compiler already resolved: the lifecycle
 * itself, the agents assigned to its phases, their identities, personalities,
 * traits, and tools. Hand-authored prose lives in `lifecycle.body` for
 * content that is genuinely free-form.
 */

import { composeLifecyclePhaseReference } from "./compose.js";
import type {
  Agent,
  CanonicalTool,
  Identity,
  Lifecycle,
  NormalizedLifecyclePhase as LifecyclePhase,
  Personality,
  Trait,
} from "./sources.js";
import type { PluginRegistry } from "./registry.js";

interface ParsedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

const parseNamedRef = (ref: string): ParsedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

const parseToolRef = (
  ref: string,
): { plugin: string | undefined; toolspace: string | undefined; name: string } => {
  const parsed = parseNamedRef(ref);
  const slash = parsed.name.indexOf("/");
  if (slash === -1) return { plugin: parsed.pluginPrefix, toolspace: undefined, name: parsed.name };
  return {
    plugin: parsed.pluginPrefix,
    toolspace: parsed.name.slice(0, slash),
    name: parsed.name.slice(slash + 1),
  };
};

const lookupRegistry = (
  ref: string,
  current: PluginRegistry,
): PluginRegistry | undefined => {
  const parsed = parseNamedRef(ref);
  if (!parsed.pluginPrefix) return current;
  return current.deps.get(parsed.pluginPrefix);
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

const lookupIdentity = (
  ref: string,
  registry: PluginRegistry,
): Identity | undefined => {
  const reg = lookupRegistry(ref, registry);
  if (!reg) return undefined;
  const name = parseNamedRef(ref).name;
  return reg.identities.get(name);
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

interface ResolvedTraitView {
  readonly canonicalId: string;
  readonly trait: Trait;
}

const lookupTrait = (
  ref: string,
  registry: PluginRegistry,
): ResolvedTraitView | undefined => {
  const reg = lookupRegistry(ref, registry);
  if (!reg) return undefined;
  const name = parseNamedRef(ref).name;
  const trait = reg.traits.get(name);
  if (!trait) return undefined;
  return { canonicalId: `${reg.pluginName}:${trait.name}`, trait };
};

const lookupCanonicalTool = (
  ref: string,
  registry: PluginRegistry,
): CanonicalTool | undefined => {
  const parsed = parseToolRef(ref);
  // Bare canonical tool refs come in two shapes:
  //   - "plugin:tool" (CanonicalTool keyed by tool name)
  //   - "plugin:toolspace/tool"
  // We only render the canonical tool's description/input shape, which lives
  // in registry.tools keyed by the tool name. Walk through deps when needed.
  const candidateRegistries: PluginRegistry[] = [];
  if (parsed.plugin) {
    const dep = registry.deps.get(parsed.plugin);
    if (dep) candidateRegistries.push(dep);
  } else {
    candidateRegistries.push(registry);
  }
  // toolspace form not directly supported here — those are toolspace tools
  // (target-bound), not canonical tools. Bare names look up tools map.
  for (const reg of candidateRegistries) {
    const tool = reg.tools.get(parsed.name);
    if (tool) return tool;
  }
  return undefined;
};

const inputShapeSummary = (tool: CanonicalTool | undefined): string | undefined => {
  if (!tool) return undefined;
  // Effect Schema instances expose `.ast` and `_tag`; we don't try to render
  // the structural detail. The presence of an input schema is enough signal
  // that a tool takes structured input.
  if (tool.input === undefined) return undefined;
  return "Structured input — see canonical tool schema for fields.";
};

const sortStrings = (values: ReadonlyArray<string>): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const renderToolDetail = (
  ref: string,
  logicalName: string,
  registry: PluginRegistry,
): string[] => {
  const lines: string[] = [];
  const tool = lookupCanonicalTool(ref, registry);
  const description = tool?.description;
  const inputHint = inputShapeSummary(tool);
  const head = `- \`${logicalName}\` (canonical \`${ref}\`)${description ? ` — ${description}` : ""}`;
  lines.push(head);
  if (inputHint) {
    lines.push(`  - Input: ${inputHint}`);
  }
  return lines;
};

const sectionHeader = (level: number, text: string): string =>
  `${"#".repeat(level)} ${text}`;

interface PhaseAgentView {
  readonly ref: string;
  readonly agent: Agent;
  readonly registry: PluginRegistry;
  readonly identity: Identity | undefined;
  readonly personality: Personality | undefined;
  readonly traits: ReadonlyArray<ResolvedTraitView>;
}

const collectPhaseAgents = (
  phase: LifecyclePhase,
  registry: PluginRegistry,
): PhaseAgentView[] => {
  const views: PhaseAgentView[] = [];
  for (const ref of phase.agents) {
    const found = lookupAgent(ref, registry);
    if (!found) continue;
    const identity = lookupIdentity(found.agent.identity, found.registry);
    const personality = found.agent.personality
      ? lookupPersonality(found.agent.personality, found.registry)
      : undefined;
    const traits: ResolvedTraitView[] = [];
    for (const binding of found.agent.traits) {
      const view = lookupTrait(binding.ref, found.registry);
      if (view) traits.push(view);
    }
    views.push({
      ref,
      agent: found.agent,
      registry: found.registry,
      identity,
      personality,
      traits,
    });
  }
  return views;
};

const orchestratorAgentView = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): PhaseAgentView | undefined => {
  if (!lifecycle.orchestrator) return undefined;
  const ref = lifecycle.orchestrator.agent;
  const found = lookupAgent(ref, registry);
  if (!found) return undefined;
  const identity = lookupIdentity(found.agent.identity, found.registry);
  const personality = found.agent.personality
    ? lookupPersonality(found.agent.personality, found.registry)
    : undefined;
  const traits: ResolvedTraitView[] = [];
  for (const binding of found.agent.traits) {
    const view = lookupTrait(binding.ref, found.registry);
    if (view) traits.push(view);
  }
  return { ref, agent: found.agent, registry: found.registry, identity, personality, traits };
};

const personalityGloss = (personality: Personality | undefined): string | undefined => {
  if (!personality) return undefined;
  const parts: string[] = [];
  if (personality.temperament) parts.push(`temperament ${personality.temperament}`);
  if (personality.orientation) parts.push(`orientation ${personality.orientation}`);
  if (personality.virtues) parts.push(`virtues ${personality.virtues}`);
  if (parts.length === 0) return undefined;
  return parts.join("; ");
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
    const gloss = personalityGloss(view.personality);
    lines.push(
      gloss
        ? `**Personality**: \`${view.personality.name}\` — ${view.personality.description}; ${gloss}.`
        : `**Personality**: \`${view.personality.name}\` — ${view.personality.description}.`,
    );
    lines.push("");
  }

  if (view.identity?.description) {
    lines.push(`**Identity**: ${view.identity.description}`);
    lines.push("");
  }

  if (view.traits.length > 0) {
    const traitNames = sortStrings(view.traits.map((trait) => trait.canonicalId));
    lines.push(
      `**Traits**: ${traitNames.map((name) => `\`${name}\``).join(", ")}.`,
    );
    lines.push("");
  }
};

const renderPhasesSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (lifecycle.phases.length === 0) return;
  lines.push("## Phases", "");
  lifecycle.phases.forEach((phase, index) => {
    const reference = composeLifecyclePhaseReference(phase);
    lines.push(`### ${index + 1}. ${phase.name} — ${reference.label}`, "");
    for (const detail of reference.detailLines) lines.push(detail);
    if (phase.notes) {
      for (const [key, value] of Object.entries(phase.notes)) {
        lines.push(`- **${key}**: ${value}`);
      }
      lines.push("");
    } else {
      lines.push("");
    }

    const phaseAgents = collectPhaseAgents(phase, registry);
    if (phaseAgents.length > 1) {
      lines.push(
        "Multiple agents may fulfil this phase. Pick the one whose identity and traits best match the work in front of you.",
        "",
      );
    }
    for (const view of phaseAgents) {
      renderAgentSubsection(view, 4, lines);
    }
  });
};

const renderOrchestratorSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (!lifecycle.orchestrator) return;
  const view = orchestratorAgentView(lifecycle, registry);

  lines.push("## Orchestrator", "");
  if (view) {
    lines.push(
      `The orchestrator agent for this lifecycle is \`${view.agent.name}\`. It owns work-item state transitions and signal handling, and is not a phase agent.`,
      "",
    );
    if (view.agent.description) {
      lines.push(view.agent.description, "");
    }
    if (view.personality) {
      const gloss = personalityGloss(view.personality);
      lines.push(
        gloss
          ? `**Personality**: \`${view.personality.name}\` — ${view.personality.description}; ${gloss}.`
          : `**Personality**: \`${view.personality.name}\` — ${view.personality.description}.`,
      );
      lines.push("");
    }
    if (view.identity?.description) {
      lines.push(`**Identity**: ${view.identity.description}`);
      lines.push("");
    }
    if (view.traits.length > 0) {
      const traitNames = sortStrings(view.traits.map((trait) => trait.canonicalId));
      lines.push(
        `**Traits**: ${traitNames.map((name) => `\`${name}\``).join(", ")}.`,
      );
      lines.push("");
    }
  } else {
    // Fallback when the orchestrator agent is non-local (cross-plugin).
    lines.push(
      `The orchestrator agent for this lifecycle is \`${lifecycle.orchestrator.agent}\`.`,
      "",
    );
  }

  if (lifecycle.orchestrator.tools.length > 0) {
    lines.push("Orchestrator-only tools:", "");
    for (const tool of lifecycle.orchestrator.tools) {
      lines.push(...renderToolDetail(tool.ref, tool.logicalName, registry));
    }
    lines.push("");
  }
};

const renderWideToolsSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (lifecycle.tool_permissions.length === 0) return;
  lines.push(
    "## Tools available to every phase agent",
    "",
    "These tools are granted to every phase agent of this lifecycle:",
    "",
  );
  for (const tool of lifecycle.tool_permissions) {
    lines.push(...renderToolDetail(tool.ref, tool.logicalName, registry));
  }
  lines.push("");
};

interface SubmissionEntry {
  readonly agentName: string;
  readonly toolLogicalName: string;
  readonly toolRef: string;
  readonly description: string | undefined;
  readonly slotFills: ReadonlyArray<{ slot: string; via: string }>;
}

const collectSubmissionEntries = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): SubmissionEntry[] => {
  const entries: SubmissionEntry[] = [];
  const seen = new Set<string>();
  for (const phase of lifecycle.phases) {
    for (const ref of phase.agents) {
      const found = lookupAgent(ref, registry);
      if (!found) continue;
      for (const binding of found.agent.traits) {
        const trait = lookupTrait(binding.ref, found.registry);
        if (!trait) continue;
        for (const [logicalName, attachment] of Object.entries(trait.trait.tools)) {
          const fills = Object.entries(binding.tools ?? {})
            .filter(([key]) => key === logicalName)
            .flatMap(([_, value]) =>
              Object.entries(value.slots ?? {}).map(([slot, schema]) => ({
                slot,
                via: schema.source.exportName,
              })),
            );
          const tool = lookupCanonicalTool(attachment.ref, found.registry);
          const key = `${found.agent.name}::${logicalName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({
            agentName: found.agent.name,
            toolLogicalName: logicalName,
            toolRef: attachment.ref,
            description: tool?.description,
            slotFills: fills,
          });
        }
      }
    }
  }
  return entries.sort((left, right) => {
    const a = `${left.agentName}::${left.toolLogicalName}`;
    const b = `${right.agentName}::${right.toolLogicalName}`;
    return a.localeCompare(b);
  });
};

const renderSubmissionProtocolsSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  const entries = collectSubmissionEntries(lifecycle, registry);
  if (entries.length === 0) return;
  lines.push("## Submission protocol per phase agent", "");
  lines.push(
    "Each phase agent submits work via a packet tool that the lifecycle relies on:",
    "",
  );
  for (const entry of entries) {
    const head = `- \`${entry.agentName}\` → \`${entry.toolLogicalName}\` (canonical \`${entry.toolRef}\`)${entry.description ? ` — ${entry.description}` : ""}`;
    lines.push(head);
    if (entry.slotFills.length > 0) {
      for (const fill of entry.slotFills) {
        lines.push(`  - Fills slot \`${fill.slot}\` with schema \`${fill.via}\`.`);
      }
    }
  }
  lines.push("");
};

const collectAllTraits = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): Map<string, Trait> => {
  const byCanonicalId = new Map<string, Trait>();
  const visit = (agentRef: string): void => {
    const found = lookupAgent(agentRef, registry);
    if (!found) return;
    for (const binding of found.agent.traits) {
      const trait = lookupTrait(binding.ref, found.registry);
      if (!trait) continue;
      if (!byCanonicalId.has(trait.canonicalId)) {
        byCanonicalId.set(trait.canonicalId, trait.trait);
      }
    }
  };
  for (const phase of lifecycle.phases) {
    for (const ref of phase.agents) visit(ref);
  }
  if (lifecycle.orchestrator) visit(lifecycle.orchestrator.agent);
  return byCanonicalId;
};

const renderTraitProtocolsSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  const traits = collectAllTraits(lifecycle, registry);
  if (traits.size === 0) return;
  const sorted = [...traits.entries()].sort(([left], [right]) => left.localeCompare(right));
  lines.push("## Trait protocols active in this lifecycle", "");
  lines.push(
    "Every assigned agent carries one or more traits. Each trait below names its protocol once; the agent sub-sections above reference these by canonical id.",
    "",
  );
  for (const [canonicalId, trait] of sorted) {
    lines.push(`### \`${canonicalId}\``, "");
    if (trait.description) {
      lines.push(trait.description, "");
    }
    if (trait.instructions.length > 0) {
      for (const instruction of trait.instructions) {
        lines.push(`- ${instruction}`);
      }
      lines.push("");
    }
  }
};

const renderPhaseTransitionsSection = (
  lifecycle: Lifecycle,
  lines: string[],
): void => {
  if (lifecycle.phases.length === 0) return;
  lines.push("## Phase transitions", "");
  lines.push(
    "Lifecycle work items move through canonical states. The orchestrator owns transitions; phase agents stay inside their phase folder until their submission lands.",
    "",
    "Common state arc: `backlog/` → `exploring/` → `committed/` → `building/` → `reviewing/` → `done/` (or `abandoned/`). Lifecycles with domain-specific build folders (e.g. WLC's `drafting/`) substitute the build state.",
    "",
    "Phase ownership of state transitions:",
    "",
  );
  for (const phase of lifecycle.phases) {
    if (phase.agents.length === 0) continue;
    const owners = sortStrings(phase.agents).map((agent) => `\`${agent}\``).join(", ");
    lines.push(`- **${phase.name}** — owned by ${owners}.`);
  }
  if (lifecycle.orchestrator) {
    lines.push(
      `- **Transitions, signal claim/consume, and work-item state mutations** — owned by orchestrator \`${lifecycle.orchestrator.agent}\`.`,
    );
  }
  lines.push("");
};

const renderClosureDisciplineSection = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
  lines: string[],
): void => {
  const traits = collectAllTraits(lifecycle, registry);
  // Look for a `committable` trait — its instructions describe closure discipline.
  let committable: Trait | undefined;
  for (const [canonicalId, trait] of traits) {
    if (canonicalId.endsWith(":committable")) {
      committable = trait;
      break;
    }
  }
  if (!committable) return;
  lines.push("## Closure discipline", "");
  lines.push(
    `The \`committable\` trait governs how each phase agent closes work before transitioning. Its protocol applies to every agent that carries it in this lifecycle:`,
    "",
  );
  if (committable.description) {
    lines.push(committable.description, "");
  }
  if (committable.instructions.length > 0) {
    for (const instruction of committable.instructions) {
      lines.push(`- ${instruction}`);
    }
    lines.push("");
  }
};

const renderProducesSection = (lifecycle: Lifecycle, lines: string[]): void => {
  if (!lifecycle.produces) return;
  lines.push("## Produces", "", lifecycle.produces, "");
};

const renderTasteCheckpointsSection = (lifecycle: Lifecycle, lines: string[]): void => {
  if (lifecycle.taste_checkpoints.length === 0) return;
  lines.push("## Taste Checkpoints", "");
  for (const checkpoint of lifecycle.taste_checkpoints) {
    const parts: string[] = [];
    if (checkpoint.after) parts.push(`after: ${checkpoint.after}`);
    if (checkpoint.before) parts.push(`before: ${checkpoint.before}`);
    if (checkpoint.note) parts.push(`note: ${checkpoint.note}`);
    lines.push(`- ${parts.join(" — ")}`);
  }
  lines.push("");
};

const renderEvolutionSection = (lifecycle: Lifecycle, lines: string[]): void => {
  if (!lifecycle.evolution) return;
  lines.push("## Evolution", "", lifecycle.evolution.trim(), "");
};

const renderBodySection = (lifecycle: Lifecycle, lines: string[]): void => {
  const trimmed = lifecycle.body.trim();
  if (trimmed.length === 0) return;
  lines.push(trimmed, "");
};

const renderParametricStub = (lifecycle: Lifecycle, lines: string[]): void => {
  lines.push(
    "_This lifecycle is parameterized and remains a template until another lifecycle binds it. The derived skill content above describes the abstract shape; concrete behaviour appears only in instantiated lifecycles._",
    "",
  );
};

/**
 * Render the body of a lifecycle SKILL.md from a resolved lifecycle and the
 * compiler registry.
 *
 * The output starts with `# <name>` and the description and ends with the
 * free-form body content (when present). Frontmatter and harness-specific
 * owner markers are the lowerer's responsibility.
 */
export const renderDerivedLifecycleSkillBody = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): string => {
  const lines: string[] = [];
  lines.push(`# ${lifecycle.name}`, "");
  lines.push(lifecycle.description, "");
  lines.push(
    "_Runtime-facing lowering of a concrete lifecycle. This skill is derived from the agents, traits, and tools wired into the lifecycle definition; treat it as the authoritative orchestration surface._",
    "",
  );

  if (lifecycle.parameters.length > 0) {
    renderParametricStub(lifecycle, lines);
  }

  renderProducesSection(lifecycle, lines);
  renderOrchestratorSection(lifecycle, registry, lines);
  renderWideToolsSection(lifecycle, registry, lines);
  renderPhasesSection(lifecycle, registry, lines);
  renderSubmissionProtocolsSection(lifecycle, registry, lines);
  renderTraitProtocolsSection(lifecycle, registry, lines);
  renderPhaseTransitionsSection(lifecycle, lines);
  renderClosureDisciplineSection(lifecycle, registry, lines);
  renderTasteCheckpointsSection(lifecycle, lines);
  renderEvolutionSection(lifecycle, lines);
  renderBodySection(lifecycle, lines);

  return lines.join("\n");
};

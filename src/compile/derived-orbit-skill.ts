/**
 * Derived orbit skill rendering.
 *
 * The four harness lowerers each emit a SKILL.md per concrete orbit. The
 * structured content of that SKILL.md is identical across harnesses; only the
 * frontmatter format and owner-marker comment vary. This module owns the
 * structured body so all four lowerers stay aligned.
 *
 * The body is composed from data the compiler already resolved: the orbit
 * itself, the agents assigned to its phases, their identities, personalities,
 * traits, and tools. Hand-authored prose lives in `orbit.body` for
 * content that is genuinely free-form.
 */

import { composeOrbitPhaseReference } from "./compose.js";
import type {
  Agent,
  CanonicalTool,
  Orbit,
  NormalizedOrbitPhase as OrbitPhase,
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

const sortStrings = (values: ReadonlyArray<string>): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const renderToolDetail = (
  ref: string,
  logicalName: string,
  registry: PluginRegistry,
): string[] => {
  const tool = lookupCanonicalTool(ref, registry);
  const description = tool?.description;
  const head = `- \`${logicalName}\` (canonical \`${ref}\`)${description ? ` — ${description}` : ""}`;
  return [head];
};

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
  readonly traits: ReadonlyArray<ResolvedTraitView>;
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
    const traits: ResolvedTraitView[] = [];
    for (const binding of found.agent.traits) {
      const view = lookupTrait(binding.ref, found.registry);
      if (view) traits.push(view);
    }
    views.push({
      ref,
      agent: found.agent,
      registry: found.registry,
      personality,
      traits,
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
  const traits: ResolvedTraitView[] = [];
  for (const binding of found.agent.traits) {
    const view = lookupTrait(binding.ref, found.registry);
    if (view) traits.push(view);
  }
  return { ref, agent: found.agent, registry: found.registry, personality, traits };
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

  if (view.traits.length > 0) {
    const traitNames = sortStrings(view.traits.map((trait) => trait.canonicalId));
    lines.push(
      `**Traits**: ${traitNames.map((name) => `\`${name}\``).join(", ")}.`,
    );
    lines.push("");
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
      `The orchestrator agent for this orbit is \`${orbit.orchestrator.agent}\`.`,
      "",
    );
  }

  if (orbit.orchestrator.tools.length > 0) {
    lines.push("Orchestrator-only tools:", "");
    for (const tool of orbit.orchestrator.tools) {
      lines.push(...renderToolDetail(tool.ref, tool.logicalName, registry));
    }
    lines.push("");
  }
};

const renderWideToolsSection = (
  orbit: Orbit,
  registry: PluginRegistry,
  lines: string[],
): void => {
  if (orbit.tool_permissions.length === 0) return;
  lines.push(
    "## Tools available to every phase agent",
    "",
    "These tools are granted to every phase agent of this orbit:",
    "",
  );
  for (const tool of orbit.tool_permissions) {
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
  orbit: Orbit,
  registry: PluginRegistry,
): SubmissionEntry[] => {
  const entries: SubmissionEntry[] = [];
  const seen = new Set<string>();
  for (const phase of orbit.phases) {
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
  orbit: Orbit,
  registry: PluginRegistry,
  lines: string[],
): void => {
  const entries = collectSubmissionEntries(orbit, registry);
  if (entries.length === 0) return;
  lines.push("## Submission protocol per phase agent", "");
  lines.push(
    "Each phase agent submits work via a packet tool that the orbit relies on:",
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

interface TraitBindingSummary {
  readonly trait: Trait;
  readonly boundBy: Set<string>;
}

const collectAllTraits = (
  orbit: Orbit,
  registry: PluginRegistry,
): Map<string, TraitBindingSummary> => {
  const byCanonicalId = new Map<string, TraitBindingSummary>();
  const visit = (agentRef: string): void => {
    const found = lookupAgent(agentRef, registry);
    if (!found) return;
    for (const binding of found.agent.traits) {
      const trait = lookupTrait(binding.ref, found.registry);
      if (!trait) continue;
      const existing = byCanonicalId.get(trait.canonicalId);
      if (existing) {
        existing.boundBy.add(found.agent.name);
      } else {
        byCanonicalId.set(trait.canonicalId, {
          trait: trait.trait,
          boundBy: new Set([found.agent.name]),
        });
      }
    }
  };
  for (const phase of orbit.phases) {
    for (const ref of phase.agents) visit(ref);
  }
  if (orbit.orchestrator) visit(orbit.orchestrator.agent);
  return byCanonicalId;
};

const renderTraitProtocolsSection = (
  orbit: Orbit,
  registry: PluginRegistry,
  lines: string[],
): void => {
  const traits = collectAllTraits(orbit, registry);
  if (traits.size === 0) return;
  const sorted = [...traits.entries()].sort(([left], [right]) => left.localeCompare(right));
  lines.push("## Trait protocols active in this orbit", "");
  lines.push(
    "Each trait active in this orbit is summarized once: its description, the agents that bind it, and any tools or skills it grants. Per-trait agent-side instructions live with the trait source and are compiled into the bound agents directly; they are not re-rendered here.",
    "",
  );
  for (const [canonicalId, summary] of sorted) {
    const { trait, boundBy } = summary;
    const grantedTools = sortStrings(Object.keys(trait.tools));
    const grantedSkills = sortStrings(trait.inject.skills);

    if (!trait.description && grantedTools.length === 0 && grantedSkills.length === 0) {
      lines.push(
        `_\`${canonicalId}\`: no orchestration-relevant surface; see trait source for agent-side instructions._`,
        "",
      );
      continue;
    }

    lines.push(`### \`${canonicalId}\``, "");
    if (trait.description) {
      lines.push(trait.description, "");
    }
    const boundList = sortStrings([...boundBy]).map((name) => `\`${name}\``).join(", ");
    lines.push(`- Bound by: ${boundList}`);
    if (grantedTools.length > 0) {
      lines.push(
        `- Grants tool(s): ${grantedTools.map((name) => `\`${name}\``).join(", ")}`,
      );
    }
    if (grantedSkills.length > 0) {
      lines.push(
        `- Grants skill(s): ${grantedSkills.map((name) => `\`${name}\``).join(", ")}`,
      );
    }
    lines.push("");
  }
};

const renderPhaseTransitionsSection = (
  orbit: Orbit,
  lines: string[],
): void => {
  if (orbit.phases.length === 0) return;
  lines.push("## Phase transitions", "");
  lines.push(
    "Orbit work items move through canonical states. The orchestrator owns transitions; phase agents stay inside their phase folder until their submission lands.",
    "",
    "Common state arc: `backlog/` → `exploring/` → `committed/` → `building/` → `reviewing/` → `done/` (or `abandoned/`). All orbits follow the same explore / build / review convention; build means whatever the orbit's domain produces (code for Forge, claims for Survey, assets for Beacon, content for Scribe).",
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
 * free-form body content (when present). Frontmatter and harness-specific
 * owner markers are the lowerer's responsibility.
 */
export const renderDerivedOrbitSkillBody = (
  orbit: Orbit,
  registry: PluginRegistry,
): string => {
  const lines: string[] = [];
  lines.push(`# ${orbit.name}`, "");
  lines.push(orbit.description, "");
  lines.push(
    "_Runtime-facing lowering of a concrete orbit. This skill is derived from the agents, traits, and tools wired into the orbit definition; treat it as the authoritative orchestration surface._",
    "",
  );

  if (orbit.parameters.length > 0) {
    renderParametricStub(orbit, lines);
  }

  renderProducesSection(orbit, lines);
  renderOrchestratorSection(orbit, registry, lines);
  renderWideToolsSection(orbit, registry, lines);
  renderPhasesSection(orbit, registry, lines);
  renderSubmissionProtocolsSection(orbit, registry, lines);
  renderTraitProtocolsSection(orbit, registry, lines);
  renderPhaseTransitionsSection(orbit, lines);
  renderTasteCheckpointsSection(orbit, lines);
  renderEvolutionSection(orbit, lines);
  renderBodySection(orbit, lines);

  return lines.join("\n");
};

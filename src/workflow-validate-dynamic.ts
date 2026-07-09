import type { GeneratedSurface } from "./workflow-catalog.js";

export interface WorkflowPhaseAgentWarning {
  readonly taskId: string | null;
  readonly phase: string;
  readonly agent: { readonly plugin: string; readonly name: string };
  readonly allowedAgents: ReadonlyArray<{ readonly plugin: string; readonly name: string }>;
  readonly message: string;
}

interface RawOrbitAgent {
  readonly plugin: string;
  readonly name: string;
}

interface RawOrbitPhase {
  readonly name: string;
  readonly orbit: string;
  readonly agents: Readonly<Record<string, RawOrbitAgent>>;
}

interface RawTypedOrbit {
  readonly plugin: string;
  readonly name: string;
  readonly phases?: Readonly<Record<string, RawOrbitPhase>>;
}

const phaseAgentKey = (agent: { readonly plugin: string; readonly name: string }): string =>
  `${agent.plugin}:${agent.name}`;

/** Build orbit:phase -> allowed agent identities from the compiled generated surface. */
export const phaseAgentAllowlistFromSurface = (
  surface: GeneratedSurface | null,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const allowlist = new Map<string, Set<string>>();
  if (surface === null) return allowlist;

  for (const group of Object.values(surface.orbits)) {
    for (const orbit of Object.values(group ?? {})) {
      const typed = orbit as RawTypedOrbit;
      if (typed.phases === undefined) continue;
      for (const phase of Object.values(typed.phases)) {
        const phaseTag = `${phase.orbit}:${phase.name}`;
        const allowed = allowlist.get(phaseTag) ?? new Set<string>();
        for (const agent of Object.values(phase.agents)) {
          allowed.add(phaseAgentKey(agent));
        }
        allowlist.set(phaseTag, allowed);
      }
    }
  }
  return allowlist;
};

const parseAgentsDotRef = (value: string): { readonly plugin: string; readonly name: string } | null => {
  const match = /^agents\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/u.exec(value.trim());
  if (!match) return null;
  return { plugin: match[1]!, name: match[2]! };
};

const parsePhaseTag = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.includes(":") && trimmed.length > 0 ? trimmed : null;
};

const orbitVarBindings = (source: string): ReadonlyMap<string, { readonly namespace: string; readonly orbitKey: string }> => {
  const bindings = new Map<string, { readonly namespace: string; readonly orbitKey: string }>();
  const bindingPattern = /const\s+(\w+)\s*=\s*orbits\.(\w+)\.(\w+)\s*;/gu;
  for (const match of source.matchAll(bindingPattern)) {
    bindings.set(match[1]!, { namespace: match[2]!, orbitKey: match[3]! });
  }
  return bindings;
};

const resolvePhaseFromSurface = (
  surface: GeneratedSurface | null,
  namespace: string,
  orbitKey: string,
  phaseKey: string,
): { readonly phaseTag: string; readonly allowed: ReadonlySet<string> } | null => {
  if (surface === null) return null;
  const orbit = surface.orbits[namespace]?.[orbitKey] as RawTypedOrbit | undefined;
  const phase = orbit?.phases?.[phaseKey];
  if (phase === undefined) return null;
  const allowed = new Set(Object.values(phase.agents).map(phaseAgentKey));
  return { phaseTag: `${phase.orbit}:${phase.name}`, allowed };
};

const extractBalancedBlock = (source: string, openBraceIndex: number): string | null => {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }
  return null;
};

interface ScannedTaskBinding {
  readonly taskId: string | null;
  readonly phase: string;
  readonly agent: { readonly plugin: string; readonly name: string };
}

const scanExplicitPhaseTasks = (source: string): ReadonlyArray<ScannedTaskBinding> => {
  const bindings: ScannedTaskBinding[] = [];
  const taskHeadPattern = /(?:defineTask|\.task)\(\s*\{/gu;
  for (const head of source.matchAll(taskHeadPattern)) {
    const blockStart = head.index;
    if (blockStart === undefined) continue;
    const braceIndex = source.indexOf("{", blockStart);
    if (braceIndex < 0) continue;
    const block = extractBalancedBlock(source, braceIndex);
    if (block === null) continue;

    const phaseMatch = /phase:\s*["'`]([^"'`]+)["'`]/u.exec(block);
    const phase = phaseMatch ? parsePhaseTag(phaseMatch[1]!) : null;
    if (phase === null) continue;

    const idMatch = /id:\s*["'`]([^"'`]+)["'`]/u.exec(block);
    const agentMatch = /agent:\s*agents\.(\w+)\.(\w+)/u.exec(block);
    if (!agentMatch) continue;

    bindings.push({
      taskId: idMatch?.[1] ?? null,
      phase,
      agent: { plugin: agentMatch[1]!, name: agentMatch[2]! },
    });
  }
  return bindings;
};

const scanWfPhaseBlocks = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<ScannedTaskBinding> => {
  const bindings: ScannedTaskBinding[] = [];
  const bindingsMap = orbitVarBindings(source);
  const phaseCallPattern = /\.phase\(\s*(?:orbits\.(\w+)\.(\w+)|(\w+))\.phases\.(\w+)/gu;

  for (const match of source.matchAll(phaseCallPattern)) {
    const namespace = match[1] ?? bindingsMap.get(match[3]!)?.namespace;
    const orbitKey = match[2] ?? bindingsMap.get(match[3]!)?.orbitKey;
    const phaseKey = match[4];
    if (namespace === undefined || orbitKey === undefined || phaseKey === undefined) continue;

    const resolved = resolvePhaseFromSurface(surface, namespace, orbitKey, phaseKey);
    if (resolved === null) continue;

    const callIndex = match.index ?? 0;
    const slice = source.slice(callIndex, callIndex + 2_500);
    const idMatch = /id:\s*["'`]([^"'`]+)["'`]/u.exec(slice);
    const directAgent = /agent:\s*agents\.(\w+)\.(\w+)/u.exec(slice);
    const slotAgent = new RegExp(
      `agent:\\s*(?:\\w+\\.)?phases\\.${phaseKey}\\.agents\\.(\\w+)`,
      "u",
    ).exec(slice);
    const ctxAgent = /agent:\s*\w+\.agents\.(\w+)/u.exec(slice);

    let agent: { readonly plugin: string; readonly name: string } | null = null;
    if (directAgent) {
      agent = { plugin: directAgent[1]!, name: directAgent[2]! };
    } else if (slotAgent || ctxAgent) {
      const slot = slotAgent?.[1] ?? ctxAgent?.[1];
      const orbit = surface?.orbits[namespace]?.[orbitKey] as RawTypedOrbit | undefined;
      const phase = orbit?.phases?.[phaseKey];
      const raw = slot !== undefined ? phase?.agents[slot] : undefined;
      if (raw) agent = { plugin: raw.plugin, name: raw.name };
    }
    if (agent === null) continue;

    bindings.push({
      taskId: idMatch?.[1] ?? null,
      phase: resolved.phaseTag,
      agent,
    });
  }
  return bindings;
};

const warningForBinding = (
  binding: ScannedTaskBinding,
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
): WorkflowPhaseAgentWarning | null => {
  const allowed = allowlist.get(binding.phase);
  if (allowed === undefined || allowed.size === 0) return null;
  const agentKey = phaseAgentKey(binding.agent);
  if (allowed.has(agentKey)) return null;
  const allowedAgents = [...allowed].map((entry) => {
    const [plugin, name] = entry.split(":");
    return { plugin: plugin!, name: name! };
  });
  const taskLabel = binding.taskId ?? "<unknown>";
  return {
    taskId: binding.taskId,
    phase: binding.phase,
    agent: binding.agent,
    allowedAgents,
    message:
      `task '${taskLabel}' is stamped phase '${binding.phase}' but agent ` +
      `'${binding.agent.plugin}:${binding.agent.name}' is not assigned to that phase ` +
      `(allowed: ${allowedAgents.map((a) => `${a.plugin}:${a.name}`).join(", ")})`,
  };
};

/**
 * Best-effort static scan of a dynamic workflow source: warn when a task's phase
 * tag names a compiled orbit phase but its agent is outside that phase's set.
 */
export const scanDynamicPhaseAgentWarnings = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<WorkflowPhaseAgentWarning> => {
  const allowlist = phaseAgentAllowlistFromSurface(surface);
  if (allowlist.size === 0) return [];

  const seen = new Set<string>();
  const warnings: WorkflowPhaseAgentWarning[] = [];
  const bindings = [...scanExplicitPhaseTasks(source), ...scanWfPhaseBlocks(source, surface)];

  for (const binding of bindings) {
    const dedupeKey = `${binding.taskId ?? ""}|${binding.phase}|${phaseAgentKey(binding.agent)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const directRef = parseAgentsDotRef(`agents.${binding.agent.plugin}.${binding.agent.name}`);
    const normalized = directRef ?? binding.agent;
    const warning = warningForBinding({ ...binding, agent: normalized }, allowlist);
    if (warning) warnings.push(warning);
  }
  return warnings;
};
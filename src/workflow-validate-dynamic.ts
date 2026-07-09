import { Effect } from "effect";
import type { GeneratedSurface } from "./workflow-catalog.js";
import {
  phase,
  type AnyWorkflowTask,
  type DynamicWorkflowDefinition,
  type WorkflowAgentRef,
  type WorkflowRuntime,
} from "./workflows.js";

export interface WorkflowPhaseAgentFinding {
  readonly taskId: string | null;
  readonly phase: string;
  readonly agent: { readonly plugin: string; readonly name: string };
  readonly allowedAgents: ReadonlyArray<{ readonly plugin: string; readonly name: string }>;
  readonly message: string;
}

/** @deprecated Use {@link WorkflowPhaseAgentFinding}. */
export type WorkflowPhaseAgentWarning = WorkflowPhaseAgentFinding;

export interface PhaseStampedTaskBinding {
  readonly taskId: string | null;
  readonly phase: string;
  readonly agent: { readonly plugin: string; readonly name: string };
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

const allowedAgentsFromSet = (allowed: ReadonlySet<string>): ReadonlyArray<{ readonly plugin: string; readonly name: string }> =>
  [...allowed].map((entry) => {
    const [plugin, name] = entry.split(":");
    return { plugin: plugin!, name: name! };
  });

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
      for (const phaseEntry of Object.values(typed.phases)) {
        const phaseTag = `${phaseEntry.orbit}:${phaseEntry.name}`;
        const allowed = allowlist.get(phaseTag) ?? new Set<string>();
        for (const agent of Object.values(phaseEntry.agents)) {
          allowed.add(phaseAgentKey(agent));
        }
        allowlist.set(phaseTag, allowed);
      }
    }
  }
  return allowlist;
};

const bindingAgent = (agent: WorkflowAgentRef): { readonly plugin: string; readonly name: string } => ({
  plugin: agent.plugin,
  name: agent.name,
});

/** Collect phase-stamped tasks from a statically declared workflow task list. */
export const phaseStampedBindingsFromTasks = (
  tasks: ReadonlyArray<AnyWorkflowTask>,
): ReadonlyArray<PhaseStampedTaskBinding> =>
  tasks.flatMap((task) =>
    task.phase === undefined
      ? []
      : [{
        taskId: task.id,
        phase: task.phase,
        agent: bindingAgent(task.agent),
      }],
  );

/**
 * Execute a dynamic workflow against a probe runtime that records dispatched
 * tasks without running harness workers. Uses the real `wf.phase` / `runTask`
 * DSL path so stamped phases and agents come from the loaded workflow graph.
 */
export const probeDynamicWorkflowPhaseTasks = async (
  workflow: DynamicWorkflowDefinition<string>,
): Promise<ReadonlyArray<PhaseStampedTaskBinding>> => {
  const captured: PhaseStampedTaskBinding[] = [];
  const runtime: WorkflowRuntime = {
    runTask: (task) => Effect.sync(() => {
      if (task.phase !== undefined) {
        captured.push({
          taskId: task.id,
          phase: task.phase,
          agent: bindingAgent(task.agent),
        });
      }
      return {};
    }) as ReturnType<WorkflowRuntime["runTask"]>,
    phase: (contract, fn) => phase(runtime, contract, fn),
  };
  await Effect.runPromiseExit(workflow.run(runtime));
  return captured;
};

const findingForBinding = (
  binding: PhaseStampedTaskBinding,
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
  hasTypedPhases: boolean,
): WorkflowPhaseAgentFinding | null => {
  if (!hasTypedPhases) return null;

  const allowed = allowlist.get(binding.phase);
  const taskLabel = binding.taskId ?? "<unknown>";

  if (allowed === undefined) {
    return {
      taskId: binding.taskId,
      phase: binding.phase,
      agent: binding.agent,
      allowedAgents: [],
      message:
        `task '${taskLabel}' is stamped phase '${binding.phase}' but that phase is not ` +
        "present in the compiled workflow surface (run `prism refresh` for this project)",
    };
  }

  if (allowed.size === 0) {
    return {
      taskId: binding.taskId,
      phase: binding.phase,
      agent: binding.agent,
      allowedAgents: [],
      message:
        `task '${taskLabel}' is stamped phase '${binding.phase}' but the compiled manifest ` +
        "assigns no agents to that phase",
    };
  }

  const agentKey = phaseAgentKey(binding.agent);
  if (allowed.has(agentKey)) return null;

  const allowedAgents = allowedAgentsFromSet(allowed);
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

const dedupeBindings = (bindings: ReadonlyArray<PhaseStampedTaskBinding>): ReadonlyArray<PhaseStampedTaskBinding> => {
  const seen = new Set<string>();
  const unique: PhaseStampedTaskBinding[] = [];
  for (const binding of bindings) {
    const dedupeKey = `${binding.taskId ?? ""}|${binding.phase}|${phaseAgentKey(binding.agent)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(binding);
  }
  return unique;
};

/** Fail-closed validation for phase-stamped tasks against the compiled allowlist. */
export const validatePhaseAgentBindings = (
  bindings: ReadonlyArray<PhaseStampedTaskBinding>,
  surface: GeneratedSurface | null,
): ReadonlyArray<WorkflowPhaseAgentFinding> => {
  const allowlist = phaseAgentAllowlistFromSurface(surface);
  const hasTypedPhases = allowlist.size > 0;
  const findings: WorkflowPhaseAgentFinding[] = [];
  for (const binding of dedupeBindings(bindings)) {
    const finding = findingForBinding(binding, allowlist, hasTypedPhases);
    if (finding) findings.push(finding);
  }
  return findings;
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
  const phaseEntry = orbit?.phases?.[phaseKey];
  if (phaseEntry === undefined) return null;
  const allowed = new Set(Object.values(phaseEntry.agents).map(phaseAgentKey));
  return { phaseTag: `${phaseEntry.orbit}:${phaseEntry.name}`, allowed };
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

/**
 * Residual-risk fallback when the probe runtime cannot execute the author's
 * `run` program (e.g. imports side effects, non-probe-safe logic). Regex-bound
 * to explicit `phase:` literals and `wf.phase(orbits.*.phases.*)` call sites
 * within a short post-match window — tasks built indirectly or outside those
 * shapes may false-negative.
 */
const scanExplicitPhaseTasks = (source: string): ReadonlyArray<PhaseStampedTaskBinding> => {
  const bindings: PhaseStampedTaskBinding[] = [];
  const taskHeadPattern = /(?:defineTask|\.task)\(\s*\{/gu;
  for (const head of source.matchAll(taskHeadPattern)) {
    const blockStart = head.index;
    if (blockStart === undefined) continue;
    const braceIndex = source.indexOf("{", blockStart);
    if (braceIndex < 0) continue;
    const block = extractBalancedBlock(source, braceIndex);
    if (block === null) continue;

    const phaseMatch = /phase:\s*["'`]([^"'`]+)["'`]/u.exec(block);
    const phaseValue = phaseMatch ? parsePhaseTag(phaseMatch[1]!) : null;
    if (phaseValue === null) continue;

    const idMatch = /id:\s*["'`]([^"'`]+)["'`]/u.exec(block);
    const agentMatch = /agent:\s*agents\.(\w+)\.(\w+)/u.exec(block);
    if (!agentMatch) continue;

    bindings.push({
      taskId: idMatch?.[1] ?? null,
      phase: phaseValue,
      agent: { plugin: agentMatch[1]!, name: agentMatch[2]! },
    });
  }
  return bindings;
};

const scanWfPhaseBlocks = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<PhaseStampedTaskBinding> => {
  const bindings: PhaseStampedTaskBinding[] = [];
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
      const phaseEntry = orbit?.phases?.[phaseKey];
      const raw = slot !== undefined ? phaseEntry?.agents[slot] : undefined;
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

/** Regex fallback bindings for dynamic workflows when probe execution is insufficient. */
export const scanDynamicPhaseTaskBindings = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<PhaseStampedTaskBinding> => {
  const bindings = [...scanExplicitPhaseTasks(source), ...scanWfPhaseBlocks(source, surface)];
  return dedupeBindings(
    bindings.map((binding) => {
      const directRef = parseAgentsDotRef(`agents.${binding.agent.plugin}.${binding.agent.name}`);
      return directRef === null ? binding : { ...binding, agent: directRef };
    }),
  );
};

/**
 * Collect phase-agent findings for a dynamic workflow: probe the loaded graph
 * first, then union regex-discovered bindings the probe may have missed.
 */
export const collectDynamicPhaseAgentFindings = async (
  workflow: DynamicWorkflowDefinition<string>,
  source: string,
  surface: GeneratedSurface | null,
): Promise<ReadonlyArray<WorkflowPhaseAgentFinding>> => {
  const probed = await probeDynamicWorkflowPhaseTasks(workflow);
  const scanned = scanDynamicPhaseTaskBindings(source, surface);
  return validatePhaseAgentBindings([...probed, ...scanned], surface);
};

/** @deprecated Use {@link collectDynamicPhaseAgentFindings}. */
export const scanDynamicPhaseAgentWarnings = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<WorkflowPhaseAgentFinding> =>
  validatePhaseAgentBindings(scanDynamicPhaseTaskBindings(source, surface), surface);
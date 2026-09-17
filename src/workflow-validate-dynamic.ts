import { Effect } from "effect";
import { jevProbeResult } from "./jev.js";
import type { WorkflowRuntimeError } from "./workflow-errors.js";
import type { GeneratedSurface } from "./workflow-catalog.js";
import {
  isJevTask,
  phase,
  type AnyWorkflowTask,
  type DynamicWorkflowDefinition,
  type WorkflowRuntime,
  type WorkflowTaskOutput,
} from "./workflows.js";

export interface WorkflowPhaseFinding {
  readonly taskId: string | null;
  readonly phase: string;
  readonly message: string;
}

export interface PhaseStampedTaskBinding {
  readonly taskId: string | null;
  readonly phase: string;
}

interface RawSopPhase {
  readonly name: string;
  readonly sop: string;
}

interface RawTypedSop {
  readonly plugin: string;
  readonly name: string;
  readonly phases?: Readonly<Record<string, RawSopPhase>>;
}

/**
 * Build the set of `sop:phase` tags present in the compiled generated surface.
 * Stamped tasks resolve against this set; executor assignment is not part of
 * the SOP graph (tasks are agent-optional).
 */
export const sopPhaseTagsFromSurface = (
  surface: GeneratedSurface | null,
): ReadonlySet<string> => {
  const tags = new Set<string>();
  if (surface === null) return tags;

  for (const group of Object.values(surface.sops)) {
    for (const sop of Object.values(group ?? {})) {
      const typed = sop as RawTypedSop;
      if (typed.phases === undefined) continue;
      for (const phaseEntry of Object.values(typed.phases)) {
        tags.add(`${typed.name}:${phaseEntry.name}`);
      }
    }
  }
  return tags;
};

/** Collect phase-stamped tasks from a statically declared workflow task list. */
export const phaseStampedBindingsFromTasks = (
  tasks: ReadonlyArray<AnyWorkflowTask>,
): ReadonlyArray<PhaseStampedTaskBinding> =>
  tasks.flatMap((task) =>
    task.phase === undefined
      ? []
      : [{ taskId: task.id, phase: task.phase }],
  );

/**
 * Execute a dynamic workflow against a probe runtime that records dispatched
 * tasks without running harness workers. Uses the real `wf.phase` / `runTask`
 * DSL path so stamped phases come from the loaded workflow graph.
 */
export interface DynamicWorkflowProbeResult {
  readonly tasks: ReadonlyArray<AnyWorkflowTask>;
  readonly phaseBindings: ReadonlyArray<PhaseStampedTaskBinding>;
  readonly failed: boolean;
  /**
   * True when the probe stopped at the dispatch limit: the `run:` program kept
   * dispatching (a decision-gated retry loop, for example), so the recorded
   * task list is a prefix of an unbounded graph.
   */
  readonly exhausted: boolean;
}

/**
 * Bound on dynamic-probe dispatches. A probe executes the author's `run`
 * program; deterministic probe results (jevProbeResult always selects the
 * first criterion) can make a decision-gated loop take the same branch
 * forever, so dispatching stops here and the probe reports `exhausted`.
 */
export const DYNAMIC_WORKFLOW_PROBE_DISPATCH_LIMIT = 512;

/** Probe a dynamic `run:` graph: record every dispatched task without launching workers. */
export const probeDynamicWorkflowTasks = async (
  workflow: DynamicWorkflowDefinition<string>,
): Promise<DynamicWorkflowProbeResult> => {
  const tasks: AnyWorkflowTask[] = [];
  const phaseBindings: PhaseStampedTaskBinding[] = [];
  let exhausted = false;
  const runtime: WorkflowRuntime = {
    runTask: <Task extends AnyWorkflowTask>(
      task: Task,
    ): Effect.Effect<WorkflowTaskOutput<Task>, WorkflowRuntimeError> =>
      Effect.sync(() => {
        if (tasks.length >= DYNAMIC_WORKFLOW_PROBE_DISPATCH_LIMIT) {
          exhausted = true;
          throw new Error(
            `dynamic workflow probe exceeded the dispatch limit of ${DYNAMIC_WORKFLOW_PROBE_DISPATCH_LIMIT} tasks`,
          );
        }
        tasks.push(task);
        if (task.phase !== undefined) {
          phaseBindings.push({ taskId: task.id, phase: task.phase });
        }
        // Jev decisions get a schema-valid deterministic witness so downstream
        // branch reads (e.g. `answers.next.choice`) do not crash the probe.
        return (
          isJevTask(task) ? jevProbeResult(task.questions) : {}
        ) as WorkflowTaskOutput<Task>;
      }),
    phase: (contract, fn) => phase(runtime, contract, fn),
  };
  const exit = await Effect.runPromiseExit(workflow.run(runtime));
  return { tasks, phaseBindings, failed: exit._tag === "Failure", exhausted };
};

export const probeDynamicWorkflowPhaseTasks = async (
  workflow: DynamicWorkflowDefinition<string>,
): Promise<ReadonlyArray<PhaseStampedTaskBinding>> =>
  (await probeDynamicWorkflowTasks(workflow)).phaseBindings;

const findingForBinding = (
  binding: PhaseStampedTaskBinding,
  phaseTags: ReadonlySet<string>,
  hasTypedPhases: boolean,
): WorkflowPhaseFinding | null => {
  if (!hasTypedPhases) return null;

  if (phaseTags.has(binding.phase)) return null;

  const taskLabel = binding.taskId ?? "<unknown>";
  return {
    taskId: binding.taskId,
    phase: binding.phase,
    message:
      `task '${taskLabel}' is stamped phase '${binding.phase}' but that phase is not ` +
      "present in the compiled SOP surface (run `prism refresh` for this project)",
  };
};

const dedupeBindings = (
  bindings: ReadonlyArray<PhaseStampedTaskBinding>,
): ReadonlyArray<PhaseStampedTaskBinding> => {
  const seen = new Set<string>();
  const unique: PhaseStampedTaskBinding[] = [];
  for (const binding of bindings) {
    const dedupeKey = `${binding.taskId ?? ""}|${binding.phase}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(binding);
  }
  return unique;
};

/** Fail-closed validation for phase-stamped tasks against the compiled SOP surface. */
export const validatePhaseBindings = (
  bindings: ReadonlyArray<PhaseStampedTaskBinding>,
  surface: GeneratedSurface | null,
): ReadonlyArray<WorkflowPhaseFinding> => {
  const phaseTags = sopPhaseTagsFromSurface(surface);
  const hasTypedPhases = phaseTags.size > 0;
  const findings: WorkflowPhaseFinding[] = [];
  for (const binding of dedupeBindings(bindings)) {
    const finding = findingForBinding(binding, phaseTags, hasTypedPhases);
    if (finding) findings.push(finding);
  }
  return findings;
};

const parsePhaseTag = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.includes(":") && trimmed.length > 0 ? trimmed : null;
};

const sopVarBindings = (source: string): ReadonlyMap<string, { readonly namespace: string; readonly sopKey: string }> => {
  const bindings = new Map<string, { readonly namespace: string; readonly sopKey: string }>();
  const bindingPattern = /const\s+(\w+)\s*=\s*sops\.(\w+)\.(\w+)\s*;/gu;
  for (const match of source.matchAll(bindingPattern)) {
    bindings.set(match[1]!, { namespace: match[2]!, sopKey: match[3]! });
  }
  return bindings;
};

const resolvePhaseTagFromSurface = (
  surface: GeneratedSurface | null,
  namespace: string,
  sopKey: string,
  phaseKey: string,
): string | null => {
  if (surface === null) return null;
  const sop = surface.sops[namespace]?.[sopKey] as RawTypedSop | undefined;
  const phaseEntry = sop?.phases?.[phaseKey];
  if (phaseEntry !== undefined) {
    return `${phaseEntry.sop ?? sop?.name ?? sopKey}:${phaseEntry.name}`;
  }
  // The SOP or phase may have been removed from the compiled surface; keep the
  // parsed tag so validation can report the stale binding.
  return `${sop?.name ?? sopKey}:${phaseKey}`;
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
 * to explicit `phase:` literals within a short post-match window — tasks built
 * indirectly or outside those shapes may false-negative.
 */
const scanExplicitPhaseTasks = (source: string): ReadonlyArray<PhaseStampedTaskBinding> => {
  const bindings: PhaseStampedTaskBinding[] = [];
  // Worker tasks (defineTask / phase ctx.task) and jev decisions (jev / ctx.jev)
  // both carry an optional literal `phase:` the stale-binding check must see.
  const taskHeadPattern = /(?:defineTask|\.task|jev|\.jev)\(\s*\{/gu;
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

    bindings.push({
      taskId: idMatch?.[1] ?? null,
      phase: phaseValue,
    });
  }
  return bindings;
};

const scanWfPhaseBlocks = (
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<PhaseStampedTaskBinding> => {
  const bindings: PhaseStampedTaskBinding[] = [];
  const bindingsMap = sopVarBindings(source);
  const phaseCallPattern = /\.phase\(\s*(?:sops\.(\w+)\.(\w+)|(\w+))\.phases\.(\w+)/gu;

  for (const match of source.matchAll(phaseCallPattern)) {
    const namespace = match[1] ?? bindingsMap.get(match[3]!)?.namespace;
    const sopKey = match[2] ?? bindingsMap.get(match[3]!)?.sopKey;
    const phaseKey = match[4];
    if (namespace === undefined || sopKey === undefined || phaseKey === undefined) continue;

    const phaseTag = resolvePhaseTagFromSurface(surface, namespace, sopKey, phaseKey);
    if (phaseTag === null) continue;

    const callIndex = match.index ?? 0;
    const slice = source.slice(callIndex, callIndex + 2_500);
    const idMatch = /id:\s*["'`]([^"'`]+)["'`]/u.exec(slice);

    bindings.push({
      taskId: idMatch?.[1] ?? null,
      phase: phaseTag,
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
  return dedupeBindings(bindings);
};

/**
 * Collect phase findings for a dynamic workflow from an already-run probe,
 * then union regex-discovered bindings the probe may have missed. Callers probe
 * once (probeDynamicWorkflowTasks) and share the result with model-resolution
 * reporting, so both describe the same execution.
 */
export const collectDynamicPhaseFindings = (
  probed: DynamicWorkflowProbeResult,
  source: string,
  surface: GeneratedSurface | null,
): ReadonlyArray<WorkflowPhaseFinding> => {
  const scanned = scanDynamicPhaseTaskBindings(source, surface);
  return validatePhaseBindings([...probed.phaseBindings, ...scanned], surface);
};

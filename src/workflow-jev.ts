import { Cause, Effect, Exit, type Layer, ManagedRuntime } from "effect";
import { JEV_RESULT_CONTRACT_VERSION } from "./jev.js";
import { JevClient, JevError } from "./services/jev.js";
import type { AnyJevTask } from "./workflows.js";
import type { WorkflowTaskExecution, WorkflowTaskExecutionContext } from "./workflow-runner.js";

/**
 * Raised when a jev task's JevClient call fails. Wraps the typed {@link JevError}
 * in a plain Error so the runner's promise-based attempt bookkeeping reads a
 * stable `name`/`message` instead of an Effect FiberFailure.
 */
export class WorkflowJevExecutionError extends Error {
  override readonly name = "WorkflowJevExecutionError";
  constructor(readonly jevError: JevError) {
    super(`jev ${jevError.kind}: ${jevError.message}`);
  }
}

export type WorkflowJevTaskExecutor = (
  task: AnyJevTask,
  context?: WorkflowTaskExecutionContext,
) => Promise<WorkflowTaskExecution>;

/**
 * Adapt a `Layer<JevClient>` into the runner's executor shape. The layer is
 * built lazily on first task (so importing and validating jev workflows never
 * requires credentials), and the managed runtime lives as long as the returned
 * executor — the CLI creates one per process.
 *
 * The task's own request normalization, the ~28k-token pre-flight guard, and
 * the result-contract decode all happen inside JevClient; this adapter only
 * times the call, converts errors, and stamps observability metadata.
 */
export const createWorkflowJevTaskExecutor = (
  layer: Layer.Layer<JevClient>,
): WorkflowJevTaskExecutor => {
  const runtime = ManagedRuntime.make(layer);
  return async (task, context) => {
    const startedAt = Date.now();
    const program = Effect.flatMap(JevClient, (client) =>
      client.systemOne(
        {
          state: task.state,
          questions: task.questions,
          ...(task.model !== undefined ? { model: task.model } : {}),
        },
        task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : undefined,
      ));
    const exit = await runtime.runPromiseExit(
      program,
      context?.abortSignal !== undefined ? { signal: context.abortSignal } : undefined,
    );
    if (Exit.isFailure(exit)) {
      const squashed = Cause.squash(exit.cause);
      if (squashed instanceof JevError) throw new WorkflowJevExecutionError(squashed);
      throw squashed;
    }
    const result = exit.value;
    return {
      output: result,
      metadata: {
        taskKind: "jev",
        adapter: "jev",
        api: "systemone",
        jevContractVersion: JEV_RESULT_CONTRACT_VERSION,
        model: result.model,
        usage: result.usage,
        durationMs: Date.now() - startedAt,
      },
    };
  };
};

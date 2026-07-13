export type WorkflowCostReporting = "full" | "tokens" | "none";

export interface WorkflowUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly costReporting: WorkflowCostReporting;
}

export interface WorkflowUsageTotals {
  readonly agentRuns: number;
  readonly reused: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

export const emptyWorkflowUsageTotals = (): WorkflowUsageTotals => ({
  agentRuns: 0,
  reused: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  durationMs: 0,
});

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const firstNumber = (
  metadata: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined => {
  for (const key of keys) {
    const value = nonNegativeNumber(metadata[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** Normalize provider-specific task metadata into Prism's durable usage contract. */
export const workflowUsageFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): WorkflowUsage => {
  const root = metadata ?? {};
  const nested = recordValue(root.usage) ?? {};
  const tokensIn = firstNumber(nested, ["tokensIn", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens"])
    ?? firstNumber(root, ["tokensIn", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens"]);
  const tokensOut = firstNumber(nested, ["tokensOut", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"])
    ?? firstNumber(root, ["tokensOut", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"]);
  const costUsd = firstNumber(nested, ["costUsd", "totalCostUsd", "total_cost_usd"])
    ?? firstNumber(root, ["costUsd", "totalCostUsd", "total_cost_usd"]);
  const durationMs = firstNumber(nested, ["durationMs", "duration_ms"])
    ?? firstNumber(root, ["durationMs", "duration_ms"]);
  const costReporting: WorkflowCostReporting = costUsd !== undefined
    ? "full"
    : tokensIn !== undefined || tokensOut !== undefined
      ? "tokens"
      : "none";
  return {
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    costReporting,
  };
};

export const addWorkflowUsage = (
  totals: WorkflowUsageTotals,
  usage: WorkflowUsage,
): WorkflowUsageTotals => ({
  ...totals,
  agentRuns: totals.agentRuns + 1,
  tokensIn: totals.tokensIn + (usage.tokensIn ?? 0),
  tokensOut: totals.tokensOut + (usage.tokensOut ?? 0),
  costUsd: totals.costUsd + (usage.costUsd ?? 0),
  durationMs: totals.durationMs + (usage.durationMs ?? 0),
});

export const addWorkflowReuse = (totals: WorkflowUsageTotals): WorkflowUsageTotals => ({
  ...totals,
  reused: totals.reused + 1,
});

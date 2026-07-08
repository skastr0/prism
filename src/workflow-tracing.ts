import { randomBytes } from "node:crypto";
import { Cause, Context, Exit, Option, Tracer } from "effect";
import type { WorkflowStore } from "./workflow-store.js";

export type WorkflowSpanStatus = "ok" | "error" | "unset";

/** One row in `workflow_spans` — the sqlite-native span shape shared by the engine, the Effect tracer bridge, and the CLI trace renderer. */
export interface WorkflowSpanRecord {
  readonly runId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly taskId: string | null;
  readonly name: string;
  readonly kind: string;
  readonly startNs: bigint;
  readonly endNs: bigint | null;
  readonly status: WorkflowSpanStatus;
  readonly errorMessage: string | null;
  readonly attributes: Record<string, unknown>;
}

export const generateWorkflowTraceId = (): string => randomBytes(16).toString("hex");
export const generateWorkflowSpanId = (): string => randomBytes(8).toString("hex");

// Wall-clock nanoseconds: hrtime is monotonic; anchoring it to the epoch once gives
// timestamps that are collision-free within a run and directly OTLP-compatible.
const hrtimeEpochOffsetNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
export const currentTimeNanos = (): bigint => process.hrtime.bigint() + hrtimeEpochOffsetNs;

const truncateErrorMessage = (message: string): string =>
  message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;

const errorMessageOf = (error: unknown): string =>
  truncateErrorMessage(error instanceof Error ? error.message : String(error));

export interface WorkflowSpanStartInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly taskId: string | null;
  readonly name: string;
  readonly kind: string;
  readonly startNs: bigint;
}

export interface WorkflowSpanEndInput {
  readonly spanId: string;
  readonly endNs: bigint;
  readonly status: Exclude<WorkflowSpanStatus, "unset">;
  readonly errorMessage: string | null;
  readonly attributes: Record<string, unknown>;
}

export interface WorkflowSpanHandle {
  readonly spanId: string;
  readonly traceId: string;
  annotate(key: string, value: unknown): void;
  end(status: Exclude<WorkflowSpanStatus, "unset">, error?: unknown): void;
}

/**
 * The per-run span sink. Spans are written to the run's own sqlite store
 * (start row on open, end update on close) so a killed run still shows its
 * partial trace, and a running run is traceable live. When the run is not
 * persisted (no store / null runId) every operation is a no-op.
 */
export interface WorkflowTraceRecorder {
  readonly enabled: boolean;
  readonly traceId: string;
  recordSpanStart(input: WorkflowSpanStartInput): void;
  recordSpanEnd(input: WorkflowSpanEndInput): void;
  startSpan(
    name: string,
    options?: {
      readonly parentSpanId?: string | null;
      readonly taskId?: string | null;
      readonly attributes?: Record<string, unknown>;
    },
  ): WorkflowSpanHandle;
}

const noopSpanHandle: WorkflowSpanHandle = {
  spanId: "",
  traceId: "",
  annotate: () => {},
  end: () => {},
};

const noopRecorder: WorkflowTraceRecorder = {
  enabled: false,
  traceId: "",
  recordSpanStart: () => {},
  recordSpanEnd: () => {},
  startSpan: () => noopSpanHandle,
};

export const createWorkflowTraceRecorder = (input: {
  readonly store?: WorkflowStore;
  readonly runId: string | null;
  readonly traceId?: string;
}): WorkflowTraceRecorder => {
  const { store, runId } = input;
  if (store === undefined || runId === null) return noopRecorder;
  const traceId = input.traceId ?? generateWorkflowTraceId();
  const recorder: WorkflowTraceRecorder = {
    enabled: true,
    traceId,
    recordSpanStart: (span) => {
      store.recordSpanStart({
        runId,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        taskId: span.taskId,
        name: span.name,
        kind: span.kind,
        startNs: span.startNs,
        endNs: null,
        status: "unset",
        errorMessage: null,
        attributes: {},
      });
    },
    recordSpanEnd: (span) => {
      store.recordSpanEnd(span);
    },
    startSpan: (name, options) => {
      const spanId = generateWorkflowSpanId();
      const startNs = currentTimeNanos();
      const attributes: Record<string, unknown> = { ...(options?.attributes ?? {}) };
      recorder.recordSpanStart({
        traceId,
        spanId,
        parentSpanId: options?.parentSpanId ?? null,
        taskId: options?.taskId ?? null,
        name,
        kind: "internal",
        startNs,
      });
      let ended = false;
      return {
        spanId,
        traceId,
        annotate: (key, value) => {
          attributes[key] = value;
        },
        end: (status, error) => {
          if (ended) return;
          ended = true;
          recorder.recordSpanEnd({
            spanId,
            endNs: currentTimeNanos(),
            status,
            errorMessage: error === undefined ? null : errorMessageOf(error),
            attributes,
          });
        },
      };
    },
  };
  return recorder;
};

interface WorkflowSpanEvent {
  readonly name: string;
  readonly startNs: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * Effect Tracer bridge: spans created by author programs (`Effect.withSpan`,
 * `Effect.fn`) mirror into the run's span store with correct parent linkage.
 * Root author spans parent onto `defaultParentSpanId` (the run root span) so
 * the whole run renders as one tree.
 */
class WorkflowEffectSpan implements Tracer.Span {
  readonly _tag = "Span" as const;
  readonly spanId = generateWorkflowSpanId();
  readonly traceId: string;
  readonly context = Context.empty();
  readonly sampled = true;
  readonly attributes = new Map<string, unknown>();
  links: Array<Tracer.SpanLink> = [];
  status: Tracer.SpanStatus;
  private readonly spanEvents: Array<WorkflowSpanEvent> = [];
  private ended = false;

  constructor(
    private readonly recorder: WorkflowTraceRecorder,
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly kind: Tracer.SpanKind,
    startTime: bigint,
    parentSpanId: string | null,
  ) {
    this.traceId = Option.isSome(parent) ? parent.value.traceId : recorder.traceId;
    this.status = { _tag: "Started", startTime };
    recorder.recordSpanStart({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId,
      taskId: null,
      name,
      kind,
      startNs: startTime,
    });
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.spanEvents.push({ name, startNs: startTime.toString(), ...(attributes !== undefined ? { attributes } : {}) });
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links = [...this.links, ...links];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.ended) return;
    this.ended = true;
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit };
    const failed = Exit.isFailure(exit);
    this.recorder.recordSpanEnd({
      spanId: this.spanId,
      endNs: endTime,
      status: failed ? "error" : "ok",
      errorMessage: failed ? truncateErrorMessage(Cause.pretty(exit.cause)) : null,
      attributes: {
        ...Object.fromEntries(this.attributes),
        ...(this.spanEvents.length > 0 ? { _events: this.spanEvents } : {}),
      },
    });
  }
}

export const makeWorkflowEffectTracer = (
  recorder: WorkflowTraceRecorder,
  options?: { readonly defaultParentSpanId?: string },
): Tracer.Tracer =>
  Tracer.make({
    span: (name, parent, _context, _links, startTime, kind) =>
      new WorkflowEffectSpan(
        recorder,
        name,
        parent,
        kind,
        startTime,
        Option.isSome(parent) ? parent.value.spanId : options?.defaultParentSpanId ?? null,
      ),
    context: (f, _fiber) => f(),
  });

// ---------- trace tree rendering (pure; consumed by `prism workflow runs trace`) ----------

export interface WorkflowSpanTreeNode {
  readonly span: WorkflowSpanRecord;
  readonly children: ReadonlyArray<WorkflowSpanTreeNode>;
}

/** Spans whose parent is unknown (or absent) become roots; children stay in start order. */
export const buildWorkflowSpanTree = (
  spans: ReadonlyArray<WorkflowSpanRecord>,
): ReadonlyArray<WorkflowSpanTreeNode> => {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, WorkflowSpanRecord[]>();
  const roots: WorkflowSpanRecord[] = [];
  for (const span of spans) {
    if (span.parentSpanId !== null && byId.has(span.parentSpanId)) {
      const siblings = children.get(span.parentSpanId) ?? [];
      siblings.push(span);
      children.set(span.parentSpanId, siblings);
    } else {
      roots.push(span);
    }
  }
  const toNode = (span: WorkflowSpanRecord): WorkflowSpanTreeNode => ({
    span,
    children: (children.get(span.spanId) ?? []).map(toNode),
  });
  return roots.map(toNode);
};

const formatDurationMs = (ms: number): string => {
  if (ms < 1) return "<1ms";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
};

const spanDurationMs = (span: WorkflowSpanRecord): number | undefined =>
  span.endNs === null ? undefined : Number(span.endNs - span.startNs) / 1_000_000;

const spanGlyph = (span: WorkflowSpanRecord): string => {
  switch (span.status) {
    case "ok":
      return "✓";
    case "error":
      return "✗";
    default:
      return "…";
  }
};

const spanLabel = (span: WorkflowSpanRecord): string => {
  const attributes = span.attributes;
  const parts: string[] = [span.name];
  if (span.name === "workflow.run" && typeof attributes["workflow"] === "string") {
    parts.push(String(attributes["workflow"]));
  }
  if (span.name === "workflow.task") {
    parts.push(span.taskId ?? String(attributes["task.id"] ?? ""));
    const plugin = attributes["agent.plugin"];
    const agent = attributes["agent.name"];
    if (typeof plugin === "string" && typeof agent === "string") parts.push(`${plugin}/${agent}`);
    if (attributes["task.cached"] === true) parts.push("cached");
  }
  if (span.name === "task.executor") {
    const attempt = attributes["executor.attempt"];
    if (attempt !== undefined) parts.push(`attempt ${String(attempt)}`);
    const adapter = attributes["worker.adapter"];
    const model = attributes["worker.model"];
    if (typeof adapter === "string") parts.push(typeof model === "string" ? `${adapter} ${model}` : adapter);
  }
  if (span.name === "task.judge") {
    const criterion = attributes["judge.criterion"];
    if (typeof criterion === "string") parts.push(criterion);
    const verdict = attributes["judge.verdict"];
    if (typeof verdict === "string") parts.push(verdict);
  }
  return parts.filter((part) => part.length > 0).join(" · ");
};

export const renderWorkflowTraceHuman = (
  spans: ReadonlyArray<WorkflowSpanRecord>,
  options?: { readonly minDurationMs?: number },
): string => {
  if (spans.length === 0) return "No spans recorded for this run.";
  const minDurationMs = options?.minDurationMs;
  const lines: string[] = [];
  const renderNode = (node: WorkflowSpanTreeNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const duration = spanDurationMs(node.span);
    if (
      minDurationMs !== undefined && !isRoot &&
      duration !== undefined && duration < minDurationMs
    ) {
      return;
    }
    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const durationText = duration === undefined ? "running" : formatDurationMs(duration);
    const errorText = node.span.status === "error" && node.span.errorMessage !== null
      ? ` — ${node.span.errorMessage.split("\n")[0]?.slice(0, 120) ?? ""}`
      : "";
    lines.push(`${prefix}${connector}${spanGlyph(node.span)} ${spanLabel(node.span)} · ${durationText}${errorText}`);
    const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    node.children.forEach((child, index) => {
      renderNode(child, childPrefix, index === node.children.length - 1, false);
    });
  };
  const roots = buildWorkflowSpanTree(spans);
  roots.forEach((root) => renderNode(root, "", true, true));
  const traceId = spans[0]?.traceId;
  if (traceId !== undefined) lines.push(`trace: ${traceId} · spans: ${spans.length}`);
  return lines.join("\n");
};

// ---------- OTLP/HTTP JSON export (hand-rolled: no OpenTelemetry SDK dependency) ----------

type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

const otlpValue = (value: unknown): OtlpAnyValue => {
  switch (typeof value) {
    case "string":
      return { stringValue: value };
    case "boolean":
      return { boolValue: value };
    case "number":
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    case "bigint":
      return { intValue: value.toString() };
    default:
      return { stringValue: JSON.stringify(value) ?? String(value) };
  }
};

const otlpKeyValues = (attributes: Record<string, unknown>) =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));

/**
 * Serialize span records as an OTLP/HTTP JSON `ExportTraceServiceRequest`,
 * POSTable to any collector's `/v1/traces` endpoint.
 */
export const workflowSpansToOtlpJson = (
  spans: ReadonlyArray<WorkflowSpanRecord>,
  resource: { readonly serviceName: string; readonly attributes?: Record<string, unknown> },
): unknown => ({
  resourceSpans: [
    {
      resource: {
        attributes: otlpKeyValues({ "service.name": resource.serviceName, ...(resource.attributes ?? {}) }),
      },
      scopeSpans: [
        {
          scope: { name: "prism.workflow" },
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId !== null ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: 1,
            startTimeUnixNano: span.startNs.toString(),
            endTimeUnixNano: (span.endNs ?? span.startNs).toString(),
            attributes: otlpKeyValues({ ...span.attributes, ...(span.taskId !== null ? { "prism.task_id": span.taskId } : {}), "prism.run_id": span.runId }),
            status: span.status === "error"
              ? { code: 2, ...(span.errorMessage !== null ? { message: span.errorMessage } : {}) }
              : span.status === "ok"
                ? { code: 1 }
                : { code: 0 },
          })),
        },
      ],
    },
  ],
});

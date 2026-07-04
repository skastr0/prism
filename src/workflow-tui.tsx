import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { exitWith } from "./exit.js";
import { expandPath } from "./fs.js";
import { resolvePrismHome } from "./prism-home.js";
import {
  defaultWorkflowStorePath,
  WorkflowStore,
  type WorkflowCacheBadge,
  type WorkflowMonitorRunDetail,
  type WorkflowMonitorState,
  type WorkflowMonitorTask,
} from "./workflow-store.js";
import {
  stopWorkflowRun,
  updateDetachedWorkflowRun,
  type WorkflowDetachedRunOptions,
} from "./workflow-controls.js";

type Pane = "runs" | "tasks";
type ConfirmAction = "stop" | "update" | null;

export interface WorkflowMonitorOptions {
  readonly storePath?: string;
  readonly pollMs?: number;
  readonly failStaleAfterMs?: number;
}

const emptyState: WorkflowMonitorState = { runs: [], selectedRun: null };

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const shortId = (value: string): string =>
  value.length <= 12 ? value : value.slice(0, 8);

const truncate = (value: string, max = 1_200): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n... truncated ${value.length - max} chars`;

const jsonBlock = (value: unknown, max?: number): string =>
  truncate(JSON.stringify(value, null, 2), max);

const badgeText = (badges: ReadonlyArray<WorkflowCacheBadge>): string =>
  badges.length === 0 ? "-" : badges.join(" ");

const durationText = (durationMs: number | null): string =>
  durationMs === null ? "-" : `${durationMs}ms`;

const statusColor = (status: string): string => {
  switch (status) {
    case "completed":
      return "#9ece6a";
    case "failed":
    case "escalated":
      return "#f7768e";
    case "running":
      return "#7dcfff";
    default:
      return "#a9b1d6";
  }
};

const badgeColor = (badge: WorkflowCacheBadge): string => {
  if (badge === "hit" || badge === "cached") return "#9ece6a";
  if (badge === "miss" || badge === "fresh") return "#e0af68";
  if (badge === "skipped") return "#7aa2f7";
  if (badge === "write") return "#bb9af7";
  if (badge === "mock") return "#f7768e";
  return "#ff9e64";
};

const renderBadgeLine = (badges: ReadonlyArray<WorkflowCacheBadge>): string =>
  badges.length === 0 ? "cache -" : `cache ${badgeText(badges)}`;

const workflowOptionsFromSnapshot = (
  options: Record<string, unknown> | undefined,
): WorkflowDetachedRunOptions => {
  const out: {
    mockOutput?: string;
    worker?: string;
    model?: string;
    maxConcurrentTasks?: number;
    cache?: boolean;
  } = {};
  if (typeof options?.mockOutput === "string") out.mockOutput = options.mockOutput;
  if (typeof options?.worker === "string") out.worker = options.worker;
  if (typeof options?.model === "string") out.model = options.model;
  if (typeof options?.maxConcurrentTasks === "number" && Number.isInteger(options.maxConcurrentTasks)) {
    out.maxConcurrentTasks = options.maxConcurrentTasks;
  }
  if (options?.cache === false) out.cache = false;
  return out;
};

const loadMonitorState = async (
  storePath: string,
  selectedRunId: string | undefined,
  failStaleAfterMs: number | undefined,
): Promise<WorkflowMonitorState> => {
  const store = await WorkflowStore.open(storePath);
  try {
    if (failStaleAfterMs !== undefined) {
      store.failStaleRuns(failStaleAfterMs);
    }
    return store.workflowMonitorState(selectedRunId);
  } finally {
    store.close();
  }
};

function CacheBadges({ badges }: { readonly badges: ReadonlyArray<WorkflowCacheBadge> }) {
  if (badges.length === 0) {
    return <text content="-" style={{ fg: "#565f89" }} />;
  }
  return (
    <text>
      {badges.map((badge, index) => (
        <span key={`${badge}-${index}`} fg={badgeColor(badge)}>
          {index === 0 ? badge : ` ${badge}`}
        </span>
      ))}
    </text>
  );
}

function RunPane({
  state,
  selectedRunId,
  focused,
}: {
  readonly state: WorkflowMonitorState;
  readonly selectedRunId?: string;
  readonly focused: boolean;
}) {
  return (
    <box
      title={`Runs${focused ? " *" : ""}`}
      style={{
        width: 36,
        height: "100%",
        border: true,
        borderColor: focused ? "#7dcfff" : "#3b4261",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {state.runs.length === 0 ? (
        <text content="No workflow runs in this cwd store." style={{ width: "100%", fg: "#565f89", wrapMode: "word" }} />
      ) : (
        state.runs.map((run) => {
          const selected = run.run.runId === selectedRunId;
          const content = `${selected ? ">" : " "} ${shortId(run.run.runId)} ${run.run.status} t${run.totals.totalTasks} ${badgeText(run.cacheBadges)} ${run.run.workflow}`;
          return (
            <text
              key={run.run.runId}
              content={content}
              style={{
                width: "100%",
                fg: selected ? "#ffffff" : statusColor(run.run.status),
                attributes: selected ? 1 : 0,
                wrapMode: "none",
                truncate: true,
              }}
            />
          );
        })
      )}
    </box>
  );
}

function TaskList({
  run,
  selectedTaskIndex,
  focused,
}: {
  readonly run: WorkflowMonitorRunDetail | null;
  readonly selectedTaskIndex: number;
  readonly focused: boolean;
}) {
  const phaseGroups = useMemo(() => {
    const groups: Array<{ phase: string; tasks: Array<{ task: WorkflowMonitorTask; index: number }> }> = [];
    for (const [index, task] of (run?.tasks ?? []).entries()) {
      const phase = task.phase ?? "Tasks";
      let group = groups.find((candidate) => candidate.phase === phase);
      if (group === undefined) {
        group = { phase, tasks: [] };
        groups.push(group);
      }
      group.tasks.push({ task, index });
    }
    return groups;
  }, [run]);

  return (
    <box
      title={`Tasks${focused ? " *" : ""}`}
      style={{
        width: "100%",
        height: "42%",
        border: true,
        borderColor: focused ? "#7dcfff" : "#3b4261",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {run === null ? (
        <text content="Select a run." style={{ width: "100%", fg: "#565f89" }} />
      ) : run.tasks.length === 0 ? (
        <text content="No task events yet." style={{ width: "100%", fg: "#565f89" }} />
      ) : (
        phaseGroups.flatMap((group) => [
          <text
            key={`phase-${group.phase}`}
            content={group.phase}
            style={{ width: "100%", fg: "#bb9af7", attributes: 1, wrapMode: "none", truncate: true }}
          />,
          ...group.tasks.map(({ task, index }) => {
            const selected = index === selectedTaskIndex;
            return (
              <text
                key={`${task.taskId}-${index}`}
                content={`${selected ? ">" : " "} ${task.taskId} ${task.status} ${badgeText(task.badges)}`}
                style={{
                  width: "100%",
                  fg: selected ? "#ffffff" : statusColor(task.status),
                  attributes: selected ? 1 : 0,
                  wrapMode: "none",
                  truncate: true,
                }}
              />
            );
          }),
        ])
      )}
    </box>
  );
}

function DetailPane({
  run,
  task,
  confirm,
  error,
}: {
  readonly run: WorkflowMonitorRunDetail | null;
  readonly task: WorkflowMonitorTask | null;
  readonly confirm: ConfirmAction;
  readonly error: string | null;
}) {
  const content = useMemo(() => {
    if (run === null) return "No run selected.";
    const lines = [
      `run ${run.run.runId}`,
      `workflow ${run.run.workflow}`,
      `status ${run.run.status}`,
      `duration ${durationText(run.totals.durationMs)}`,
      `tasks total ${run.totals.totalTasks} fresh ${run.totals.freshExecutions} hits ${run.totals.cacheHits} repairs ${run.totals.repairs}`,
      `cache ${badgeText(run.cacheBadges)}`,
      `workflow file ${run.snapshot?.workflowFile ?? "-"}`,
      "",
    ];
    if (task === null) {
      lines.push("No task selected.");
    } else {
      lines.push(
        `task ${task.taskId}`,
        `phase ${task.phase ?? "-"}`,
        `status ${task.status}`,
        `agent ${task.agent?.plugin ?? task.snapshot?.agent.plugin ?? "-"}.${task.agent?.name ?? task.snapshot?.agent.name ?? "-"}`,
        `worker ${task.workerAdapter ?? task.snapshot?.worker?.worker ?? "-"}`,
        `model ${task.model ?? task.snapshot?.worker?.model ?? "-"}`,
        `cache ${badgeText(task.badges)}`,
        `cache key ${task.cacheKey ?? task.snapshot?.cacheKey ?? "-"}`,
        `last event ${task.lastEventType ?? "-"}`,
        `external session ${task.externalSessionPointer ?? "-"}`,
        "",
        "prompt",
        truncate(task.prompt ?? task.snapshot?.prompt ?? "-", 1_000),
        "",
        "output",
        task.output === undefined ? "-" : jsonBlock(task.output, 1_500),
        "",
        "metadata",
        task.metadata === undefined ? "-" : jsonBlock(task.metadata, 1_200),
      );
    }
    if (confirm !== null) {
      lines.push("", `Confirm ${confirm}: press Enter. Esc cancels.`);
    }
    if (error !== null) {
      lines.push("", `Error: ${error}`);
    }
    return lines.join("\n");
  }, [run, task, confirm, error]);

  return (
    <box
      title="Detail"
      style={{
        width: "100%",
        flexGrow: 1,
        border: true,
        borderColor: "#3b4261",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <scrollbox style={{ width: "100%", height: "100%", scrollY: true }}>
        <text content={content} style={{ fg: "#c0caf5", wrapMode: "word" }} />
      </scrollbox>
    </box>
  );
}

function Footer({
  autoRefresh,
  pollMs,
  selectedRun,
}: {
  readonly autoRefresh: boolean;
  readonly pollMs: number;
  readonly selectedRun: WorkflowMonitorRunDetail | null;
}) {
  const updateHint = selectedRun?.canUpdate === true ? "u update" : "u update-disabled";
  return (
    <box style={{ height: 2, width: "100%", border: ["top"], borderColor: "#3b4261", paddingLeft: 1 }}>
      <text
        content={`j/k move  tab pane  enter select/confirm  s stop  ${updateHint}  r refresh  a auto:${autoRefresh ? "on" : "off"}(${pollMs}ms)  q quit`}
        style={{ width: "100%", fg: "#a9b1d6", wrapMode: "none", truncate: true }}
      />
    </box>
  );
}

export function WorkflowMonitorApp({
  storePath,
  pollMs,
  failStaleAfterMs,
}: {
  readonly storePath: string;
  readonly pollMs: number;
  readonly failStaleAfterMs?: number;
}) {
  const renderer = useRenderer();
  const [state, setState] = useState<WorkflowMonitorState>(emptyState);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [pane, setPane] = useState<Pane>("runs");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (runId = selectedRunId) => {
    try {
      const next = await loadMonitorState(storePath, runId, failStaleAfterMs);
      setState(next);
      const nextRunId = next.selectedRun?.run.runId ?? next.runs[0]?.run.runId;
      setSelectedRunId(nextRunId);
      setSelectedTaskIndex((index) => clamp(index, 0, Math.max(0, (next.selectedRun?.tasks.length ?? 1) - 1)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const scheduleRefresh = (runId?: string): void => {
    refresh(runId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  useEffect(() => {
    scheduleRefresh();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(scheduleRefresh, pollMs);
    return () => clearInterval(timer);
  }, [autoRefresh, pollMs, selectedRunId, failStaleAfterMs]);

  const selectedRun = state.selectedRun;
  const selectedTask = selectedRun?.tasks[selectedTaskIndex] ?? null;

  useKeyboard((key) => {
    const move = key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0;
    if (confirm !== null) {
      if (key.name === "escape") setConfirm(null);
      if (key.name === "return") {
        const run = selectedRun;
        setConfirm(null);
        if (run === null) return;
        if (confirm === "stop") {
          void (async () => {
            const store = await WorkflowStore.open(storePath);
            try {
              stopWorkflowRun(store, run.run.runId, "stop-requested");
            } finally {
              store.close();
            }
            await refresh(run.run.runId);
          })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
        if (confirm === "update" && run.snapshot !== undefined) {
          void updateDetachedWorkflowRun({
            runId: run.run.runId,
            file: run.snapshot.workflowFile,
            storePath,
            options: workflowOptionsFromSnapshot(run.snapshot.options),
          })
            .then((result) => refresh(result.runId))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
      }
      return;
    }
    if (key.name === "q") {
      renderer?.destroy();
      exitWith(0);
    }
    if (key.name === "tab") {
      setPane((current) => (current === "runs" ? "tasks" : "runs"));
      return;
    }
    if (key.name === "r") {
      scheduleRefresh();
      return;
    }
    if (key.name === "a") {
      setAutoRefresh((current) => !current);
      return;
    }
    if (key.name === "s" && selectedRun?.run.status === "running") {
      setConfirm("stop");
      return;
    }
    if (key.name === "u" && selectedRun?.canUpdate === true) {
      setConfirm("update");
      return;
    }
    if (key.name === "return" && pane === "runs") {
      setPane("tasks");
      return;
    }
    if (move !== 0) {
      if (pane === "runs") {
        const index = state.runs.findIndex((run) => run.run.runId === selectedRunId);
        const nextIndex = clamp(index + move, 0, Math.max(0, state.runs.length - 1));
        const nextRunId = state.runs[nextIndex]?.run.runId;
        setSelectedRunId(nextRunId);
        setSelectedTaskIndex(0);
        scheduleRefresh(nextRunId);
      } else {
        setSelectedTaskIndex((index) => clamp(index + move, 0, Math.max(0, (selectedRun?.tasks.length ?? 1) - 1)));
      }
    }
  });

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#16161e" }}>
      <box style={{ width: "100%", flexGrow: 1, flexDirection: "row" }}>
        <RunPane state={state} selectedRunId={selectedRunId} focused={pane === "runs"} />
        <box style={{ flexGrow: 1, height: "100%", flexDirection: "column" }}>
          <TaskList run={selectedRun} selectedTaskIndex={selectedTaskIndex} focused={pane === "tasks"} />
          <DetailPane run={selectedRun} task={selectedTask} confirm={confirm} error={error} />
        </box>
      </box>
      <Footer autoRefresh={autoRefresh} pollMs={pollMs} selectedRun={selectedRun} />
    </box>
  );
}

export const runWorkflowMonitor = async (options: WorkflowMonitorOptions = {}): Promise<void> => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });
  const storePath = expandPath(options.storePath ?? defaultWorkflowStorePath(resolvePrismHome(), process.cwd()));
  createRoot(renderer).render(
    <WorkflowMonitorApp
      storePath={storePath}
      pollMs={options.pollMs ?? 500}
      failStaleAfterMs={options.failStaleAfterMs}
    />,
  );
};

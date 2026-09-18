/**
 * Reference body: workflow scheduling (0.7.0).
 * Product documentation, not plugin data. No frontmatter — the loader owns the
 * skill file; this module contributes one chapter of its body.
 */

export const SCHEDULING_REFERENCE_MARKDOWN = `# Scheduling

A workflow can declare a cron policy and be launched by a local scheduler. Scheduling has three separate gates, and keeping them separate is the design.

| Gate | What happens | What does not happen |
|---|---|---|
| **Declare** — \`schedule: { … }\` in a workflow file | The policy is recorded on the definition object. | Nothing is registered. Importing, typechecking, validating, and running the file are side-effect-free with respect to scheduling. |
| **Install** — \`prism workflow schedule install <file>\` | Prism validates the workflow and the policy and writes one schedule row into the scheduler store. | Nothing starts running, and no execution is created. |
| **Serve** — \`prism workflow scheduler serve\` | The scheduler watches the store and launches due workflows. | Editing the workflow file does not change installed scheduling configuration. |

Declaring a schedule registers nothing. Reinstalling an unchanged declaration is a no-op; reinstalling a changed one bumps the schedule's revision, and the revision is checked again at the moment of launch.

**The asymmetry.** A task or prompt edit takes effect on the next run with no reinstall. A schedule edit requires reinstalling. The installed schedule is data that crossed a process boundary, and Prism does not silently reinterpret data it did not write in this process.

## Declaring a schedule

\`\`\`ts
import { defineTask, defineWorkflow } from "prism";

export default defineWorkflow({
  name: "inbox-router",
  schedule: {
    cron: "*/10 * * * *",
    timezone: "America/Sao_Paulo",
    overlap: "skip",
    missedRuns: "skip",
  },
  run: (wf) => /* an Effect program */,
});
\`\`\`

Both \`defineWorkflow\` forms accept \`schedule\` — the static \`tasks\` list and the dynamic \`run\` program. Declaring one is always inert.

| Field | Type | Semantics |
|---|---|---|
| \`cron\` | \`string\` | Five fields: \`minute hour day-of-month month day-of-week\`. |
| \`timezone\` | \`string\` | A **named** IANA zone, such as \`America/Sao_Paulo\` or \`UTC\`. |
| \`overlap\` | \`"skip"\` | At most one unresolved execution per schedule. |
| \`missedRuns\` | \`"skip"\` | Overdue occurrences coalesce into at most one opportunity. |

\`overlap\` and \`missedRuns\` each admit exactly one value today. They are closed unions rather than open strings, so a policy Prism does not implement is a TypeScript error where you write it and a hard \`WorkflowScheduleError\` where it is read back from data. There is no "accepted but ignored" state.

## Cron dialect

Prism does not ship a cron parser. It narrows \`effect\`'s \`Cron\` module, which is already a Prism-owned dependency pinned to one exact release. Two deliberate narrowings, both fail-closed:

- **Exactly five fields.** \`Cron.parse\` also accepts a six-field, seconds-first form. Prism rejects it, so an expression copied out of a seconds-capable scheduler cannot silently mean something other than it reads.
- **Named timezones only.** Fixed offsets such as \`+03:00\` are rejected. An offset is not DST-aware, so a schedule declared with one drifts by an hour at a transition — silently, which is the worst way for a scheduler to be wrong. Use a name; \`Etc/GMT+3\` is a name and is accepted.

Accepted forms: \`*\`, \`*/n\`, \`a-b\`, \`a-b/n\`, comma lists, and three-letter month/day names (\`MON-FRI\`). Sunday is both \`0\` and \`7\`. When both day-of-month and day-of-week are restricted, they are ORed per the classic Vixie semantics — \`0 0 1 * MON\` fires on the 1st *and* on Mondays.

### Daylight saving

Two edge cases have a defined answer, asserted by \`src/workflow-scheduler/cron.test.ts\` so they stay a Prism contract rather than an artifact of the installed Effect release:

- **Spring-forward gap** — a wall-clock time that does not exist resolves forward to the first valid instant after the gap. In \`America/New_York\`, \`30 2 * * *\` on 2026-03-08 runs at 03:30 local.
- **Fall-back fold** — a wall-clock time that occurs twice resolves to the **first** of the two. In \`America/New_York\`, \`30 1 * * *\` on 2026-11-01 runs at 01:30 EDT.

## The cursor

Each schedule row stores \`next_due_at\`: the next occurrence Prism intends to run. That stored value is the cursor, and it is the only thing that decides whether a schedule is due. Prism never asks "which occurrences have passed?" — it asks "is the cursor due?".

When a tick finds the cursor due, it consumes exactly one opportunity and advances the cursor to the first occurrence strictly after *now*. It never walks forward occurrence by occurrence.

Consequences, each intended rather than incidental:

- A tick that fires late runs the workflow **once**, not once per missed occurrence.
- A machine asleep for three hours runs the workflow **once** on wake, not eighteen times.
- A workflow that runs longer than its own period cannot accumulate a backlog: the cursor was already advanced past the occurrence currently executing.
- A schedule edit sets a fresh cursor in the same transaction as the new revision, so a stale cursor can never fire the old plan.
- A scheduler restart behaves the same way: an overdue cursor fires one coalesced opportunity on the first tick and then jumps to the next future occurrence. After that single run the cursor is in the future, so even a crash-loop stays quiet until the next occurrence.

## Overlap

\`overlap: "skip"\` means at most one **unresolved** execution per schedule, enforced by a partial unique index rather than a flag — so two schedulers cannot both claim the same schedule even if they somehow both run. A due occurrence that arrives while the previous execution is still running, still reserving, or still *uncertain* is consumed as a skip and recorded as such. It is never queued and never run in parallel.

Occupancy is cleared by **evidence, not by a timer**. A heartbeat that has gone quiet means the execution is unhealthy, not that it is over. On recovery Prism distinguishes four cases:

| Evidence | Classification | Action |
|---|---|---|
| The recorded worker identity is demonstrably still present | **Alive** | Keep the schedule occupied and adopt monitoring. A stale heartbeat is reported as degraded, never as death. |
| A durable run result exists and owned cleanup has finished | **Ended with result** | Reconcile the outcome and close the execution. |
| The original worker is demonstrably absent and there is no durable result | **Dead without result** | Mark the execution interrupted. It is **not** retried. |
| Anything else — a reused pid, an unreadable store, a probe error, an unverifiable identity | **Uncertain** | Keep the schedule occupied, record why, and re-probe. |

Process identity is checked as a triple (pid, boot identity, process start identity), because a live pid is not by itself evidence that the original worker is still there. Only authoritative absence or a verified identity mismatch counts as gone; an uninspectable process is *unknown*.

There is no timeout that force-releases an uncertain execution. Such a timer would be an assertion that the old worker is dead, which is exactly what the evidence does not say. Prism instead offers re-observation, an explicit \`prism workflow scheduler reconcile\`, and automatic resolution after a verified reboot — a reboot being positive proof that the previous processes cannot still be running.

## Installing and operating

\`\`\`bash
# Register the declaration. This is the only thing that activates a schedule.
prism workflow schedule install <file> --store <path-to-project-workflows.sqlite>
prism workflow schedule install <file> --mock-output mocks.json   # token-free rehearsal

prism workflow schedule list                  # next due, active, last outcome
prism workflow schedule show <scheduleId>     # one schedule + recent executions (a unique prefix is accepted)
prism workflow schedule disable <scheduleId>  # stops launching; a running execution is left alone
prism workflow schedule enable <scheduleId>   # allow launching again; the cursor is preserved
prism workflow schedule remove <scheduleId>   # refused while an execution occupies it

prism workflow scheduler serve                # watch and launch, in the foreground
prism workflow scheduler serve --once         # one tick, waiting for what it started
prism workflow scheduler serve --poll-ms <ms> # how often to check for due schedules
prism workflow scheduler reconcile            # resolve executions left by a previous scheduler
prism workflow scheduler status               # is a scheduler running, and what is each schedule doing

prism workflow scheduler install-service      # macOS: run the scheduler at login, under launchd
prism workflow scheduler uninstall-service
\`\`\`

\`install\` also takes \`--worker\`, \`--model\`, and \`--permission\` (fallbacks for tasks that pin none) and \`--json\`. \`list\`, \`show\`, \`serve\`, \`reconcile\`, and \`status\` take \`--json\`.

\`--store\` defaults to the current project's workflow store; pass it explicitly when the schedule's ledger rows should land elsewhere. That store is where a scheduled run's ledger row is written and where \`prism workflow runs\` will show it.

**\`install\` does not use \`validateWorkflowFile\`.** That function probes a dynamic workflow by running it with \`wf.runTask\` mocked, so installing would execute the author's \`run\` program and any effects it performs before the first task. Loading the module is unavoidable — the declaration lives in it — so the honest statement of the boundary is this: *declaring* a schedule registers nothing, and *installing* never runs \`run\`. Prism does not claim that importing an arbitrary TypeScript module is free of top-level side effects, because it is not.

**\`--once\` as a cron entry.** \`--once\` runs recovery and one tick and waits for the executions that tick started, so the caller gets a real exit status rather than "a process was launched". That makes it a complete foreground alternative to a long-running daemon:

\`\`\`cron
*/10 * * * *  PRISM_HOME=$HOME/.prism prism workflow scheduler serve --once >>$HOME/.prism/scheduler.log 2>&1
\`\`\`

Overlap is still safe under that arrangement: the occupancy index is in the database, so two overlapping invocations cannot both run one schedule. A \`--once\` invocation exits non-zero when its tick had failures; the daemon does not, because a graceful signal is not a failure and a service manager would read a nonzero exit as a crash to restart.

**\`serve\` and the instance lock.** \`serve\` takes the machine-wide instance lock; a second scheduler reports that one is already running and exits successfully, because losing that race means the desired state already holds. Stop it with SIGTERM/SIGINT/SIGHUP: the loop stops claiming, records which executions it left running, and releases the lock last. In-flight runners are **not** killed — they are detached children with their own ledger rows, and the next scheduler adopts them.

**\`install-service\` (macOS).** It writes one LaunchAgent for this Prism home and bootstraps it. launchd owns the process; Prism owns the schedules — there is no agent per workflow, because a schedule is data and one service watching one catalog is what makes the instance lock meaningful. The plist contains no \`StartCalendarInterval\`: two authorities for the same fact would be a bug. The agent does not run the scheduler directly; it runs \`/bin/sh\` with a short preflight that checks the Prism executable and then \`exec\`s it, so the launcher does not live inside a bundle an upgrade can delete. \`PRISM_HOME\` and \`PATH\` are written into the plist; credentials are not — the plist is readable and secrets belong in the harness's own credential store. \`uninstall-service\` boots out the agent and removes its own plist, keeping schedules and run history. \`install-service\` refuses while a hand-started scheduler holds the lock, because a managed agent that lost that race would exit 0 and never supervise the running one. On a host without launchd both commands fail closed with an environment error and point at \`serve\`/\`--once\`; there is no systemd backend yet.

**Monitoring.** \`scheduler status\` reports lock occupancy and instance-record freshness as two separate facts and prints no aggregate health boolean — "lock held, metadata stale" is not healthy, and a single green light over independent facts is how a degraded scheduler looks healthy.

**Reading the execution states.**

| Status | Means |
|---|---|
| \`reserved\` | The launch was authorized and nothing has been observed yet. |
| \`running\` | A runner claimed the authorization and recorded its identity. |
| \`completed\` / \`failed\` | The run reached a terminal status; the outcome is durable. |
| \`interrupted\` | The runner is demonstrably gone and the run recorded no outcome. Not retried. |
| \`uncertain\` | The evidence does not settle it. The schedule stays occupied. |
| \`skipped-overlap\` | A due occurrence arrived while the previous execution was unresolved. |
| \`cancelled\` | The authorization was never consumed, so no workflow code ran. |
| \`launch-failed\` | The runner process could not be spawned. |

## What the scheduler is not

- **Not a durable replay engine.** Prism supervises auditable attempts; it does not keep executing until something succeeds. A failed workflow stays failed, and the next ordinary occurrence is eligible on its own merits.
- **Not a repair loop.** Failures do not launch an agent to diagnose themselves.
- **Not a source of runtime limits.** Scheduling introduces no cap on task runtime, output size, prompt size, run wall clock, task count, or cost — the same doctrine the run CLI already states. Scope belongs in the prompt, the model, and the graph.
- **Not a resource lock across workflows.** Overlap is per installed schedule. Excluding unrelated workflows from each other is a domain concern and belongs in userland.
- **Not a service installer on every host.** \`serve\` runs in the foreground and is meant to be supervised by whatever already supervises your processes.
`;

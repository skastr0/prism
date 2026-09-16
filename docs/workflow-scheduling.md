# Prism workflow scheduling

How a workflow declares a schedule, what the declaration does and does not do, and the exact
semantics the scheduler guarantees. For the workflow language itself, see
[workflows.md](./workflows.md).

- [The three gates](#the-three-gates)
- [Declaring a schedule](#declaring-a-schedule)
- [Cron dialect](#cron-dialect)
- [The cursor](#the-cursor)
- [Overlap](#overlap)
- [What the scheduler is not](#what-the-scheduler-is-not)

## The three gates

Scheduling has three separate steps, and keeping them separate is the whole design:

| Gate | What happens | What does not happen |
|---|---|---|
| **Declare** — `schedule: { … }` in a workflow file | The policy is recorded on the definition object. | Nothing is registered. Importing, typechecking, validating, and running the file are all side-effect-free with respect to scheduling. |
| **Install** — `prism workflow schedule install <file>` | Prism validates the workflow and the policy, and writes one schedule row into the scheduler store. | Nothing starts running, and no execution is created. |
| **Serve** — `prism workflow scheduler serve` | The scheduler process watches the store and launches due workflows. | Editing the workflow file does not change installed scheduling configuration. |

`--once` runs recovery and a single tick, and **waits for the executions that tick started**. That
makes it usable as a foreground cron entry, where the caller needs a real exit status rather than
"a process was launched". `--once` and `scheduler reconcile` are also how you exercise a schedule
without leaving a daemon running.

So a task or prompt edit takes effect on the next run with no reinstall, while a schedule edit
requires reinstalling. That asymmetry is deliberate: the installed schedule is data that crossed a
process boundary, and Prism does not silently reinterpret data it did not write in this process.

Installing a schedule is not the same as editing one. Reinstalling an unchanged declaration is a
no-op; reinstalling a changed one bumps the schedule's revision, and the revision is checked again
at the moment of launch.

## Declaring a schedule

```ts
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
```

Every field:

| Field | Type | Semantics |
|---|---|---|
| `cron` | `string` | Five fields: `minute hour day-of-month month day-of-week`. See [Cron dialect](#cron-dialect). |
| `timezone` | `string` | A **named** IANA zone, such as `America/Sao_Paulo` or `UTC`. |
| `overlap` | `"skip"` | At most one unresolved execution per schedule. See [Overlap](#overlap). |
| `missedRuns` | `"skip"` | Overdue occurrences coalesce into at most one opportunity. See [The cursor](#the-cursor). |

`overlap` and `missedRuns` each admit exactly one value today. They are closed unions rather than
open strings, so a policy Prism does not implement is a TypeScript error where you write it and a
hard `WorkflowScheduleError` where it is read back from data. There is no "accepted but ignored"
state.

Both `defineWorkflow` forms accept `schedule` — the static `tasks` list and the dynamic `run`
program. Declaring one is always inert.

## Cron dialect

Prism does not ship a cron parser. It narrows `effect`'s `Cron` module, which is already a
Prism-owned dependency pinned to one exact release. Two deliberate narrowings, both fail-closed:

**Exactly five fields.** `Cron.parse` also accepts a six-field, seconds-first form. Prism rejects
it, so an expression copied out of a seconds-capable scheduler cannot silently mean something other
than it reads.

**Named timezones only.** Fixed offsets such as `+03:00` are rejected. An offset is not DST-aware,
so a schedule declared with one drifts by an hour at a transition — and it drifts silently, which is
the worst way for a scheduler to be wrong. Use a name; `Etc/GMT+3` is a name and is accepted.

Accepted forms: `*`, `*/n`, `a-b`, `a-b/n`, comma lists, and three-letter month/day names
(`MON-FRI`). Sunday is both `0` and `7`. When both day-of-month and day-of-week are restricted,
they are ORed, per the classic Vixie semantics — `0 0 1 * MON` fires on the 1st *and* on Mondays.

### Daylight saving

Two edge cases have a defined answer, asserted by `src/workflow-scheduler/cron.test.ts` so they stay
a Prism contract rather than an artifact of the installed Effect release:

- **Spring-forward gap** — a wall-clock time that does not exist resolves forward to the first valid
  instant after the gap. In `America/New_York`, `30 2 * * *` on 2026-03-08 runs at 03:30 local.
- **Fall-back fold** — a wall-clock time that occurs twice resolves to the **first** of the two. In
  `America/New_York`, `30 1 * * *` on 2026-11-01 runs at 01:30 EDT.

## The cursor

Each schedule row stores `next_due_at`: the next occurrence Prism intends to run. That stored value
is the cursor, and it is the only thing that decides whether a schedule is due. Prism never asks
"which occurrences have passed?" — it asks "is the cursor due?".

That choice is what makes the missed-run behaviour fall out instead of needing its own rules. When a
tick finds the cursor due, it consumes exactly one opportunity and advances the cursor to the first
occurrence strictly after *now*. It never walks forward occurrence by occurrence.

Consequences, each of which is the intended behaviour rather than a side effect:

- A tick that fires late runs the workflow **once**, not once per missed occurrence.
- A machine asleep for three hours runs the workflow **once** on wake, not eighteen times.
- A workflow that runs longer than its own period cannot accumulate a backlog: the cursor was
  already advanced past the occurrence that is currently executing.
- A schedule edit sets a fresh cursor in the same transaction as the new revision, so a stale
  cursor can never fire the old plan.

A **scheduler restart** behaves the same way, and that is deliberate. An overdue cursor fires one
coalesced opportunity on the first tick and then jumps to the next future occurrence. Discarding
instead would mean a restart silently swallowed an inbox poll, and it is not needed for safety: after
that single run the cursor is in the future, so even a crash-loop stays quiet until the next
occurrence.

## Overlap

`overlap: "skip"` means at most one **unresolved** execution per schedule, enforced by a partial
unique index rather than by a flag — so two schedulers cannot both claim the same schedule even if
they somehow both run.

A due occurrence that arrives while the previous execution is still running, still reserving, or
still *uncertain* is consumed as a skip and recorded as such. It is never queued and never run in
parallel.

Crucially, occupancy is cleared by **evidence, not by a timer**. A heartbeat that has gone quiet
means the execution is unhealthy, not that it is over. Prism distinguishes four cases when it
recovers:

| Evidence | Classification | Action |
|---|---|---|
| The recorded worker identity is demonstrably still present | **Alive** | Keep the schedule occupied and adopt monitoring. A stale heartbeat is reported as degraded, never as death. |
| A durable run result exists and owned cleanup has finished | **Ended with result** | Reconcile the outcome and close the execution. |
| The original worker is demonstrably absent and there is no durable result | **Dead without result** | Mark the execution interrupted. It is **not** retried. |
| Anything else — a reused pid, an unreadable store, a probe error, an unverifiable identity | **Uncertain** | Keep the schedule occupied, record why, and re-probe. |

Process identity is checked as a triple (pid, boot identity, process start identity), because a live
pid is not by itself evidence that the original worker is still there. Only authoritative absence or
a verified identity mismatch counts as gone; an uninspectable process is *unknown*.

There is no timeout that force-releases an uncertain execution. Such a timer would be an assertion
that the old worker is dead, which is exactly what the evidence does not say. Prism instead offers
re-observation, an explicit `prism workflow scheduler reconcile`, and automatic resolution after a
verified reboot — a reboot being positive proof that the previous processes cannot still be running.

## What the scheduler is not

- **Not a durable replay engine.** Prism supervises auditable attempts; it does not keep executing
  until something succeeds. A failed workflow stays failed, and the next ordinary occurrence is
  eligible on its own merits.
- **Not a repair loop.** Failures do not launch an agent to diagnose themselves.
- **Not a source of runtime limits.** Scheduling introduces no cap on task runtime, output size,
  prompt size, run wall clock, task count, or cost — the same doctrine
  [workflows.md](./workflows.md#running-and-operating) already states. Scope belongs in the prompt,
  the model, and the graph.
- **Not a resource lock across workflows.** Overlap is per installed schedule. Excluding unrelated
  workflows from each other is a domain concern and belongs in userland.

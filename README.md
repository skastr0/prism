<p align="center">
  <img src="assets/brand/prism-icon.png" alt="Prism" width="160" height="160" />
</p>

<h1 align="center">Prism</h1>

<p align="center"><strong>Prism runs your coding agents from typed, checked Effect workflows.</strong></p>

<p align="center">
  Claude Code, Codex, Grok, Kimi, Amp, OpenCode, and more, driven from TypeScript: schema-checked answers, repair loops, and a run ledger you can replay.
</p>

<p align="center">
  <code>npm install -g @skastr0/prism</code>
  ·
  <a href="https://www.npmjs.com/package/@skastr0/prism">npm</a>
  ·
  v0.8.2 · macOS and Linux
</p>

---

## The pain

- **No types.** You ask two agents to review a commit, from a script or a chat. Each answers in its own prose, and you read it or scrape it.
- **No checks, no retries.** A "revise" with no findings flows straight into your next step. A malformed reply or a flaky exit, and you start over by hand.
- **No resume, no record.** The script dies halfway and every finished task runs again at full token cost. Afterwards nothing says which agent answered what, on which model, in how long.

## What Prism does

<p align="center">
  <img src="assets/brand/prism-hero.png" alt="One amber source thread passing through an aperture plane and refracting into many distinct channels" width="720" />
</p>

A task is a harness CLI, a prompt, an Effect `Schema` the answer must decode into, and checks the answer must pass. A workflow is an Effect program over tasks. Prism runs each task through the agent CLI you already have, with its own login, and records every run.

| Prism **is** | Prism **is not** |
|---|---|
| Workflows you write in TypeScript with Effect | A drag-and-drop pipeline builder |
| A runner that drives the agent CLIs you already use | An SDK that calls model APIs |
| Typed: a wrong harness setting fails `typecheck`, a wrong answer fails the schema | Prompt-and-hope JSON scraping |
| A local ledger: every run recorded, finished tasks replayed on rerun | A hosted service |

## Quick start

**1. Install.**

```bash
npm install -g @skastr0/prism
```

**2. Write a workflow.** Two agents review the current commit in parallel and must answer in the same shape. Save it as `review.workflow.ts`:

```ts
import { execSync } from "node:child_process";
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowTaskWorkerOptions } from "prism";

const commit = execSync("git rev-parse --short HEAD").toString().trim();

const Review = Schema.Struct({
  verdict: Schema.Literals(["ship", "revise", "block"]),
  findings: Schema.Array(Schema.String),
});

const review = (id: string, worker: WorkflowTaskWorkerOptions) =>
  defineTask({
    id,
    prompt: `Review commit ${commit} in this repo (git show ${commit}). Is it safe to ship?`,
    output: Review,
    cacheKey: `review-${commit}`,
    worker,
    finish: {
      maxRepairs: 1,
      criteria: [
        {
          name: "a non-ship verdict names its findings",
          check: ({ output }) =>
            output.verdict !== "ship" && output.findings.length === 0
              ? Effect.fail(new Error("verdict without findings"))
              : Effect.void,
          repairPrompt: () => "Name the findings behind your verdict.",
        },
      ],
    },
  });

export default defineWorkflow({
  name: "review-commit",
  run: (wf) =>
    Effect.all(
      [
        wf.runTask(review("codex", { worker: "codex-cli", permission: "sandbox-read-only" })),
        wf.runTask(review("claude", { worker: "claude-code", model: "sonnet", permission: "restricted", restrictedTools: ["Read", "Grep", "Bash(git show:*)"] })),
      ],
      { concurrency: "unbounded" },
    ),
});
```

**3. Typecheck it.** Settings a harness can't honor fail here, before any tokens are spent:

```text
$ prism workflow typecheck review.workflow.ts
Workflow typecheck passed: review.workflow.ts
```

Put `permission: "sandbox-read-only"` (a Codex mode) on the Claude task and you get:

```text
Type '"sandbox-read-only"' is not assignable to type 'ClaudeWorkflowPermissionMode | undefined'.
```

**4. Run it** from inside a Git repo (Codex refuses to run outside one), with Codex and Claude Code logged in. A live run spends their tokens and has no built-in cost cap:

```text
$ prism workflow run review.workflow.ts
{
  "runId": "ee259bf3-204f-4b02-8614-9fa56868bc5b",
  "tasks": [
    { "id": "codex", "status": "completed", "cached": false,
      "output": { "verdict": "revise", "findings": [
        "README.md:117 [MEDIUM] The new prose promises a backup whenever a file is repaired. Source changes also produce a `repair`, but `src/sync/plan.ts:279-280` sets `backup: false` for them; ..." ] } },
    { "id": "claude", "status": "completed", "cached": false,
      "output": { "verdict": "ship", "findings": [ "327d206 is docs-only: ...", ... ] } }
  ]
}
```

**5. Read it back.** Run it again and both tasks replay from the ledger in under 2 seconds. The trace shows what ran:

```text
$ prism workflow runs trace ee259bf3-204f-4b02-8614-9fa56868bc5b
✓ workflow.run · review-commit · 32.9s
└─ ✓ workflow.program · 32.9s
   ├─ ✓ workflow.task · codex · 32.9s
   │  └─ ✓ task.executor · attempt 0 · codex-cli · 32.8s
   └─ ✓ workflow.task · claude · 24.3s
      └─ ✓ task.executor · attempt 0 · claude-code sonnet · 24.3s
```

To rehearse for free, pass `--mock-output mock.json` (answers keyed by task id). Mocked answers still go through the schema and the checks:

```text
$ prism workflow run review.workflow.ts --mock-output mock.json      # codex: "revise", no findings
❌ Workflow run failed: workflow task codex failed finish criterion 'a non-ship verdict names its findings': verdict without findings
```

## What a task gives you

| | |
|---|---|
| `output` | An Effect `Schema`. The answer must decode into it; a bad reply gets up to 2 repair prompts, then the task fails with a typed error. |
| `finish` | Checks on the decoded answer: plain code, or a judge that returns pass, continue, fail, or escalate. `maxRepairs` sets how many retries a failed check gets. |
| `worker` | The harness, model, and permission mode. Each harness only accepts the permission modes it can enforce. |
| `cacheKey` | Finished results are cached by task id, key, and a hash of what ran. Change the prompt or schema and only that task runs again. |
| the ledger | Every run, task, event, and span in a local SQLite store: `prism workflow runs list`, `summary`, `trace`. |

Workflows can be a list of tasks or any Effect program: `Effect.all` for fan-out, `Effect.result` so one failed agent doesn't sink the rest. Judges, phases, named task configurations, detached runs, `resume`, and OTLP export are in [`docs/workflows.md`](docs/workflows.md).

## Harnesses

`prism harnesses` lists 14:

| Harness | ID | Runs tasks | Installs skills and agents |
|---|---|---|---|
| Claude Code | `claude-code` | yes | yes |
| Codex CLI | `codex-cli` | yes | yes |
| OpenCode | `opencode` | yes | yes |
| Grok Build | `grok` | yes | yes |
| Kimi Code | `kimi-code` | yes | yes |
| Amp Code | `amp-code` | yes | yes |
| Antigravity CLI | `antigravity-cli` | yes | yes |
| Oh My Pi | `omp` | yes | yes |
| Devin CLI | `devin` | yes | yes |
| Cursor | `cursor` | yes | yes |
| Hermes Agent | `hermes` | yes | skills and tools |
| Pi | `pi` | no | yes |
| Amp Orb | `amp-orb` | yes | skills into a hosted checkout |
| Amp Runner | `amp-runner` | yes | no |

Details per harness: [`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md).

## One setup for every harness

The same CLI installs one set of agents, skills, rules, tools, and hooks into every harness above, each in its own format. Keep a plugin directory in Git and run `prism refresh`: a second run writes nothing, a file you edited by hand is backed up and repaired, and a file Prism never wrote is refused.

```bash
prism init my-standards --with-agent --with-skill --typescript
prism plan my-standards --all
prism refresh my-standards --harness claude-code,codex-cli,opencode
prism doctor
```

Tools written once run from any harness through `prism tools invoke`: [`docs/tools-architecture.md`](docs/tools-architecture.md). Pinned skills from other repos: [`docs/third-party-skills.md`](docs/third-party-skills.md).

## Where it fits

Several agents on one piece of work, each in its own harness, answering the same typed contract. The agents also share one toolbox: [Quasar](https://github.com/skastr0/quasar) ships its tools as a Prism plugin. More at [castro.engineer/projects/prism](https://castro.engineer/projects/prism).

## Packages

| Package | What it is |
|---|---|
| [`@skastr0/prism`](https://www.npmjs.com/package/@skastr0/prism) | The CLI, with binaries for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` |
| [`@skastr0/prism-sdk`](https://www.npmjs.com/package/@skastr0/prism-sdk) | Core contracts and codecs |
| [`@skastr0/prism-packager`](https://www.npmjs.com/package/@skastr0/prism-packager) | Compile a plugin into harness-native files without the CLI |

## Development

```bash
bun install
bun run build
bun test
```

More in [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Security

Report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

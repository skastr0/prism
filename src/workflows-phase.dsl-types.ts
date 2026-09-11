import { Schema } from "effect";
import {
  defineTask,
  phase,
  type PhaseContract,
  type PhaseCtx,
  type PhaseTaskDefinition,
  type WorkflowRuntime,
  type WorkflowTask,
  type WorkflowTaskOutput,
} from "./workflows.js";

const Input = Schema.Struct({ brief: Schema.String });

const Exploration = Schema.Struct({
  assumption: Schema.String,
  options: Schema.Array(Schema.String),
});

const PatchReport = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
});

const exploreContract = {
  name: "explore",
  sop: "beacon",
  plugin: "forge",
  input: Input,
  output: Exploration,
  criteria: ["Surface at least one option"],
  framing: { purpose: "Reduce ambiguity before build." },
} as const satisfies PhaseContract<"explore", typeof Input, typeof Exploration>;

declare const exploreCtx: PhaseCtx<"explore", typeof Input, typeof Exploration>;
void exploreCtx;

const _defaultTaskDef = {
  id: "scope",
  input: { brief: "go" },
  prompt: "go",
} as const satisfies PhaseTaskDefinition<"scope", typeof Input, typeof Exploration>;

const _overrideTaskDef = {
  id: "override",
  input: { brief: "go" },
  prompt: "go",
  output: PatchReport,
} as const satisfies PhaseTaskDefinition<"override", typeof Input, typeof PatchReport>;

const _wrongInput: PhaseTaskDefinition<"bad", typeof Input, typeof Exploration> = {
  id: "bad",
  // @ts-expect-error input must match the bound phase input contract
  input: { nope: 1 },
  prompt: "go",
};

type DefaultTaskOutput = WorkflowTaskOutput<
  WorkflowTask<"scope", typeof Exploration>
>;
type OverrideTaskOutput = WorkflowTaskOutput<
  WorkflowTask<"override", typeof PatchReport>
>;

const _defaultSatisfiesContract: DefaultTaskOutput = {} as Schema.Schema.Type<typeof Exploration>;
const _overrideSatisfiesPatch: OverrideTaskOutput = {} as Schema.Schema.Type<typeof PatchReport>;

void _defaultTaskDef;
void _overrideTaskDef;
void _wrongInput;
void _defaultSatisfiesContract;
void _overrideSatisfiesPatch;

// Agent-less task: a bare worker + prompt + output schema is valid.
const _agentLessTask = defineTask({
  id: "bare",
  prompt: "go",
  output: Exploration,
});
void _agentLessTask;

// The generated `sops.ts` phase value (as emitted by renderWorkflowSopsModule)
// satisfies PhaseContract and binds through `phase()` without casts.
const generatedSopsPhaseValue = {
  name: "explore",
  sop: "beacon",
  plugin: "forge",
  input: Input,
  output: Exploration,
  criteria: ["Surface at least one option"],
  framing: { purpose: "Reduce ambiguity before build." },
} as const;

declare const runtime: Pick<WorkflowRuntime, "runTask">;

const _boundGeneratedPhase = phase(runtime, generatedSopsPhaseValue, (ctx) =>
  ctx.task({
    id: "scope",
    input: { brief: "typed input from the contract" },
    prompt: "go",
  }),
);
void _boundGeneratedPhase;

declare const exploreHandoff: Schema.Schema.Type<typeof Exploration>;

// @ts-expect-error wrong-shape handoff fails at the consuming call site
const _wrongHandoff: Schema.Schema.Type<typeof PatchReport> = exploreHandoff;

import { Schema } from "effect";
import type {
  PhaseCtx,
  PhaseTaskDefinition,
  WorkflowAgentRef,
  WorkflowTask,
  WorkflowTaskOutput,
} from "./workflows.js";

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

const explorer = {
  ...builder,
  name: "explorer",
  description: "Exploration specialist",
} as const satisfies WorkflowAgentRef;

const reviewer = {
  ...builder,
  name: "simplicity-reviewer",
  description: "Simplicity reviewer",
} as const satisfies WorkflowAgentRef;

const Exploration = Schema.Struct({
  assumption: Schema.String,
  options: Schema.Array(Schema.String),
});

const PatchReport = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
});

type ExploreAgents = { readonly explorer: typeof explorer };

declare const exploreCtx: PhaseCtx<"explore", ExploreAgents, typeof Exploration>;

const _defaultTaskDef = {
  id: "scope",
  agent: exploreCtx.agents.explorer,
  prompt: "go",
} as const satisfies PhaseTaskDefinition<"scope", typeof explorer>;

const _overrideTaskDef = {
  id: "override",
  agent: exploreCtx.agents.explorer,
  prompt: "go",
  output: PatchReport,
} as const satisfies PhaseTaskDefinition<"override", typeof explorer, typeof PatchReport>;

type DefaultTaskOutput = WorkflowTaskOutput<
  WorkflowTask<"scope", typeof explorer, typeof Exploration>
>;
type OverrideTaskOutput = WorkflowTaskOutput<
  WorkflowTask<"override", typeof explorer, typeof PatchReport>
>;

const _defaultSatisfiesContract: DefaultTaskOutput = {} as Schema.Schema.Type<typeof Exploration>;
const _overrideSatisfiesPatch: OverrideTaskOutput = {} as Schema.Schema.Type<typeof PatchReport>;

void _defaultTaskDef;
void _overrideTaskDef;
void _defaultSatisfiesContract;
void _overrideSatisfiesPatch;

// @ts-expect-error cross-phase agents are rejected by the phase agent union
const _crossPhaseAgent: ExploreAgents[keyof ExploreAgents] = reviewer;

declare const exploreHandoff: Schema.Schema.Type<typeof Exploration>;

// @ts-expect-error wrong-shape handoff fails at the consuming call site
const _wrongHandoff: Schema.Schema.Type<typeof PatchReport> = exploreHandoff;
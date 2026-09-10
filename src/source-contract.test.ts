import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  hookEvent,
  type AgentSource,
  type HookSource,
  type ModelspaceSource,
  type OrbitSource,
  type SkillspaceSource,
  type ToolSource,
} from "./index.js";
import {
  AgentSourceSchema,
  HookSourceSchema,
  ModelspaceSourceSchema,
  OrbitSourceSchema,
  SkillspaceSourceSchema,
  ToolSourceSchema,
} from "./compile/sources.js";

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const expectDecodes = <A>(schema: Schema.Schema<A, any, never>, value: unknown): A => {
  const result = Schema.decodeUnknownEither(schema, STRICT_PARSE_OPTIONS)(value);
  expect(result._tag).toBe("Right");
  if (result._tag === "Left") throw new Error(result.left.message);
  return result.right;
};

const expectRejects = (schema: Schema.Schema.AnyNoContext, value: unknown): void => {
  const result = Schema.decodeUnknownEither(schema, STRICT_PARSE_OPTIONS)(value);
  expect(result._tag).toBe("Left");
};

describe("public source contracts", () => {
  test("public source type aliases decode through loader schemas", () => {
    const agent = {
      name: "builder",
      description: "Builds scoped changes.",
      identity: "builder",
      personality: "direct",
      model: { kind: "model-profile-ref", modelspace: "models", name: "default" },
      skills: [{ kind: "skillspace-ref", skillspace: "global", name: "testing" }],
      color: "blue",
      targets: { opencode: { mode: "primary" } },
    } satisfies AgentSource;

    const tool = {
      name: "submit_review",
      description: "Submit review findings.",
      input: Schema.Struct({ summary: Schema.String }),
      output: Schema.Struct({ acknowledged: Schema.Boolean }),
      slots: { verdict: { kind: "schema", description: "Verdict payload." } },
      async handle() {
        return { acknowledged: true };
      },
    } satisfies ToolSource;

    const modelspace = {
      name: "models",
      description: "Model profiles.",
      profiles: {
        default: {
          description: "Default model.",
          targets: { opencode: { model: "openai/gpt-5", temperature: 0.2 } },
        },
      },
    } satisfies ModelspaceSource;

    const skillspace = {
      name: "global",
      description: "Global skills.",
      skills: {
        testing: {
          description: "Testing skill.",
          targets: { opencode: { name: "testing" } },
        },
      },
    } satisfies SkillspaceSource;

    const orbit = {
      name: "delivery",
      description: "Delivery orbit.",
      produces: "Reviewed implementation.",
      definitions: {
        glyphs: { purpose: "Track implementation work." },
      },
      parameters: [{ name: "domain", description: "Domain under change" }],
      phases: [{
        name: "Build",
        agents: [{ kind: "agent-ref", name: "builder" }],
        notes: { Done: "Patch verified." },
        telos: "Implement the change.",
        real_world_change: "Code changes exist.",
        cold_pickup_test: "A reviewer can verify from the diff.",
        workflow: {
          when: "Use this phase when ${domain} implementation is ready.",
          inputs: ["Scoped request", "Current source"],
          outputs: ["Verified patch", "Reviewable summary"],
          sequence: ["Read source", "Apply change", "Validate result"],
          coordination: "Coordinate with the assigned reviewer.",
          finish_criteria: ["Tests pass", "Change is committed"],
          escalation: "Escalate if the requested side effect is unauthorized.",
        },
        body: "Full phase instructions.",
      }],
      orchestrator: {
        agent: { kind: "agent-ref", name: "builder" },
      },
      pulsar_checkpoints: [{ after: "Build", note: "Run Pulsar." }],
      signal_emitter: {
        destinations: [{
          project_key: "prism",
          orbit: "forge",
          default_priority: "normal",
          note: "Route implementation pressure.",
        }],
      },
      evolution: "Promote recurring pressure.",
      body: "Orbit body.",
    } satisfies OrbitSource;

    const hook = {
      name: "session-start",
      description: "Observe session start.",
      event: hookEvent.sessionStart,
      handle: () => Effect.succeed({ decision: "continue" as const }),
    } satisfies HookSource<typeof hookEvent.sessionStart>;

    expectDecodes(AgentSourceSchema, agent);
    expectDecodes(ToolSourceSchema, tool);
    expectDecodes(ModelspaceSourceSchema, modelspace);
    expectDecodes(SkillspaceSourceSchema, skillspace);
    const decodedOrbit = expectDecodes(OrbitSourceSchema, orbit);
    expect(decodedOrbit.phases[0]?.workflow?.sequence).toEqual([
      "Read source",
      "Apply change",
      "Validate result",
    ]);
    expectDecodes(HookSourceSchema, hook);
  });

  test("agent access and traits are rejected as unknown fields", () => {
    const base = {
      name: "builder",
      description: "Builds scoped changes.",
      identity: "builder",
    };
    expectRejects(AgentSourceSchema, { ...base, traits: ["committable"] });
    expectRejects(AgentSourceSchema, {
      ...base,
      access: { skills: [{ kind: "skill-ref", name: "testing" }] },
    });
  });

  test("orbit tool permissions and trait requirements are rejected", () => {
    const base = {
      name: "delivery",
      description: "Delivery orbit.",
      phases: [{ name: "Build", agents: ["builder"] }],
    };
    expectRejects(OrbitSourceSchema, {
      ...base,
      tool_permissions: [{ ref: "protocol:submit_work", as: "submit_work" }],
    });
    expectRejects(OrbitSourceSchema, {
      ...base,
      phases: [{ name: "Build", agents: ["builder"], requires: [{ all: ["committable"] }] }],
    });
    expectRejects(OrbitSourceSchema, {
      ...base,
      orchestrator: { agent: "builder", tools: [{ ref: "protocol:create_glyph" }] },
    });
  });

  test("hook matchers accept any, native tool names, and canonical refs only", () => {
    const base = {
      name: "tool-guard",
      description: "Guard a tool.",
      event: hookEvent.toolBefore,
      handle: () => Effect.succeed({ decision: "continue" as const }),
    } satisfies HookSource<typeof hookEvent.toolBefore>;

    expectDecodes(HookSourceSchema, {
      ...base,
      match: { tool: { kind: "hook-any-tool" } },
    });
    expectDecodes(HookSourceSchema, {
      ...base,
      match: { tool: { kind: "hook-native-tool", name: "Bash" } },
    });
    expectDecodes(HookSourceSchema, {
      ...base,
      match: { tool: { kind: "hook-canonical-tool", ref: "submit_review" } },
    });
    expectRejects(HookSourceSchema, {
      ...base,
      match: { tool: { kind: "hook-toolspace-tool", tool: "workspace/run_shell" } },
    });
    expectRejects(HookSourceSchema, {
      ...base,
      match: { tool: { kind: "hook-toolspace-group", group: "workspace#repo" } },
    });
  });
});

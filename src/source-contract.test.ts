import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  hookEvent,
  type AgentSource,
  type HookSource,
  type ModelspaceSource,
  type SkillspaceSource,
  type SopSource,
  type ToolSource,
} from "./index.js";
import {
  AgentSourceSchema,
  HookSourceSchema,
  ModelspaceSourceSchema,
  SkillspaceSourceSchema,
  SopSourceSchema,
  ToolSourceSchema,
} from "./compile/sources.js";

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const expectDecodes = <A>(schema: Schema.Decoder<A, never>, value: unknown): A => {
  const result = Schema.decodeUnknownResult(schema, STRICT_PARSE_OPTIONS)(value);
  expect(result._tag).toBe("Success");
  if (result._tag === "Failure") throw new Error(result.failure.message);
  return result.success;
};

const expectRejects = (
  schema: Schema.Codec<unknown, unknown, never, never>,
  value: unknown,
): void => {
  const result = Schema.decodeUnknownResult(schema, STRICT_PARSE_OPTIONS)(value);
  expect(result._tag).toBe("Failure");
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

    const hook = {
      name: "session-start",
      description: "Observe session start.",
      event: hookEvent.sessionStart,
      handle: () => Effect.succeed({ decision: "continue" as const }),
    } satisfies HookSource<typeof hookEvent.sessionStart>;

    const sop = {
      name: "beacon",
      description: "Marketing method.",
      phases: [
        {
          name: "explore",
          purpose: "Map the space before committing.",
          input: Schema.Struct({ brief: Schema.String }),
          output: Schema.Struct({ summary: Schema.String }),
          acceptance_criteria: ["Positioning hypothesis is falsifiable"],
          escalation: "Ask a human when the audience is unclear.",
          body: "Read the brief.",
        },
        {
          name: "build",
          purpose: "Produce the artifact.",
          body: "Write it.",
        },
      ],
      body: "Cross-phase frame.",
    } satisfies SopSource;

    expectDecodes(AgentSourceSchema, agent);
    expectDecodes(ToolSourceSchema, tool);
    expectDecodes(ModelspaceSourceSchema, modelspace);
    expectDecodes(SkillspaceSourceSchema, skillspace);
    expectDecodes(HookSourceSchema, hook);
    const decodedSop = expectDecodes(SopSourceSchema, sop);
    expect(decodedSop.phases[0]?.acceptance_criteria).toEqual([
      "Positioning hypothesis is falsifiable",
    ]);
    expect(decodedSop.phases[1]?.input).toBeUndefined();
  });

  test("sop executor, tool, and runtime fields are explicitly unsupported", () => {
    const base = {
      name: "beacon",
      description: "Marketing method.",
      phases: [{ name: "explore", purpose: "Map the space.", body: "Read the brief." }],
    };

    expectRejects(SopSourceSchema, { ...base, orchestrator: { agent: "builder" } });
    expectRejects(SopSourceSchema, { ...base, parameters: [{ name: "domain" }] });
    expectRejects(SopSourceSchema, { ...base, definitions: {} });
    expectRejects(SopSourceSchema, { ...base, signal_emitter: { destinations: [] } });
    expectRejects(SopSourceSchema, { ...base, pulsar_checkpoints: [] });
    expectRejects(SopSourceSchema, {
      ...base,
      phases: [{ ...base.phases[0]!, agents: ["builder"] }],
    });
    expectRejects(SopSourceSchema, {
      ...base,
      phases: [{ ...base.phases[0]!, requires: [{ all: ["committable"] }] }],
    });
    expectRejects(SopSourceSchema, {
      ...base,
      phases: [{ ...base.phases[0]!, tools: [] }],
    });
    expectRejects(SopSourceSchema, {
      ...base,
      phases: [{ ...base.phases[0]!, contract: { input: {} } }],
    });
    expectRejects(SopSourceSchema, {
      ...base,
      phases: [{ ...base.phases[0]!, orbit_binding: { orbit: "x" } }],
    });
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

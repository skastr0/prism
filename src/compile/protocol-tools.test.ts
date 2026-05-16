import { join } from "node:path";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { emptyRegistry } from "./registry.js";
import { materializeTraitTools, type ProtocolSurfaceError } from "./protocol-tools.js";
import {
  CanonicalTool,
  Trait,
  type NormalizedTraitBinding,
  type NormalizedTraitBindingToolSlot,
} from "./sources.js";

const pluginRoot = "/tmp/prism-protocol-tools/main";
const depRoot = "/tmp/prism-protocol-tools/dep";

const createTool = (options: {
  readonly name: string;
  readonly description?: string;
  readonly slots?: CanonicalTool["slots"];
}): CanonicalTool =>
  new CanonicalTool({
    name: options.name,
    sourcePath: join(depRoot, "tools", `${options.name}.tool.ts`),
    description: options.description ?? `Tool ${options.name}`,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    slots: options.slots ?? {},
    async handle() {
      return {};
    },
  });

const createTrait = (
  tools: Trait["tools"],
): Trait =>
  new Trait({
    name: "reviewable",
    sourcePath: join(pluginRoot, "traits", "reviewable.trait.ts"),
    instructions: [],
    access: { tools: [], toolGroups: [], skills: [] },
    tools,
    inject: { skills: [] },
    require: { tools: [], skills: [] },
  });

const createRegistry = () => {
  const registry = emptyRegistry(pluginRoot, "main-plugin", "0.1.0");
  const dep = emptyRegistry(depRoot, "dep-plugin", "0.1.0");
  registry.deps.set("dep", dep);
  dep.tools.set("run_shell", createTool({ name: "run_shell" }));
  dep.tools.set(
    "submit_review",
    createTool({
      name: "submit_review",
      description: "Submit review",
      slots: { verdict: { kind: "schema" } },
    }),
  );
  return { registry };
};

const reviewVerdictSlot = (
  sourcePath = join(pluginRoot, "schemas", "review-slots.ts"),
): NormalizedTraitBindingToolSlot => ({
  schema: Schema.Struct({ summary: Schema.String }),
  source: { sourcePath, exportName: "ReviewVerdict" },
});

const materialize = (
  trait: Trait,
  binding: NormalizedTraitBinding,
) =>
  materializeTraitTools({
    agentName: "reviewer",
    ownerPluginName: "main-plugin",
    canonicalTraitId: "main-plugin:reviewable",
    trait,
    binding,
    registry: createRegistry().registry,
  });

const expectProtocolError = (
  result: ReturnType<typeof materializeTraitTools>,
  expected: ProtocolSurfaceError,
): void => {
  expect(Array.isArray(result)).toBe(false);
  if (Array.isArray(result)) {
    throw new Error("expected protocol surface error");
  }
  expect(result).toEqual(expected);
};

test("materializes trait tool permission and synthetic bindings deterministically", () => {
  const trait = createTrait({
    submit_review: { ref: "dep:submit_review" },
    run_shell: { ref: "dep:run_shell" },
  });
  const binding: NormalizedTraitBinding = {
    ref: "reviewable",
    tools: {
      submit_review: {
        slots: {
          verdict: reviewVerdictSlot(),
        },
      },
    },
  };

  const result = materialize(trait, binding);

  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) {
    throw new Error("expected materialized trait tools");
  }
  expect(result.map((item) => [item.kind, item.logicalName])).toEqual([
    ["permission", "run_shell"],
    ["synthetic", "submit_review"],
  ]);

  const permission = result[0];
  if (permission.kind !== "permission") {
    throw new Error("expected permission binding");
  }
  expect(permission).toEqual({
    kind: "permission",
    logicalName: "run_shell",
    toolPluginName: "dep-plugin",
    toolName: "run_shell",
    toolSourcePath: join(depRoot, "tools", "run_shell.tool.ts"),
  });

  const synthetic = result[1];
  if (synthetic.kind !== "synthetic") {
    throw new Error("expected synthetic binding");
  }
  expect(synthetic.logicalName).toBe("submit_review");
  expect(synthetic.toolPluginName).toBe("dep-plugin");
  expect(synthetic.toolName).toBe("submit_review");
  expect(synthetic.toolSourcePath).toBe(join(depRoot, "tools", "submit_review.tool.ts"));
  expect(synthetic.contract.name).toBe("submit_review__review_verdict");
  expect(synthetic.contract.sourcePath).toBe(`${trait.sourcePath}#submit_review`);
  expect(synthetic.contract.pluginName).toBe("main-plugin");
  expect(synthetic.contract.generatedFiles).toHaveLength(1);

  const generatedFile = synthetic.contract.generatedFiles?.[0];
  expect(generatedFile?.relativePath).toBe(
    "contracts/submit_review__review_verdict.contract.ts",
  );
  expect(generatedFile?.content).toContain(
    'import { default as canonical } from "../../../../../prism-generated-dep-plugin/src/plugins/dep-plugin/tools/submit_review.tool";',
  );
  expect(generatedFile?.content).toContain(
    'import { ReviewVerdict as slot_0_verdict } from "../schemas/review-slots";',
  );
  expect(generatedFile?.content).toContain('"verdict": slot_0_verdict,');
  expect(generatedFile?.content).toContain("export const handle = canonical.handle;");
});

test("materializing trait tools fails closed on unknown canonical tool refs", () => {
  const trait = createTrait({
    missing: { ref: "dep:missing" },
  });
  const binding: NormalizedTraitBinding = { ref: "reviewable", tools: {} };

  expectProtocolError(materialize(trait, binding), {
    field: "traits.reviewable.tools.missing.ref",
    message: "references unknown tool 'dep:missing'",
  });
});

test("materializing trait tools fails closed on undeclared slots", () => {
  const trait = createTrait({
    submit_review: { ref: "dep:submit_review" },
  });
  const binding: NormalizedTraitBinding = {
    ref: "reviewable",
    tools: {
      submit_review: {
        slots: {
          unknown_verdict: reviewVerdictSlot(),
        },
      },
    },
  };

  expectProtocolError(materialize(trait, binding), {
    field: "traits.reviewable.tools.submit_review.slots",
    message: "fills undeclared tool slot(s): unknown_verdict",
  });
});

test("materializing trait tools fails closed on non-Effect schemas", () => {
  const trait = createTrait({
    submit_review: { ref: "dep:submit_review" },
  });
  const binding: NormalizedTraitBinding = {
    ref: "reviewable",
    tools: {
      submit_review: {
        slots: {
          verdict: {
            ...reviewVerdictSlot(),
            schema: 42,
          },
        },
      },
    },
  };

  expectProtocolError(materialize(trait, binding), {
    field: "traits.reviewable.tools.submit_review.slots.verdict",
    message: "must resolve to an Effect Schema",
  });
});

test("materializing trait tools fails closed on slot sources outside the plugin graph", () => {
  const trait = createTrait({
    submit_review: { ref: "dep:submit_review" },
  });
  const binding: NormalizedTraitBinding = {
    ref: "reviewable",
    tools: {
      submit_review: {
        slots: {
          verdict: reviewVerdictSlot("/tmp/prism-protocol-tools/outside/review-slots.ts"),
        },
      },
    },
  };

  expectProtocolError(materialize(trait, binding), {
    field: "tools.submit_review.slots.verdict",
    message:
      "schema source '/tmp/prism-protocol-tools/outside/review-slots.ts' is outside the plugin graph",
  });
});

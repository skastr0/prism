import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import {
  parseAgyModelsList,
  parseAmpAgentOptions,
  parseAmpModeHelp,
  parseAmpPluginListModes,
  parseClaudeModelCache,
  parseCodexDebugModels,
  parseCursorModelsList,
  parseGrokModelsCli,
  parseGrokModelsCache,
  parseKimiProviderList,
  parseOmpConfigDefaultModel,
  parseOmpModelsJson,
  parseOpenCodeModels,
  refreshHarnessTypes,
} from "./harness-types-discover.js";
import { renderHarnessModelsModule, type HarnessTypesSnapshot } from "./harness-types.js";
import { buildWorkflowPaths, resolveWorkflowTypeDirs } from "./workflow-tsconfig.js";

const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;
const srcDir = dirname(fileURLToPath(import.meta.url));
// Derived from the resolver so the test tracks the installed Effect layout
// (v3 shipped dist/dts, v4 ships dist).
const { effectDtsDir } = resolveWorkflowTypeDirs();
if (effectDtsDir === undefined) {
  throw new Error("harness-types.test.ts: effect declarations could not be resolved");
}
const effectDts = join(effectDtsDir, "index.d.ts");

const typecheckPluginFreeWorkflow = async (
  model: string,
): Promise<readonly string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-harness-typecheck-"));
  const harnessPath = join(dir, "harness-models.ts");
  const workflowPath = join(dir, "flow.workflow.ts");
  const snapshot: HarnessTypesSnapshot = {
    generatedAt: "2026-09-09T00:00:00.000Z",
    harnesses: [
      { harness: "amp-code", models: [{ id: "low" }, { id: "high" }], source: "command" },
    ],
  };
  await writeFile(harnessPath, renderHarnessModelsModule(snapshot), "utf8");
  await writeFile(
    workflowPath,
    `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

export const workflow = defineWorkflow({
  name: "typed-harness",
  tasks: [defineTask({
    id: "amp",
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    worker: { worker: "amp-code", model: ${JSON.stringify(model)} },
  })],
});
`,
    "utf8",
  );
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      paths: {
        prism: [join(srcDir, "workflows.ts")],
        "prism/harnesses": [harnessPath],
        effect: [effectDts],
      },
    },
    dir,
  );
  if (errors.length > 0) {
    return errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  const program = ts.createProgram([workflowPath, harnessPath], options);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
};

describe("harness model parsers", () => {
  test("parses Claude cache plus aliases", () => {
    const parsed = parseClaudeModelCache(JSON.stringify({
      additionalModelOptionsCache: [{ value: "claude-opus-4-8", label: "Opus 4.8" }],
    }));
    expect(parsed.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(parsed.models.map((model) => model.id)).toContain("sonnet");
  });

  test("parses Codex JSON and line-oriented output", () => {
    const json = parseCodexDebugModels(JSON.stringify({
      models: [
        { slug: "gpt-5.6-terra", efforts: ["low", "high"] },
        { slug: "gpt-5.6-codex", supported_reasoning_levels: [{ effort: "medium" }, { effort: "xhigh" }] },
      ],
    }));
    expect(json.models).toEqual([
      { id: "gpt-5.6-terra", efforts: ["low", "high"] },
      { id: "gpt-5.6-codex", efforts: ["medium", "xhigh"] },
    ]);
    const lines = parseCodexDebugModels("gpt-5.4-mini low medium\n");
    expect(lines.models[0]).toEqual({ id: "gpt-5.4-mini", efforts: ["low", "medium"] });
  });

  test("parses OpenCode, Cursor, Agy, Grok CLI, and Kimi lists", () => {
    expect(parseOpenCodeModels("openai/gpt-5.4\n\nollama-cloud/glm-5.2\n").map((model) => model.id))
      .toEqual(["openai/gpt-5.4", "ollama-cloud/glm-5.2"]);
    expect(parseCursorModelsList("Available models\n\ncomposer-2.5-fast - Composer\n").models)
      .toEqual([{ id: "composer-2.5-fast", label: "Composer" }]);
    expect(parseAgyModelsList("Fetching available models...\nGemini 3.5 Flash (Low)\tFlash\n").models)
      .toEqual([{ id: "Gemini 3.5 Flash (Low)", label: "Flash" }]);
    expect(parseGrokModelsCli("Default model: grok-4.5\n  - grok-composer-2.5-fast\n").map((model) => model.id))
      .toEqual(["grok-composer-2.5-fast", "grok-4.5"]);
    expect(parseKimiProviderList("Default model: kimi-code/kimi-for-coding\n"))
      .toEqual([{ id: "kimi-code/kimi-for-coding" }]);
    expect(parseOmpModelsJson(JSON.stringify({
      models: [
        {
          provider: "opencode-go",
          id: "glm-5.3-flash",
          selector: "opencode-go/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          thinking: ["low", "high"],
        },
        {
          provider: "opencode-go",
          id: "gpt-5.6-luna",
          selector: "opencode-go/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
        },
        { provider: "google", id: "gemini-3-flash" },
      ],
    })).models).toEqual([
      { id: "google/gemini-3-flash", provider: "google" },
      { id: "opencode-go/glm-5.3-flash", label: "GLM 5.3 Flash", provider: "opencode-go" },
      { id: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "opencode-go" },
    ]);
    expect(parseOmpModelsJson("{").error).toBeDefined();
    expect(parseOmpConfigDefaultModel("modelRoles:\n  default: opencode-go/glm-5.3-flash:high\n"))
      .toBe("opencode-go/glm-5.3-flash");
    expect(parseOmpConfigDefaultModel("modelRoles:\n  smol: ollama-cloud/glm-5.3-flash\n")).toBeUndefined();
    expect(parseAmpModeHelp(
      "  -m, --mode <value>\n      Set the agent mode (low, medium, high, ultra, or a plugin mode by key or label)\n",
    )).toEqual([
      { id: "low", kind: "dial", label: "Low" },
      { id: "medium", kind: "dial", label: "Medium" },
      { id: "high", kind: "dial", label: "High" },
      { id: "ultra", kind: "dial", label: "Ultra" },
    ]);
    expect(parseAmpPluginListModes("✓ plugin\n  agent mode: grok45\n  agent mode: gpt-6-astra-low\n"))
      .toEqual([
        { id: "gpt-6-astra-low", kind: "plugin-mode" },
        { id: "grok45", kind: "plugin-mode" },
      ]);
    const curated = parseAmpAgentOptions(JSON.stringify({
      models: [{
        provider: "anthropic",
        name: "claude-opus-5",
        id: "anthropic/claude-opus-5",
        displayName: "Claude Opus 5",
        capabilities: { efforts: ["low", "high", "max"] },
      }],
    }));
    expect(curated.models).toEqual([{
      id: "anthropic/claude-opus-5",
      kind: "model",
      label: "Claude Opus 5",
      provider: "anthropic",
      efforts: ["low", "high", "max"],
    }]);
  });

  test("parses Grok per-model reasoning efforts from its model cache", () => {
    expect(parseGrokModelsCache(JSON.stringify({
      models: {
        "xai/grok-4": { info: { name: "Grok 4", reasoning_efforts: [{ value: "low" }, { value: "high" }] } },
      },
    })).models).toEqual([{
      id: "xai/grok-4",
      label: "Grok 4",
      efforts: ["low", "high"],
    }]);
  });
});

describe("renderHarnessModelsModule", () => {
  test("discovers effort unions only for catalog-backed capabilities", () => {
    const source = renderHarnessModelsModule({
      generatedAt: "2026-09-22T00:00:00.000Z",
      harnesses: [
        { harness: "claude-code", models: [{ id: "opus", efforts: ["low", "high"] }], source: "cache" },
        { harness: "codex-cli", models: [{ id: "gpt-5", efforts: ["low", "high"] }], source: "command" },
        { harness: "grok", models: [{ id: "grok-4", efforts: ["minimal", "high"] }], source: "command" },
      ],
    });
    expect(source).toContain("codexEfforts");
    expect(source).toContain('"codex-cli": "high" | "low"');
    expect(source).toContain('"grok": "high" | "minimal"');
    expect(source).not.toContain("claudeCodeEfforts");
  });

  test("emits discovered Amp modes and skips empty workers", () => {
    const snapshot: HarnessTypesSnapshot = {
      generatedAt: "2026-09-09T00:00:00.000Z",
      harnesses: [
        { harness: "amp-code", models: [{ id: "low" }, { id: "high" }], source: "command" },
        { harness: "claude-code", models: [{ id: "sonnet" }, { id: "opus" }], source: "aliases" },
        { harness: "omp", models: [], source: "empty", error: "no list" },
      ],
    };
    const source = renderHarnessModelsModule(snapshot);
    expect(source).toContain("ampCodeModelSlugs");
    expect(source).toContain('"low"');
    expect(source).toContain('"high"');
    expect(source).not.toContain('"deep"');
    expect(source).not.toContain('"rush"');
    expect(source).toContain("claudeCodeModelSlugs");
    expect(source).toContain('"sonnet"');
    expect(source).not.toContain("ompModelSlugs");
    expect(source).toContain('import "prism"');
    expect(source).toContain('declare module "prism"');
    expect(source).toContain('"amp-code": "high" | "low"');
    expect(source).toContain('"claude-code": "opus" | "sonnet"');
  });

  test("keeps Amp catalog slugs out of the worker.model union", () => {
    const source = renderHarnessModelsModule({
      generatedAt: "2026-09-09T00:00:00.000Z",
      harnesses: [{
        harness: "amp-code",
        models: [
          { id: "low", kind: "dial", label: "Low" },
          { id: "grok45", kind: "plugin-mode" },
          { id: "anthropic/claude-opus-5", kind: "model", label: "Claude Opus 5", provider: "anthropic" },
        ],
        source: "command",
      }],
    });
    expect(source).toContain('"amp-code": "grok45" | "low"');
    expect(source).toContain("ampCodeCatalogSlugs");
    expect(source).toContain("anthropic/claude-opus-5");
    expect(source).toMatch(/interface WorkflowHarnessModelMap \{\s*"amp-code": "grok45" \| "low";/s);
    expect(source).not.toMatch(/interface WorkflowHarnessModelMap \{[^}]*anthropic\/claude-opus-5/s);
    expect(source).toContain("interface WorkflowHarnessCatalogModelMap");
    expect(source).toMatch(/WorkflowHarnessCatalogModelMap \{[^}]*"amp-code": "anthropic\/claude-opus-5"/s);
  });

  test("plugin-free worker.catalogModel accepts catalog slugs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prism-harness-catalog-"));
    const harnessPath = join(dir, "harness-models.ts");
    const workflowPath = join(dir, "flow.workflow.ts");
    await writeFile(harnessPath, renderHarnessModelsModule({
      generatedAt: "2026-09-09T00:00:00.000Z",
      harnesses: [{
        harness: "amp-code",
        models: [
          { id: "low", kind: "dial", label: "Low" },
          { id: "anthropic/claude-opus-5", kind: "model", label: "Claude Opus 5", provider: "anthropic", efforts: ["low", "max"] },
        ],
        source: "command",
      }],
    }), "utf8");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

export const workflow = defineWorkflow({
  name: "typed-catalog",
  tasks: [defineTask({
    id: "amp",
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    worker: { worker: "amp-code", model: "low", catalogModel: "anthropic/claude-opus-5", effort: "max" },
  })],
});
`, "utf8");
    const { options, errors } = ts.convertCompilerOptionsFromJson({
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      paths: {
        prism: [join(srcDir, "workflows.ts")],
        "prism/harnesses": [harnessPath],
        effect: [effectDts],
      },
    }, dir);
    expect(errors).toEqual([]);
    const program = ts.createProgram([workflowPath, harnessPath], options);
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )).toEqual([]);
  });

  test("plugin-free worker.model accepts live slugs and rejects unknown ones", async () => {
    const ok = await typecheckPluginFreeWorkflow("high");
    expect(ok).toEqual([]);
    const bad = await typecheckPluginFreeWorkflow("not-a-mode");
    expect(bad.some((message) => message.includes("not-a-mode"))).toBe(true);
  });
});

describe("refreshHarnessTypes", () => {
  test("writes a global cache under state/harness-types, not a project key", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-harness-types-"));
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async () => "",
      readText: () => undefined,
    });
    expect(result.modelsPath).toBe(join(prismHome, "state", "harness-types", "harness-models.ts"));
    expect(result.modelsPath).not.toContain("projects/");
    const source = await readFile(result.modelsPath, "utf8");
    const amp = result.snapshot.harnesses.find((entry) => entry.harness === "amp-code");
    expect(amp?.source).toBe("empty");
    expect(amp?.models).toEqual([]);
  });

  test("records command-discovered slugs when a runner returns output", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-harness-types-"));
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      readText: () => undefined,
      runCommand: async (command, args) => {
        if (command === "amp" && args[0] === "--help") {
          return "Set the agent mode (low, medium, high, ultra, or a plugin mode by key)\n";
        }
        if (command === "amp" && args[0] === "plugins" && args[1] === "list") {
          return "  agent mode: grok45\n";
        }
        if (command === "amp" && args[0] === "plugins" && args[1] === "show-agent-options") {
          return JSON.stringify({
            models: [{
              provider: "anthropic",
              id: "anthropic/claude-opus-5",
              displayName: "Claude Opus 5",
              capabilities: { efforts: ["low", "max"] },
            }],
          });
        }
        if (command === "opencode" && args[0] === "models") return "opencode/deepseek-v4-flash\n";
        if (command === "omp" && args[0] === "models" && args[1] === "--json") {
          return JSON.stringify({
            models: [{
              provider: "opencode-go",
              id: "glm-5.3-flash",
              selector: "opencode-go/glm-5.3-flash",
              name: "GLM 5.3 Flash",
              thinking: ["low", "high"],
            }],
          });
        }
        return "";
      },
    });
    const opencode = result.snapshot.harnesses.find((entry) => entry.harness === "opencode");
    expect(opencode?.models.map((model) => model.id)).toEqual(["opencode/deepseek-v4-flash"]);
    const amp = result.snapshot.harnesses.find((entry) => entry.harness === "amp-code");
    expect(amp?.models.map((model) => model.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultra",
      "grok45",
      "anthropic/claude-opus-5",
    ]);
    expect(amp?.models.find((model) => model.id === "anthropic/claude-opus-5")).toEqual({
      id: "anthropic/claude-opus-5",
      kind: "model",
      label: "Claude Opus 5",
      provider: "anthropic",
      efforts: ["low", "max"],
    });
    const source = await readFile(result.modelsPath, "utf8");
    expect(source).toContain("openCodeModelSlugs");
    expect(source).toContain("opencode/deepseek-v4-flash");
    expect(source).toContain("ampCodeModelSlugs");
    expect(source).toContain("grok45");
    expect(source).toContain("ampCodeCatalogSlugs");
    expect(source).toContain("anthropic/claude-opus-5");
    expect(source).toContain("ampCodeEfforts");
    expect(source).toContain('"amp-code": "grok45" | "high" | "low" | "medium" | "ultra"');
    expect(source).not.toMatch(/interface WorkflowHarnessModelMap \{[^}]*anthropic\/claude-opus-5/s);
    expect(source).toContain("interface WorkflowHarnessCatalogModelMap");
    expect(source).toContain("interface WorkflowHarnessEffortMap");
    expect(source).toContain("ompModelSlugs");
    expect(source).toContain("opencode-go/glm-5.3-flash");
    expect(source).toContain('"omp": "opencode-go/glm-5.3-flash"');
    expect(source).not.toContain("ompEfforts");
  });
});

describe("workflow tsconfig harness path", () => {
  test("maps prism/harnesses independently of project refs", () => {
    const paths = buildWorkflowPaths({
      typeDirs: { prismTypesDir: "/tmp/prism-types", effectDtsDir: "/tmp/effect-dts" },
      refsDir: "/tmp/generated",
      harnessTypesPath: "/tmp/harness-types/harness-models.ts",
    });
    expect(paths["prism/harnesses"]).toEqual(["/tmp/harness-types/harness-models.ts"]);
    expect(paths["prism/refs"]).toEqual(["/tmp/generated/sops.ts"]);
  });
});

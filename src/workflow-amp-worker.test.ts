import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "./fs.js";
import { Schema } from "effect";
import { mkdir } from "node:fs/promises";
import {
  AMP_WORKFLOW_CATALOG_PIN_MODE,
  AmpWorkflowWorkerError,
  ampCatalogPinPluginPath,
  ampWorkflowHonestMetadata,
  findExistingAmpCatalogMode,
  parseAmpStreamJsonError,
  renderAmpCatalogPinPlugin,
  resolveAmpCatalogPinPlan,
  runAmpWorkflowTask,
  validateAmpCatalogPins,
} from "./workflow-amp-worker.js";
import type { HarnessTypesSnapshot } from "./harness-types.js";
import type { WorkflowTaskWorkerOptions } from "./workflows.js";

const task = {
  kind: "workflow-task" as const,
  id: "build",
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("Amp catalog pin plan", () => {
  test("mode-only stays a --mode pass-through", () => {
    expect(resolveAmpCatalogPinPlan({ mode: "high" })).toEqual({ kind: "mode", mode: "high" });
  });

  test("catalogModel becomes a prism-pin plugin mode", () => {
    expect(resolveAmpCatalogPinPlan({ catalogModel: "anthropic/claude-opus-5", effort: "max" })).toEqual({
      kind: "pin",
      mode: AMP_WORKFLOW_CATALOG_PIN_MODE,
      catalogModel: "anthropic/claude-opus-5",
      effort: "max",
    });
  });

  test("dial + catalogModel extends that dial", () => {
    expect(resolveAmpCatalogPinPlan({ mode: "high", catalogModel: "anthropic/claude-opus-5" })).toEqual({
      kind: "pin",
      mode: AMP_WORKFLOW_CATALOG_PIN_MODE,
      catalogModel: "anthropic/claude-opus-5",
      extendsMode: "high",
    });
  });

  test("effort-only extends medium", () => {
    expect(resolveAmpCatalogPinPlan({ effort: "xhigh" })).toEqual({
      kind: "pin",
      mode: AMP_WORKFLOW_CATALOG_PIN_MODE,
      effort: "xhigh",
      extendsMode: "medium",
    });
  });

  test("plugin mode plus catalogModel fails closed", () => {
    expect(() => resolveAmpCatalogPinPlan({ mode: "grok45", catalogModel: "anthropic/claude-opus-5" }))
      .toThrow(/cannot combine with plugin mode 'grok45'/);
  });

  test("reads Amp stream-json execution errors", () => {
    expect(parseAmpStreamJsonError([
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"error":"Reasoning effort \\"low\\" is not supported"}',
    ].join("\n"))).toBe('Reasoning effort "low" is not supported');
  });

  test("honest metadata never reports prism-pin as the model", () => {
    const pin = resolveAmpCatalogPinPlan({ catalogModel: "anthropic/claude-opus-5", effort: "max" });
    expect(ampWorkflowHonestMetadata({
      pin,
      authoredModel: "high",
      catalogModel: "anthropic/claude-opus-5",
      effort: "max",
    })).toEqual({
      model: "anthropic/claude-opus-5",
      ampMode: "high",
      catalogModel: "anthropic/claude-opus-5",
      effort: "max",
    });
  });
});

describe("Amp catalog pin validation", () => {
  const snapshot: HarnessTypesSnapshot = {
    generatedAt: "2026-09-09T00:00:00.000Z",
    harnesses: [{
      harness: "amp-code",
      source: "command",
      models: [
        { id: "low", kind: "dial" },
        { id: "anthropic/claude-haiku-4-5-20251001", kind: "model", efforts: ["none", "high"] },
      ],
    }],
  };

  test("rejects effort the catalog row does not list", () => {
    const error = validateAmpCatalogPins({
      ...task,
      worker: { worker: "amp-code", catalogModel: "anthropic/claude-haiku-4-5-20251001", effort: "low" } as unknown as WorkflowTaskWorkerOptions,
    }, snapshot);
    expect(error).toMatch(/does not support effort "low"/);
    expect(error).toContain("none");
  });

  test("accepts a listed effort", () => {
    expect(validateAmpCatalogPins({
      ...task,
      worker: { worker: "amp-code", catalogModel: "anthropic/claude-haiku-4-5-20251001", effort: "none" } as unknown as WorkflowTaskWorkerOptions,
    }, snapshot)).toBeUndefined();
  });
});

describe("existing Amp plugin mode preference", () => {
  test("reuses a project plugin mode that already pins the catalog slug", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-existing-"));
    try {
      const pluginsDir = join(root, ".amp", "plugins");
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, "claude-opus-5.ts"), `
registerAgentMode({
  key: "claude-opus-5",
  label: "Opus",
})
const agent = createAgent({
    model: "anthropic/claude-opus-5",
    reasoningEffort: "max",
})
`);
      await expect(findExistingAmpCatalogMode(root, {
        catalogModel: "anthropic/claude-opus-5",
        effort: "max",
      })).resolves.toBe("claude-opus-5");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Amp catalog pin render", () => {
  test("rendered pin plugin carries the catalog slug and effort", () => {
    const source = renderAmpCatalogPinPlugin({
      catalogModel: "anthropic/claude-opus-5",
      effort: "max",
    });
    expect(source).toContain('model: "anthropic/claude-opus-5"');
    expect(source).toContain('reasoningEffort: "max"');
    expect(source).toContain(`key: "${AMP_WORKFLOW_CATALOG_PIN_MODE}"`);
    expect(source).toContain("@amp-agent-mode");
  });
});

describe("runAmpWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-fail-"));
    try {
      const fakeAmp = join(root, "fake-amp-fail.mjs");
      await writeFile(fakeAmp, [
        "#!/usr/bin/env node",
        "console.error('amp: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAmp, 0o755);

      const failure = await runAmpWorkflowTask(task, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AmpWorkflowWorkerError);
      const metadata = (failure as AmpWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("amp-code");
      expect(metadata?.stderrExcerpt).toContain("amp: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial stream before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-fail-"));
    try {
      const fakeAmp = join(root, "fake-amp-partial-fail.mjs");
      await writeFile(fakeAmp, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'system', session_id: 'amp-partial-session' }) + '\\n');",
        "console.error('amp: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAmp, 0o755);

      const failure = await runAmpWorkflowTask(task, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AmpWorkflowWorkerError);
      const metadata = (failure as AmpWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("amp-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("catalogModel writes a project pin plugin, then deletes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-pin-"));
    try {
      const fakeAmp = join(root, "fake-amp-pin.mjs");
      await writeFile(fakeAmp, [
        "#!/usr/bin/env node",
        "import { copyFileSync, existsSync, writeFileSync } from 'node:fs';",
        "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
        "const pin = '.amp/plugins/prism-workflow-catalog-pin.ts';",
        "if (existsSync(pin)) copyFileSync(pin, 'pin-seen.ts');",
        "process.stdout.write(JSON.stringify({ type: 'result', result: '{\"summary\":\"ok\"}' }) + '\\n');",
        "",
      ].join("\n"));
      await chmod(fakeAmp, 0o755);

      const execution = await runAmpWorkflowTask(task, {
        cwd: root,
        bin: fakeAmp,
        catalogModel: "anthropic/claude-opus-5",
        effort: "low",
        resolvedPermission: "legacy",
      });

      expect(execution.metadata?.model).toBe("anthropic/claude-opus-5");
      expect(execution.metadata?.model).not.toBe(AMP_WORKFLOW_CATALOG_PIN_MODE);
      expect(execution.metadata?.catalogModel).toBe("anthropic/claude-opus-5");
      expect(execution.metadata?.effort).toBe("low");
      const args = JSON.parse(await readFile(join(root, "argv.json"), "utf8")) as string[];
      expect(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2)).toEqual(["--mode", AMP_WORKFLOW_CATALOG_PIN_MODE]);
      expect(args).toContain("--plugin-ready-timeout");
      expect(await readFile(join(root, "pin-seen.ts"), "utf8")).toContain('model: "anthropic/claude-opus-5"');
      expect(await exists(ampCatalogPinPluginPath(root))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

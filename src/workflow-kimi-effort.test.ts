import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseKimiModelEffortSupport,
  validateKimiWorkflowEffort,
} from "./workflow-kimi-effort.js";

test("Kimi model support_efforts narrows the fixed effort union", () => {
  const source = `
[models."kimi-code/kimi-for-coding"]
support_efforts = ["low", "high", "max"]
`;
  expect(parseKimiModelEffortSupport(source, "kimi-code/kimi-for-coding")).toEqual({
    declared: true,
    efforts: ["low", "high", "max"],
  });
  expect(parseKimiModelEffortSupport(source, "kimi-code/other-model")).toEqual({ declared: false });
});

test("Kimi effort validation checks a selected model's config row", async () => {
  const home = await mkdtemp(join(tmpdir(), "prism-kimi-effort-"));
  try {
    await writeFile(join(home, "config.toml"), `
[models."kimi-code/kimi-for-coding"]
support_efforts = ["low", "high", "max"]
`);

    expect(validateKimiWorkflowEffort({
      model: "kimi-code/kimi-for-coding",
      effort: "high",
      kimiHome: home,
    })).toBeUndefined();
    expect(validateKimiWorkflowEffort({
      model: "kimi-code/kimi-for-coding",
      effort: "medium",
      kimiHome: home,
    })).toBe(
      'Kimi Code model "kimi-code/kimi-for-coding" does not list effort "medium". Supported for this model: low, high, max. Fix: set worker.effort to "low".',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Kimi skips model-specific validation when no support_efforts row is declared", async () => {
  const home = await mkdtemp(join(tmpdir(), "prism-kimi-effort-"));
  try {
    await writeFile(join(home, "config.toml"), `
[models."kimi-code/kimi-for-coding"]
name = "Kimi for Coding"
`);
    expect(validateKimiWorkflowEffort({
      model: "kimi-code/kimi-for-coding",
      effort: "xhigh",
      kimiHome: home,
    })).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

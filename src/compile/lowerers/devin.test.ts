import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./devin.js";

describe("devin lowerer", () => {
  test("rejects agents after capability gate", async () => {
    await expect(
      planLowering({
        agents: [{ name: "x" } as never],
        orbits: [],
        tools: [],
        target: {
          scope: "global",
          root: "/tmp/devin-root",
          sourcePluginName: "demo",
        },
      }),
    ).rejects.toThrow(/agents/);
  });

  test("copies targeted skills into the Devin skills root", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-lower-"));
    const pluginPath = await mkdtemp(join(tmpdir(), "prism-devin-plugin-"));
    const skillDir = join(pluginPath, "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: review\ndescription: Review code\n---\n\n# Review\n`,
    );

    const output = await planLowering({
      agents: [],
      orbits: [],
      tools: [],
      registry: {
        pluginPath,
        pluginName: "demo",
        targets: {
          skills: ["devin"],
        },
      } as never,
      target: {
        scope: "global",
        root,
        sourcePluginName: "demo",
        sourcePluginPath: pluginPath,
      },
    });

    const skill = output.files.find((f) => f.targetPath.endsWith("review/SKILL.md"));
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Review code");
    expect(skill!.plugin).toBe("demo");
  });
});

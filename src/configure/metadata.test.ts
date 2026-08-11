import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadArtifactMeta,
  loadArtifactMetas,
  loadTextForReader,
} from "./metadata.js";

const tempRoot = async (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix));

describe("configure metadata loaders", () => {
  test("loadArtifactMeta reads SKILL.md frontmatter description and name", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const skillDir = join(root, "skills", "tower");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      `---
name: tower
description: Shared control plane for glyphs and signals
---

# Tower

Body content here.
`,
    );

    const meta = await loadArtifactMeta(skillPath);
    expect(meta.path).toBe(skillPath);
    expect(meta.kind).toBe("skill");
    expect(meta.title).toBe("tower");
    expect(meta.description).toBe("Shared control plane for glyphs and signals");
  });

  test("loadArtifactMeta falls back to parent dir when name missing", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const skillDir = join(root, "skills", "booth");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      `---
description: Taste gate for customer-facing artifacts
---

Body.
`,
    );

    const meta = await loadArtifactMeta(skillPath);
    expect(meta.kind).toBe("skill");
    expect(meta.title).toBe("booth");
    expect(meta.description).toBe("Taste gate for customer-facing artifacts");
  });

  test("loadArtifactMeta classifies agents/commands and uses first paragraph", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const agentPath = join(root, "agents", "builder.md");
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(
      agentPath,
      `---
description: Implements changes
---

You are a builder.
`,
    );

    const agent = await loadArtifactMeta(agentPath);
    expect(agent.kind).toBe("agent");
    expect(agent.description).toBe("Implements changes");

    const commandPath = join(root, "commands", "review.md");
    await mkdir(join(root, "commands"), { recursive: true });
    await writeFile(
      commandPath,
      `# Review

Review the following code carefully and report findings.
`,
    );

    const command = await loadArtifactMeta(commandPath);
    expect(command.kind).toBe("command");
    expect(command.description).toContain("Review the following code carefully");
  });

  test("loadArtifactMetas skips missing paths", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const skillDir = join(root, "skills", "x");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      `---
name: x
description: exists
---
`,
    );

    const metas = await loadArtifactMetas([
      skillPath,
      join(root, "missing", "SKILL.md"),
    ]);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.description).toBe("exists");
  });

  test("loadTextForReader returns full text under limit", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const filePath = join(root, "notes.txt");
    await writeFile(filePath, "hello reader\n");

    const result = await loadTextForReader(filePath);
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello reader\n");
    expect(result.path).toBe(filePath);
  });

  test("loadTextForReader truncates large files", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const filePath = join(root, "big.txt");
    // slightly over 512KB
    const size = 512 * 1024 + 2048;
    await writeFile(filePath, "a".repeat(size));

    const result = await loadTextForReader(filePath);
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated:");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(size);
  });

  test("loadTextForReader reports missing file", async () => {
    const root = await tempRoot("prism-configure-meta-");
    const result = await loadTextForReader(join(root, "nope.md"));
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("");
    expect(result.error).toBe("File not found");
  });
});

import { describe, expect, test } from "bun:test";
import { wordWrap } from "./theme.js";

describe("wordWrap", () => {
  test("does not ellipsize — continues on next line", () => {
    const msg =
      "applied · dry-run uninstall · 0 ops · dry-run; would remove 0 owned files and 0 region(s) for plugin tower#file-router";
    const out = wordWrap(msg, 40);
    expect(out).not.toContain("…");
    expect(out).toContain("\n");
    expect(out.replace(/\n/g, " ")).toContain("tower#file-router");
    for (const line of out.split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("preserves explicit newlines", () => {
    expect(wordWrap("a\nb\nc", 80)).toBe("a\nb\nc");
  });

  test("hard-breaks oversize tokens", () => {
    const out = wordWrap("x".repeat(25), 10);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(10);
    }
  });
});

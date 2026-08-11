import { describe, expect, test } from "bun:test";
import { clampReaderScroll, wrapReaderLines } from "./text-reader.js";

describe("wrapReaderLines", () => {
  test("wraps long lines without ellipsis", () => {
    const long =
      "This is a very long transcript line that must continue on the next row so the full memory text is readable in the configure TUI reader pane.";
    const lines = wrapReaderLines(long, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).not.toContain("…");
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
    }
    // Full content preserved (modulo whitespace reflow)
    const joined = lines.join(" ").replace(/\s+/g, " ");
    expect(joined).toContain("configure TUI reader pane");
  });

  test("preserves blank source lines", () => {
    expect(wrapReaderLines("a\n\nb", 80)).toEqual(["a", "", "b"]);
  });

  test("empty file is one blank visual line", () => {
    expect(wrapReaderLines("", 80)).toEqual([""]);
  });
});

describe("clampReaderScroll", () => {
  test("clamps to last page", () => {
    expect(clampReaderScroll(100, 10, 5)).toBe(5);
    expect(clampReaderScroll(-1, 10, 5)).toBe(0);
  });
});

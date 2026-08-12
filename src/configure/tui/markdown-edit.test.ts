import { describe, expect, test } from "bun:test";
import {
  applyEnterList,
  listContinueOnEnter,
  setLineHeading,
  toggleBold,
  toggleBulletLine,
  toggleItalic,
  toggleNumberedLine,
  wrapLink,
  wrapOrUnwrap,
} from "./markdown-edit.js";

describe("wrapOrUnwrap / bold / italic", () => {
  test("wraps selection", () => {
    const r = toggleBold("hello world", { start: 6, end: 11 });
    expect(r.text).toBe("hello **world**");
    expect(r.selection).toEqual({ start: 8, end: 13 });
  });

  test("unwraps when markers already on selection", () => {
    const r = toggleBold("hello **world**", { start: 6, end: 15 });
    expect(r.text).toBe("hello world");
  });

  test("empty selection inserts pair with caret inside", () => {
    expect(wrapOrUnwrap("ab", { start: 1, end: 1 }, "*")).toEqual({
      text: "a**b",
      selection: { start: 2, end: 2 },
    });
    // a + * + * + b
    expect(wrapOrUnwrap("ab", { start: 1, end: 1 }, "*").text).toBe("a" + "*" + "*" + "b");
  });

  test("italic wraps word", () => {
    expect(toggleItalic("x y z", { start: 2, end: 3 }).text).toBe("x *y* z");
  });
});

describe("wrapLink", () => {
  test("wraps selection and selects url", () => {
    const r = wrapLink("see docs here", { start: 4, end: 8 });
    expect(r.text).toBe("see [docs](url) here");
    expect(r.text.slice(r.selection.start, r.selection.end)).toBe("url");
  });

  test("empty selection inserts placeholders", () => {
    const r = wrapLink("", { start: 0, end: 0 });
    expect(r.text).toBe("[text](url)");
    expect(r.text.slice(r.selection.start, r.selection.end)).toBe("text");
  });
});

describe("setLineHeading", () => {
  test("adds h2", () => {
    expect(setLineHeading("Title", 0, 2).text).toBe("## Title");
  });

  test("changes level and strips previous", () => {
    expect(setLineHeading("## Title", 0, 1).text).toBe("# Title");
    expect(setLineHeading("## Title", 0, 0).text).toBe("Title");
  });
});

describe("listContinueOnEnter", () => {
  test("continues bullets", () => {
    expect(listContinueOnEnter("- item")).toEqual({ kind: "continue", prefix: "- " });
  });

  test("exits empty bullet", () => {
    expect(listContinueOnEnter("- ")).toEqual({ kind: "exit" });
    expect(listContinueOnEnter("  * ")).toEqual({ kind: "exit" });
  });

  test("increments numbered", () => {
    expect(listContinueOnEnter("2. item")).toEqual({ kind: "continue", prefix: "3. " });
  });
});

describe("applyEnterList", () => {
  test("inserts next bullet after item", () => {
    const r = applyEnterList("- one", 5);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("- one\n- ");
  });

  test("exits empty list item", () => {
    const r = applyEnterList("- item\n- ", 9);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("- item\n");
  });
});

describe("toggleBulletLine / toggleNumberedLine", () => {
  test("toggle bullet", () => {
    expect(toggleBulletLine("hello", 0).text).toBe("- hello");
    expect(toggleBulletLine("- hello", 0).text).toBe("hello");
  });

  test("toggle numbered", () => {
    expect(toggleNumberedLine("hello", 0).text).toBe("1. hello");
    expect(toggleNumberedLine("1. hello", 0).text).toBe("hello");
    expect(toggleNumberedLine("- hello", 0).text).toBe("1. hello");
  });
});

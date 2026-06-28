import { describe, expect, it } from "bun:test";
import { marchMask, spinnerFrame, truncate } from "./theme.js";

describe("truncate (display-width)", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("cuts ASCII to a width budget with an ellipsis", () => {
    expect(truncate("plain-ascii-name", 10)).toBe("plain-asc…");
  });
  it("measures wide glyphs by cell width, not char count", () => {
    // 6 wide chars = 12 cells; budget 6 cells fits 2 chars + ellipsis (width 5).
    const out = truncate("中文中文中文", 6);
    expect(Bun.stringWidth(out)).toBeLessThanOrEqual(6);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("spinnerFrame", () => {
  it("cycles through frames and wraps", () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(10));
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(1));
  });
});

describe("marchMask (working comet)", () => {
  it("lights a 2-cell comet that travels left→right with the tick", () => {
    const a = marchMask(8, 0);
    expect(a.filter(Boolean).length).toBe(2);
    expect(a[0]).toBe(true);
    expect(a[1]).toBe(true);
    // one tick later the comet has advanced one cell to the right
    const b = marchMask(8, 1);
    expect(b[1]).toBe(true);
    expect(b[2]).toBe(true);
    expect(b[0]).toBe(false);
  });
  it("wraps cleanly and never throws on odd widths", () => {
    expect(() => marchMask(0, 5)).not.toThrow();
    expect(marchMask(20, 100).length).toBe(20);
  });
});

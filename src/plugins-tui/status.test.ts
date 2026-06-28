import { describe, it, expect } from "bun:test";
import {
  classifyHarness,
  rollupStates,
  rollupCells,
  stateColor,
  stateGlyph,
  stateLabel,
} from "./status.js";
import type { HarnessPlan, HarnessStatusCell } from "./model.js";
import { PALETTE } from "./theme.js";

describe("classifyHarness", () => {
  it("classifies a drifted repair as 'drifted'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "repair",
          targetPath: "/some/file",
          reason: "drifted",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("drifted");
    expect(cell.detail).toBeUndefined();
  });

  it("classifies a create op as 'not-installed'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "create",
          targetPath: "/new/file",
          reason: "new",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("not-installed");
    expect(cell.opCounts.create).toBe(1);
  });

  it("classifies a source-changed repair as 'stale'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "repair",
          targetPath: "/some/file",
          reason: "source-changed",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("stale");
  });

  it("classifies a blocked op as 'blocked'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "blocked",
          targetPath: "/foreign/file",
          hint: "File is foreign, refusing overwrite",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("blocked");
  });

  it("classifies blocked target errors as 'blocked'", () => {
    const plan = {
      harness: "claude",
      ops: [],
      compileFailed: false,
      failures: [],
      blocked: [
        {
          targetPath: "/foreign/file",
          hint: "File is foreign",
        } as any,
      ],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("blocked");
    expect(cell.blockedCount).toBe(1);
  });

  it("classifies prune ops as 'orphaned'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "prune",
          targetPath: "/old/file",
          reason: "orphaned",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("orphaned");
  });

  it("classifies all skip ops as 'synced'", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "skip",
          targetPath: "/file1",
        } as any,
        {
          kind: "skip",
          targetPath: "/file2",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("synced");
    expect(cell.opCounts.skip).toBe(2);
  });

  it("classifies compileFailed=true as 'error'", () => {
    const plan = {
      harness: "claude",
      ops: [],
      compileFailed: true,
      compile: {
        ok: false,
        error: {
          headline: "Compilation failed",
        },
      },
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("error");
    expect(cell.compileFailed).toBe(true);
    expect(cell.detail).toBe("Compilation failed");
  });

  it("classifies failures as 'error'", () => {
    const plan = {
      harness: "claude",
      ops: [],
      compileFailed: false,
      failures: [
        {
          op: {} as any,
          message: "Write failed: permission denied",
        },
      ],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("error");
    expect(cell.failureCount).toBe(1);
    expect(cell.detail).toBe("Write failed: permission denied");
  });

  it("worst-wins: error beats drifted", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "repair",
          targetPath: "/file",
          reason: "drifted",
        } as any,
      ],
      compileFailed: true,
      compile: {
        ok: false,
        error: { headline: "Compile error" },
      },
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("error");
  });

  it("worst-wins: blocked beats drifted", () => {
    const plan = {
      harness: "claude",
      ops: [
        {
          kind: "repair",
          targetPath: "/file",
          reason: "drifted",
        } as any,
        {
          kind: "blocked",
          targetPath: "/blocked",
          hint: "Blocked",
        } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.state).toBe("blocked");
  });

  it("tallies op counts correctly", () => {
    const plan = {
      harness: "claude",
      ops: [
        { kind: "create", reason: "new" } as any,
        { kind: "create", reason: "new" } as any,
        { kind: "repair", reason: "source-changed" } as any,
        { kind: "skip" } as any,
      ],
      compileFailed: false,
      failures: [],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.opCounts.create).toBe(2);
    expect(cell.opCounts.repair).toBe(1);
    expect(cell.opCounts.skip).toBe(1);
  });

  it("prefers compile error detail over failure detail", () => {
    const plan = {
      harness: "claude",
      ops: [],
      compileFailed: true,
      compile: {
        ok: false,
        error: { headline: "Compile error headline" },
      },
      failures: [
        {
          op: {} as any,
          message: "Failure message",
        },
      ],
      blocked: [],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.detail).toBe("Compile error headline");
  });

  it("prefers blocked hint over failure detail", () => {
    const plan = {
      harness: "claude",
      ops: [],
      compileFailed: false,
      failures: [
        {
          op: {} as any,
          message: "Failure message",
        },
      ],
      blocked: [
        {
          targetPath: "/path",
          hint: "Blocked hint",
        } as any,
      ],
    } as unknown as HarnessPlan;

    const cell = classifyHarness(plan);
    expect(cell.detail).toBe("Blocked hint");
  });
});

describe("rollupStates", () => {
  it("returns 'n/a' for empty array", () => {
    expect(rollupStates([])).toBe("n/a");
  });

  it("picks the most severe state", () => {
    const states = ["synced", "stale", "drifted", "blocked"] as const;
    expect(rollupStates(states)).toBe("blocked");
  });

  it("picks error as most severe", () => {
    const states = ["synced", "stale", "error"] as const;
    expect(rollupStates(states)).toBe("error");
  });

  it("picks single state correctly", () => {
    expect(rollupStates(["drifted"])).toBe("drifted");
  });
});

describe("rollupCells", () => {
  it("extracts states from cells and rolls them up", () => {
    const cells: HarnessStatusCell[] = [
      {
        harness: "claude-code",
        state: "synced",
        opCounts: {},
        blockedCount: 0,
        failureCount: 0,
        compileFailed: false,
      },
      {
        harness: "grok",
        state: "drifted",
        opCounts: {},
        blockedCount: 0,
        failureCount: 0,
        compileFailed: false,
      },
      {
        harness: "codex-cli",
        state: "error",
        opCounts: {},
        blockedCount: 0,
        failureCount: 1,
        compileFailed: false,
      },
    ];

    expect(rollupCells(cells)).toBe("error");
  });
});

describe("stateColor", () => {
  it("maps synced to green", () => {
    expect(stateColor("synced")).toBe(PALETTE.green);
  });

  it("maps stale to yellow", () => {
    expect(stateColor("stale")).toBe(PALETTE.yellow);
  });

  it("maps drifted to orange", () => {
    expect(stateColor("drifted")).toBe(PALETTE.orange);
  });

  it("maps blocked to red", () => {
    expect(stateColor("blocked")).toBe(PALETTE.red);
  });

  it("maps error to red", () => {
    expect(stateColor("error")).toBe(PALETTE.red);
  });

  it("maps orphaned to fgDim", () => {
    expect(stateColor("orphaned")).toBe(PALETTE.fgDim);
  });

  it("maps not-installed to fgDim", () => {
    expect(stateColor("not-installed")).toBe(PALETTE.fgDim);
  });

  it("maps n/a to fgDim", () => {
    expect(stateColor("n/a")).toBe(PALETTE.fgDim);
  });
});

describe("stateGlyph", () => {
  it("returns sparse, ASCII-safe attention markers (empty for healthy/neutral)", () => {
    expect(stateGlyph("synced")).toBe("");
    expect(stateGlyph("not-installed")).toBe("");
    expect(stateGlyph("n/a")).toBe("");
    expect(stateGlyph("stale")).toBe("~");
    expect(stateGlyph("orphaned")).toBe("~");
    expect(stateGlyph("drifted")).toBe("!");
    expect(stateGlyph("blocked")).toBe("!");
    expect(stateGlyph("error")).toBe("!");
  });
});

describe("stateLabel", () => {
  it("returns uppercase labels for all states", () => {
    expect(stateLabel("synced")).toBe("SYNCED");
    expect(stateLabel("stale")).toBe("STALE");
    expect(stateLabel("drifted")).toBe("DRIFTED");
    expect(stateLabel("blocked")).toBe("BLOCKED");
    expect(stateLabel("error")).toBe("ERROR");
    expect(stateLabel("orphaned")).toBe("ORPHANED");
    expect(stateLabel("not-installed")).toBe("NOT INSTALLED");
    expect(stateLabel("n/a")).toBe("N/A");
  });
});

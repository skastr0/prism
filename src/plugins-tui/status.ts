/**
 * Per-harness status classification — the pure core of the matrix.
 *
 * Classifies a HarnessPlan into a CellState by tallying sync ops and checking
 * for compile failures. The state is worst-wins: the most severe signal present
 * (via CELL_STATE_SEVERITY) determines the cell's color and glyph.
 */

import type { HarnessPlan, HarnessStatusCell, CellState, SyncOpKind } from "./model.js";
import { CELL_STATE_SEVERITY } from "./model.js";
import type { SyncOp } from "../sync/plan.js";
import { PALETTE } from "./theme.js";

/**
 * Classify a harness plan into a status cell.
 *
 * State determination (worst-wins via CELL_STATE_SEVERITY):
 *  - compileFailed or failures present       → "error"
 *  - blocked ops or blocked targets exist    → "blocked"
 *  - repair ops with reason "drifted"       → "drifted"
 *  - prune ops exist                         → "orphaned"
 *  - repair ops with reason "source-changed" → "stale"
 *  - create ops exist                        → "not-installed"
 *  - otherwise (all ops are skip/chmod)      → "synced"
 */
export const classifyHarness = (plan: HarnessPlan): HarnessStatusCell => {
  // Tally ops by kind
  const opCounts: Partial<Record<SyncOpKind, number>> = {};
  for (const op of plan.ops) {
    opCounts[op.kind] = (opCounts[op.kind] ?? 0) + 1;
  }

  // Determine state by worst-wins logic
  let state: CellState = "synced";

  // Error (compile failure or sync failures)
  if (plan.compileFailed || plan.failures.length > 0) {
    state = "error";
  }
  // Blocked (blocked ops or blocked targets)
  else if (plan.blocked.length > 0 || opCounts.blocked !== undefined) {
    state = "blocked";
  }
  // Drifted (repair ops with drifted reason)
  else if (
    plan.ops.some(
      (op) => op.kind === "repair" && op.reason === "drifted"
    )
  ) {
    state = "drifted";
  }
  // Orphaned (prune ops)
  else if (opCounts.prune !== undefined) {
    state = "orphaned";
  }
  // Stale (repair ops with source-changed reason)
  else if (
    plan.ops.some(
      (op) => op.kind === "repair" && op.reason === "source-changed"
    )
  ) {
    state = "stale";
  }
  // Not installed (create ops)
  else if (opCounts.create !== undefined) {
    state = "not-installed";
  }

  // Extract detail from error, blocked hint, or failure
  let detail: string | undefined;
  if (plan.compileFailed && plan.compile && !plan.compile.ok) {
    detail = plan.compile.error.headline;
  } else if (plan.blocked[0] !== undefined) {
    detail = plan.blocked[0].hint;
  } else if (plan.failures[0] !== undefined) {
    detail = plan.failures[0].message;
  }

  return {
    harness: plan.harness,
    state,
    opCounts,
    blockedCount: plan.blocked.length,
    failureCount: plan.failures.length,
    compileFailed: plan.compileFailed,
    detail,
  };
};

/**
 * Rollup states to the most severe via CELL_STATE_SEVERITY.
 * Empty array returns "n/a".
 */
export const rollupStates = (states: ReadonlyArray<CellState>): CellState => {
  const first = states[0];
  if (first === undefined) return "n/a";

  let mostSevere: CellState = first;
  let maxSeverity = CELL_STATE_SEVERITY.indexOf(mostSevere);

  for (const state of states.slice(1)) {
    const severity = CELL_STATE_SEVERITY.indexOf(state);
    if (severity > maxSeverity) {
      mostSevere = state;
      maxSeverity = severity;
    }
  }

  return mostSevere;
};

/**
 * Rollup cells to the most severe state across their individual states.
 */
export const rollupCells = (
  cells: ReadonlyArray<HarnessStatusCell>
): CellState => {
  return rollupStates(cells.map((cell) => cell.state));
};

/**
 * Map a CellState to a color palette key.
 */
export const stateColor = (state: CellState): string => {
  switch (state) {
    case "synced":
      return PALETTE.green;
    case "stale":
      return PALETTE.yellow;
    case "orphaned":
      return PALETTE.fgDim;
    case "drifted":
      return PALETTE.orange;
    case "blocked":
      return PALETTE.red;
    case "error":
      return PALETTE.red;
    case "not-installed":
      return PALETTE.fgDim;
    case "n/a":
      return PALETTE.fgDim;
  }
};

/**
 * Map a CellState to a sparse, ASCII-safe attention marker. Healthy/neutral
 * states get NO glyph (color carries the meaning) so the UI stays calm and only
 * real problems draw the eye. Returns "" for synced / not-installed / n/a.
 */
export const stateGlyph = (state: CellState): string => {
  switch (state) {
    case "stale":
    case "orphaned":
      return "~";
    case "drifted":
    case "blocked":
    case "error":
      return "!";
    default:
      return "";
  }
};

/**
 * Map a CellState to a short, uppercase label.
 */
export const stateLabel = (state: CellState): string => {
  switch (state) {
    case "synced":
      return "SYNCED";
    case "stale":
      return "STALE";
    case "orphaned":
      return "ORPHANED";
    case "drifted":
      return "DRIFTED";
    case "blocked":
      return "BLOCKED";
    case "error":
      return "ERROR";
    case "not-installed":
      return "NOT INSTALLED";
    case "n/a":
      return "N/A";
  }
};

/**
 * Acceptance runner: executes every acceptance gate and prints one JSON
 * summary table of rows { gate, pass, expected, blocked? }.
 *
 * Exit contract:
 *   - expected-FAIL gates that fail exit 0 — they are tracked debt
 *     (WS3/WS6 nondeterminism), not CI breakage. When they go green the row
 *     is flagged so the owner flips the expectation to PASS.
 *   - expected-PASS gates that fail are regressions -> exit 1.
 *   - blocked stubs (pass=null) never affect the exit code.
 *   - a gate script that crashes or prints no parseable summary is gate
 *     infrastructure breakage -> exit 1.
 *
 * Progress goes to stderr; stdout carries ONLY the final JSON summary.
 *
 * Usage: bun scripts/acceptance/run-all.ts
 */
import { join, resolve } from "node:path";

const ACCEPTANCE_DIR = resolve(import.meta.dir);

interface GateScript {
  /** Expectation for scripts that do not declare per-gate expectations themselves. */
  readonly expected: "PASS" | "FAIL" | null;
  readonly script: string;
}

const GATE_SCRIPTS: ReadonlyArray<GateScript> = [
  { script: "idempotency-git.ts", expected: "PASS" },
  { script: "crash-convergence.ts", expected: "PASS" },
  { script: "matrix-codex-opencode.ts", expected: "PASS" },
  { script: "mcp-determinism.ts", expected: null },
  { script: "mcp-lifecycle.ts", expected: null },
  { script: "orbit-workflows.ts", expected: "PASS" },
];

interface GateRow {
  readonly gate: string;
  readonly pass: boolean | null;
  readonly expected: "PASS" | "FAIL" | null;
  readonly blocked?: string;
  readonly note?: string;
}

interface ParsedSummary {
  readonly gate?: unknown;
  readonly pass?: unknown;
  readonly expected?: unknown;
  readonly blocked?: unknown;
  readonly gates?: unknown;
}

/** The gate scripts print human progress lines first and a pretty-printed JSON summary last. */
const parseTrailingJson = (stdout: string): ParsedSummary | undefined => {
  const text = stdout.trimEnd();
  const start = text.startsWith("{") ? 0 : text.lastIndexOf("\n{") + 1;
  if (start <= 0 && !text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text.slice(start)) as ParsedSummary;
  } catch {
    return undefined;
  }
};

const normalizeExpected = (value: unknown): "PASS" | "FAIL" | null =>
  value === "PASS" || value === "FAIL" ? value : null;

const rowsFromSummary = (
  summary: ParsedSummary,
  fallbackGate: string,
  fallbackExpected: "PASS" | "FAIL" | null,
): GateRow[] => {
  if (Array.isArray(summary.gates)) {
    return summary.gates.map((entry) => {
      const gate = entry as ParsedSummary & { readonly note?: unknown };
      return {
        gate: typeof gate.gate === "string" ? gate.gate : fallbackGate,
        pass: typeof gate.pass === "boolean" ? gate.pass : null,
        expected: normalizeExpected(gate.expected),
        ...(typeof gate.blocked === "string" ? { blocked: gate.blocked } : {}),
      };
    });
  }
  return [
    {
      gate: typeof summary.gate === "string" ? summary.gate : fallbackGate,
      pass: typeof summary.pass === "boolean" ? summary.pass : null,
      expected: normalizeExpected(summary.expected) ?? fallbackExpected,
      ...(typeof summary.blocked === "string" ? { blocked: summary.blocked } : {}),
    },
  ];
};

const runGateScript = async (entry: GateScript): Promise<GateRow[]> => {
  const name = entry.script.replace(/\.ts$/u, "");
  console.error(`[run-all] running ${entry.script} ...`);
  const proc = Bun.spawn({
    cmd: ["bun", join(ACCEPTANCE_DIR, entry.script)],
    cwd: ACCEPTANCE_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  for (const line of stdout.split("\n")) {
    if (line.length > 0 && !line.startsWith("{") && !line.startsWith(" ") && !line.startsWith("}")) {
      console.error(`[${name}] ${line}`);
    }
  }

  const summary = parseTrailingJson(stdout);
  if (!summary) {
    return [
      {
        gate: name,
        pass: false,
        expected: "PASS",
        note: `gate script produced no parseable JSON summary (exit ${exitCode}); stderr: ${stderr.trim().slice(0, 300)}`,
      },
    ];
  }
  return rowsFromSummary(summary, name, entry.expected);
};

const main = async (): Promise<void> => {
  const rows: GateRow[] = [];
  for (const entry of GATE_SCRIPTS) {
    rows.push(...(await runGateScript(entry)));
  }

  const regressions = rows.filter((row) => row.expected === "PASS" && row.pass !== true);
  const trackedDebt = rows.filter((row) => row.expected === "FAIL" && row.pass === false);
  const flipCandidates = rows.filter((row) => row.expected === "FAIL" && row.pass === true);
  const blocked = rows.filter((row) => row.pass === null);

  const summary = {
    schema: "prism.acceptance.run-all.v1",
    pass: regressions.length === 0,
    counts: {
      gates: rows.length,
      regressions: regressions.length,
      trackedDebt: trackedDebt.length,
      blocked: blocked.length,
    },
    ...(flipCandidates.length > 0
      ? {
          note: `expected-FAIL gate(s) went green: ${flipCandidates
            .map((row) => row.gate)
            .join(", ")} — flip their expectation to PASS`,
        }
      : {}),
    gates: rows,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = regressions.length === 0 ? 0 : 1;
};

await main();

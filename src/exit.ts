/**
 * Process exit-code contract (docs/overhaul-one-writer-plan.md, WS2).
 *
 *   0 — success / already converged
 *   1 — domain failure (compile, validation, refresh, sync)
 *   2 — usage error (bad flags, missing arguments)
 *   3 — environment failure (missing tools, unreadable PRISM_HOME, …)
 *
 * `exitWith` is the only sanctioned way for command handlers to terminate
 * the process. WS7's static gate asserts no `process.exit` outside the CLI
 * edge once the legacy command surface is deleted.
 */

export const EXIT_CODES = {
  success: 0,
  domainFailure: 1,
  usage: 2,
  environment: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitWith(code: ExitCode): never {
  return process.exit(code);
}

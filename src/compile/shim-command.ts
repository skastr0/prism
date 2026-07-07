/**
 * The MCP shim `command` value every stdio-shim lowerer stamps into a
 * harness's generated config.
 *
 * The bug this fixes: every lowerer used to hardcode the literal `"prism"`,
 * so a `prism-dev` compile (the evidence loop the operator actually drives
 * work through) still told every harness to spawn the *production* `prism`
 * off PATH. When that production binary is a different, older shim version
 * (or the wire-naming contract it speaks has drifted), the config and the
 * binary serving it skew apart silently.
 *
 * The fix: stamp the binary that is *running the compile itself* — config
 * and shim can never version-skew again, because they are, by construction,
 * the same binary.
 *
 *   - production binary (basename `prism`): stamp the literal `"prism"`.
 *     It is expected on PATH; this also keeps existing installs and the
 *     golden fixtures (compiled under `bun`, see below) stable.
 *   - the bun dev-driver (`bun src/cli.ts` — `process.execPath` is the
 *     `bun` binary itself, not a prism binary): stamp `"prism"` too. There
 *     is no compiled dev identity to self-reference in that mode.
 *   - any other compiled binary (`prism-dev`, or a custom install name):
 *     stamp its own absolute self path (`process.execPath`), so a
 *     dev-compiled config always spawns the exact dev binary that compiled
 *     it, never a possibly-stale-or-absent `prism` on PATH.
 */

import { basename } from "node:path";

/** Matches the bun driver's own executable name, on POSIX or Windows. */
const isBunDriverExecPath = (execPath: string): boolean => /^bun(?:\.exe)?$/iu.test(basename(execPath));

/** Matches the production binary's own name, on POSIX or Windows. */
const isProductionExecPath = (execPath: string): boolean => /^prism(?:\.exe)?$/iu.test(basename(execPath));

/**
 * Resolve the MCP shim `command` a lowerer should stamp, from the binary
 * currently running the compile (`process.execPath` by default — accept an
 * override for tests).
 */
export const shimCommandForCompile = (execPath: string = process.execPath): string => {
  if (isProductionExecPath(execPath) || isBunDriverExecPath(execPath)) return "prism";
  return execPath;
};

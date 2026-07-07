/**
 * Keyed challenge-proof shared by the generated `challenge_echo` tool and the
 * smoke workflows' finish judges.
 *
 * The proof must not be derivable from the task prompt alone: the E2E matrix
 * generates a fresh random secret per run and the proof is an HMAC-SHA256 of
 * the challenge under that secret, so an agent that never reaches the real
 * generated tool cannot fabricate a passing output. Without a secret (manual
 * standalone workflow runs) both sides fall back to the legacy unkeyed string.
 *
 * Secret resolution is per-call, file first:
 *  - `<runtime dir>/challenge-proof-secret` next to the daemon's UDS socket
 *    (`PRISM_MCP_UDS_PATH` is set by the daemon resolver at spawn). The matrix
 *    rewrites this file every run, so a reused daemon whose environment was
 *    captured at spawn still reads the current run's secret.
 *  - `PRISM_HARNESS_QA_PROOF_SECRET` from the environment (in-process tool
 *    bundles — OpenCode, Amp — inherit the workflow runner's environment, and
 *    the workflow-run process itself uses this for the finish judge).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CHALLENGE_PROOF_SECRET_ENV = "PRISM_HARNESS_QA_PROOF_SECRET";
export const CHALLENGE_PROOF_SECRET_FILENAME = "challenge-proof-secret";
export const CHALLENGE_PROOF_KEYED_PREFIX = "prism-tool-proof-hmac:";
export const CHALLENGE_PROOF_UNKEYED_PREFIX = "prism-tool-proof:";

/** The proof for `challenge` under `secret` — what the matrix verifies. */
export const keyedChallengeProof = (challenge: string, secret: string): string =>
  `${CHALLENGE_PROOF_KEYED_PREFIX}${createHmac("sha256", secret).update(challenge).digest("hex")}`;

const secretFromDaemonRuntimeDir = (): string | undefined => {
  const udsPath = process.env.PRISM_MCP_UDS_PATH;
  if (udsPath === undefined || udsPath.length === 0) return undefined;
  try {
    const secret = readFileSync(join(dirname(udsPath), CHALLENGE_PROOF_SECRET_FILENAME), "utf8").trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
};

export const resolveChallengeProofSecret = (): string | undefined => {
  const fromFile = secretFromDaemonRuntimeDir();
  if (fromFile !== undefined) return fromFile;
  const fromEnv = process.env[CHALLENGE_PROOF_SECRET_ENV];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
};

/** The proof for `challenge` under the ambient secret, if any. */
export const challengeProof = (challenge: string): string => {
  const secret = resolveChallengeProofSecret();
  return secret === undefined
    ? `${CHALLENGE_PROOF_UNKEYED_PREFIX}${challenge}`
    : keyedChallengeProof(challenge, secret);
};

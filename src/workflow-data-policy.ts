import { createHash } from "node:crypto";

/**
 * Central workflow-ledger data policy.
 *
 * All durable workflow evidence and telemetry exports pass through this module.
 * Exact-continuation identifiers and execution provenance are deliberately
 * preserved: they are operational routing data, not authentication secrets.
 * Cache payloads are never mutated. Callers must skip a cache write when
 * `workflowCachePersistenceDecision` rejects it.
 */

export const WORKFLOW_DATA_POLICY_VERSION = 1;
export const WORKFLOW_REDACTION_MARKER = "[REDACTED]";
export const WORKFLOW_SECRET_DIGEST_PREFIX = "sha256:";

export type WorkflowSensitiveDataReason =
  | "sensitive-key"
  | "bearer-credential"
  | "provider-token"
  | "credential-assignment"
  | "private-key"
  | "url-password";

export interface WorkflowSensitiveDataFinding {
  readonly path: string;
  readonly reason: WorkflowSensitiveDataReason;
}

export interface WorkflowDataPolicyResult<Value> {
  readonly value: Value;
  readonly findings: ReadonlyArray<WorkflowSensitiveDataFinding>;
}

export type WorkflowCachePersistenceDecision =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly reason: "sensitive-data";
      readonly findings: ReadonlyArray<WorkflowSensitiveDataFinding>;
    };

const normalizedKey = (key: string): string => key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

// These identifiers are required to prove and perform exact same-session
// continuation. They stay available even when their opaque value resembles a
// provider token. Provenance objects are still traversed normally; only these
// leaf identifiers receive the exception.
const PRESERVED_CONTINUATION_KEYS = new Set([
  "sessionid",
  "externalsessionpointer",
  "conversationid",
  "threadid",
]);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "token",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "privatekey",
  "credentials",
  "cookie",
  "setcookie",
  "handofftoken",
  "runtoken",
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  if (PRESERVED_CONTINUATION_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("clientsecret")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("password");
};

interface WorkflowTextPattern {
  readonly reason: Exclude<WorkflowSensitiveDataReason, "sensitive-key">;
  readonly pattern: RegExp;
  readonly replacement: string | ((substring: string, ...args: string[]) => string);
}

const TEXT_PATTERNS: ReadonlyArray<WorkflowTextPattern> = [
  {
    reason: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: WORKFLOW_REDACTION_MARKER,
  },
  {
    reason: "bearer-credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Bearer ${WORKFLOW_REDACTION_MARKER}`,
  },
  {
    reason: "provider-token",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
    replacement: WORKFLOW_REDACTION_MARKER,
  },
  {
    reason: "credential-assignment",
    pattern: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b(\s*[=:]\s*)(["'])(?:\\.|[^\\])*?\3/gi,
    replacement: (_match: string, label: string, separator: string, quote: string) =>
      `${label}${separator}${quote}${WORKFLOW_REDACTION_MARKER}${quote}`,
  },
  {
    reason: "credential-assignment",
    pattern: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b(\s*[=:]\s*)[^\s,"'&]+/gi,
    replacement: (_match: string, label: string, separator: string) =>
      `${label}${separator}${WORKFLOW_REDACTION_MARKER}`,
  },
  {
    reason: "url-password",
    pattern: /\b(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    replacement: (_match: string, prefix: string, suffix: string) =>
      `${prefix}${WORKFLOW_REDACTION_MARKER}${suffix}`,
  },
];

const pathForKey = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const redactText = (
  input: string,
): { readonly value: string; readonly reasons: ReadonlyArray<WorkflowSensitiveDataReason> } => {
  let value = input;
  const reasons = new Set<WorkflowSensitiveDataReason>();
  for (const entry of TEXT_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (!entry.pattern.test(value)) continue;
    reasons.add(entry.reason);
    entry.pattern.lastIndex = 0;
    value = value.replace(entry.pattern, entry.replacement as never);
  }
  return { value, reasons: [...reasons] };
};

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

interface PolicyWalkResult {
  readonly value: unknown;
  readonly findings: WorkflowSensitiveDataFinding[];
}

const walkWorkflowData = (
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
  preserveOpaqueIdentifier = false,
): PolicyWalkResult => {
  if (typeof input === "string") {
    if (preserveOpaqueIdentifier) return { value: input, findings: [] };
    const redacted = redactText(input);
    return {
      value: redacted.value,
      findings: redacted.reasons.map((reason) => ({ path, reason })),
    };
  }
  if (input === null || typeof input !== "object") {
    return { value: input, findings: [] };
  }
  if (ancestors.has(input)) {
    // JSON persistence rejects cyclic data. Leave it untouched so the normal
    // serializer remains the source of that contract error rather than hiding
    // it behind a policy-specific representation.
    return { value: input, findings: [] };
  }
  const hasCustomJsonSerialization = typeof (input as { readonly toJSON?: unknown }).toJSON === "function";
  if (hasCustomJsonSerialization || (!Array.isArray(input) && !isPlainRecord(input))) {
    // JSON persistence invokes Date/URL/custom `toJSON` methods after an
    // ordinary object walk. Normalize that exact serialized representation
    // first, then inspect it, so a prototype cannot smuggle a credential past
    // the policy. The returned value is plain JSON data and must be the value
    // callers persist; this also avoids a second, potentially non-deterministic
    // `toJSON` invocation between inspection and write.
    const serialized = JSON.stringify(input);
    const normalized = serialized === undefined
      ? undefined
      : JSON.parse(serialized) as unknown;
    return walkWorkflowData(normalized, path, ancestors, preserveOpaqueIdentifier);
  }

  ancestors.add(input);
  const findings: WorkflowSensitiveDataFinding[] = [];
  if (Array.isArray(input)) {
    const value = input.map((item, index) => {
      const nested = walkWorkflowData(item, `${path}[${index}]`, ancestors);
      findings.push(...nested.findings);
      return nested.value;
    });
    ancestors.delete(input);
    return { value, findings };
  }

  const value: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    const redactedKey = redactText(key);
    let persistedKey = redactedKey.value;
    if (Object.prototype.hasOwnProperty.call(value, persistedKey)) {
      let collision = 2;
      while (Object.prototype.hasOwnProperty.call(value, `${persistedKey}#${collision}`)) collision += 1;
      persistedKey = `${persistedKey}#${collision}`;
    }
    const childPath = pathForKey(path, persistedKey);
    findings.push(...redactedKey.reasons.map((reason) => ({ path: childPath, reason })));
    if (isSensitiveKey(key)) {
      value[persistedKey] = WORKFLOW_REDACTION_MARKER;
      findings.push({ path: childPath, reason: "sensitive-key" });
      continue;
    }
    const preserve = PRESERVED_CONTINUATION_KEYS.has(normalizedKey(key));
    const nested = walkWorkflowData(child, childPath, ancestors, preserve);
    value[persistedKey] = nested.value;
    findings.push(...nested.findings);
  }
  ancestors.delete(input);
  return { value, findings };
};

export const applyWorkflowDataPolicy = <Value>(input: Value): WorkflowDataPolicyResult<Value> => {
  const result = walkWorkflowData(input, "$", new WeakSet());
  return { value: result.value as Value, findings: result.findings };
};

export const inspectWorkflowSensitiveData = (
  input: unknown,
): ReadonlyArray<WorkflowSensitiveDataFinding> =>
  applyWorkflowDataPolicy(input).findings;

export const redactWorkflowData = <Value>(input: Value): Value =>
  applyWorkflowDataPolicy(input).value;

export const redactWorkflowText = (input: string): string => redactText(input).value;

export const digestWorkflowSecret = (input: string): string =>
  `${WORKFLOW_SECRET_DIGEST_PREFIX}${createHash("sha256").update(input).digest("hex")}`;

export const workflowCachePersistenceDecision = (
  input: {
    readonly output: unknown;
    readonly metadata?: Record<string, unknown>;
    readonly identity?: unknown;
    readonly agent?: unknown;
  },
): WorkflowCachePersistenceDecision => {
  const findings = inspectWorkflowSensitiveData({
    ...(input.identity !== undefined ? { identity: input.identity } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    output: input.output,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
  return findings.length === 0
    ? { safe: true }
    : { safe: false, reason: "sensitive-data", findings };
};

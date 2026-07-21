import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_DATA_POLICY_VERSION,
  WORKFLOW_REDACTION_MARKER,
  digestWorkflowSecret,
  inspectWorkflowSensitiveData,
  redactWorkflowData,
  redactWorkflowText,
  workflowCachePersistenceDecision,
} from "./workflow-data-policy.js";

describe("workflow data policy", () => {
  test("redacts sensitive keys recursively without retaining the original value", () => {
    const input = {
      authorization: "Bearer top-secret-token",
      nested: [{ api_key: "api-key-value" }, { clientSecret: "client-secret-value" }],
      safe: "ordinary evidence",
    };

    expect(redactWorkflowData(input)).toEqual({
      authorization: WORKFLOW_REDACTION_MARKER,
      nested: [
        { api_key: WORKFLOW_REDACTION_MARKER },
        { clientSecret: WORKFLOW_REDACTION_MARKER },
      ],
      safe: "ordinary evidence",
    });
    expect(inspectWorkflowSensitiveData(input).map((finding) => finding.path)).toEqual([
      "$.authorization",
      "$.nested[0].api_key",
      "$.nested[1].clientSecret",
    ]);
  });

  test("redacts credentials embedded in text", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnop",
      "api_key=secret-value",
      'password="a quoted secret with spaces"',
      "client_secret='another quoted secret'",
      "https://operator:password-value@example.test/path",
      "sk-abcdefghijklmnopqrstuv",
    ].join("\n");

    const redacted = redactWorkflowText(text);
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("a quoted secret with spaces");
    expect(redacted).not.toContain("another quoted secret");
    expect(redacted).not.toContain("password-value");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(redacted).toContain(WORKFLOW_REDACTION_MARKER);
  });

  test("normalizes and redacts URL and custom toJSON representations before persistence", () => {
    let toJsonCalls = 0;
    const input = {
      endpoint: new URL("https://operator:url-password@example.test/path"),
      envelope: {
        toJSON() {
          toJsonCalls += 1;
          return { password: "custom-to-json-secret" };
        },
      },
    };

    const redacted = redactWorkflowData(input);
    const serialized = JSON.stringify(redacted);
    expect(toJsonCalls).toBe(1);
    expect(serialized).not.toContain("url-password");
    expect(serialized).not.toContain("custom-to-json-secret");
    expect(serialized).toContain(WORKFLOW_REDACTION_MARKER);
    expect(workflowCachePersistenceDecision({ output: input })).toMatchObject({
      safe: false,
      reason: "sensitive-data",
    });
  });

  test("redacts secret-shaped dynamic object keys without leaking them through finding paths", () => {
    const secretKey = "sk-abcdefghijklmnopqrstuv";
    const input = {
      [secretKey]: "credential used as a dynamic map key",
      "api_key=dynamic-key-secret": "second value",
    };

    const redacted = redactWorkflowData(input);
    const serialized = JSON.stringify(redacted);
    const findings = inspectWorkflowSensitiveData(input);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("dynamic-key-secret");
    expect(serialized).toContain(WORKFLOW_REDACTION_MARKER);
    expect(JSON.stringify(findings)).not.toContain(secretKey);
    expect(JSON.stringify(findings)).not.toContain("dynamic-key-secret");
    expect(workflowCachePersistenceDecision({ output: input })).toMatchObject({
      safe: false,
      reason: "sensitive-data",
    });
  });

  test("preserves exact-continuation session ids and execution provenance", () => {
    const input = {
      adapter: "codex-cli",
      sessionId: "sk-session-shaped-but-operational",
      external_session_pointer: "provider-session-2",
      executionProvenance: {
        schema: "prism.workflow-execution-provenance.v1",
        planned: { worker: "codex-cli", sourceHash: "abc" },
        actual: { worker: "codex-cli", sessionId: "sk-another-session-shaped-id" },
      },
    };

    expect(redactWorkflowData(input)).toEqual(input);
    expect(inspectWorkflowSensitiveData(input)).toEqual([]);
  });

  test("does not mistake usage counters and hashes for credentials", () => {
    const input = {
      tokensIn: 120,
      tokensOut: 30,
      promptHash: "hash",
      agentManifestHash: "hash-2",
      cacheKey: "cache-key",
    };

    expect(redactWorkflowData(input)).toEqual(input);
    expect(inspectWorkflowSensitiveData(input)).toEqual([]);
  });

  test("rejects secret-bearing cache entries instead of mutating replay semantics", () => {
    const output = { result: "valid", accessToken: "must-not-persist" };
    const decision = workflowCachePersistenceDecision({ output });

    expect(decision).toEqual({
      safe: false,
      reason: "sensitive-data",
      findings: [{ path: "$.output.accessToken", reason: "sensitive-key" }],
    });
    expect(output.accessToken).toBe("must-not-persist");
  });

  test("accepts safe cache entries without transforming them", () => {
    expect(workflowCachePersistenceDecision({
      output: { result: "ok" },
      metadata: { adapter: "codex-cli", sessionId: "session-1" },
    })).toEqual({ safe: true });
  });

  test("publishes a stable policy version", () => {
    expect(WORKFLOW_DATA_POLICY_VERSION).toBe(1);
  });

  test("digests ephemeral handoff secrets deterministically without retaining plaintext", () => {
    const digest = digestWorkflowSecret("one-use-handoff-token");
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digest).toBe(digestWorkflowSecret("one-use-handoff-token"));
    expect(digest).not.toContain("one-use-handoff-token");
  });
});

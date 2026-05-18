/**
 * Central timeout policy for Prism-generated MCP servers.
 *
 * `toolTimeoutMs` is the canonical Prism-side tool call timeout. Harness
 * client configs that expose request timeout fields render it from this value.
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

export const mcpTimeoutMsToClientSeconds = (timeoutMs: number): number =>
  Math.max(1, Math.ceil(timeoutMs / 1_000));

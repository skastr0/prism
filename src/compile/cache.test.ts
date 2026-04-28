import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  CACHE_FORMAT_VERSION,
  COMPILER_SEMANTICS_VERSION,
  computeCacheKey,
  computeContextHash,
} from "./cache.js";

test("compile cache keys include compiler semantic version", () => {
  const contextShape = JSON.stringify({
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    compilerSemanticsVersion: COMPILER_SEMANTICS_VERSION,
    scope: "global",
    target: "opencode",
  });

  const expectedContextHash = createHash("sha256")
    .update(contextShape)
    .digest("hex");
  expect(computeContextHash({ target: "opencode", scope: "global" })).toBe(
    expectedContextHash,
  );

  const expectedKey = createHash("sha256")
    .update("source-hash")
    .update(contextShape)
    .digest("hex");
  expect(computeCacheKey("source-hash", { target: "opencode", scope: "global" })).toBe(
    expectedKey,
  );
});

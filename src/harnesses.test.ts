import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  getHarness,
  relativeHarnessHome,
  resolveCompileSandboxRoot,
} from "./harnesses.js";

test("relativeHarnessHome strips the ~ prefix from the registry global path", () => {
  expect(relativeHarnessHome(getHarness("opencode"))).toBe(".config/opencode");
  expect(relativeHarnessHome(getHarness("claude-code"))).toBe(".claude");
  expect(relativeHarnessHome(getHarness("cursor"))).toBe(".cursor");
  expect(relativeHarnessHome(getHarness("hermes"))).toBe(".hermes");
  expect(relativeHarnessHome(getHarness("antigravity-cli"))).toBe(
    ".gemini/antigravity-cli",
  );
});

test("resolveCompileSandboxRoot nests each harness under the compile-root prefix", () => {
  const prefix = "/tmp/prism-compile-sandbox";

  expect(resolveCompileSandboxRoot(prefix, getHarness("opencode"), "global")).toBe(
    join(prefix, ".config/opencode"),
  );
  expect(resolveCompileSandboxRoot(prefix, getHarness("claude-code"), "global")).toBe(
    join(prefix, ".claude"),
  );
  expect(resolveCompileSandboxRoot(prefix, getHarness("opencode"), "project")).toBe(
    join(prefix, ".opencode/"),
  );
  expect(resolveCompileSandboxRoot(prefix, getHarness("hermes"), "project")).toBe(
    join(prefix, ".hermes"),
  );
});

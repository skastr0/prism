import { describe, expect, test } from "bun:test";
import { shimCommandForCompile } from "./shim-command.js";

describe("shimCommandForCompile", () => {
  test("production binary (basename prism) stamps the literal prism", () => {
    expect(shimCommandForCompile("/usr/local/bin/prism")).toBe("prism");
    expect(shimCommandForCompile("/opt/mise/shims/prism")).toBe("prism");
  });

  test("bun dev-driver (bun src/cli.ts) stamps the literal prism", () => {
    expect(shimCommandForCompile("/opt/homebrew/bin/bun")).toBe("prism");
    expect(shimCommandForCompile("/usr/local/bin/bun.exe")).toBe("prism");
  });

  test("compiled dev binary (prism-dev) stamps its own absolute self path", () => {
    const execPath = "/Users/dev/.local/bin/prism-dev";
    expect(shimCommandForCompile(execPath)).toBe(execPath);
  });

  test("any custom-named compiled binary stamps its own absolute self path", () => {
    const execPath = "/Users/dev/.local/bin/prism-staging";
    expect(shimCommandForCompile(execPath)).toBe(execPath);
  });

  test("defaults to process.execPath when no override is given", () => {
    expect(shimCommandForCompile()).toBe(shimCommandForCompile(process.execPath));
  });
});

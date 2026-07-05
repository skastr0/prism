import { describe, expect, test } from "bun:test";
import {
  applyBump,
  computeBump,
  formatVersion,
  highestTag,
  parseTag,
} from "./derive-version";

describe("parseTag / highestTag", () => {
  test("parses a well-formed semver tag", () => {
    expect(parseTag("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("rejects non-semver tags", () => {
    expect(parseTag("v1.2.3-rc.1")).toBeNull();
    expect(parseTag("release-1.2.3")).toBeNull();
    expect(parseTag("")).toBeNull();
  });

  test("picks the highest tag numerically, not lexically", () => {
    expect(highestTag(["v0.2.2", "v0.10.0", "v0.3.0"])).toEqual({
      major: 0,
      minor: 10,
      patch: 0,
    });
  });

  test("returns null for an empty tag list", () => {
    expect(highestTag([])).toBeNull();
  });
});

describe("computeBump + applyBump — fixture table", () => {
  test("feat -> minor", () => {
    const bump = computeBump([{ subject: "feat(cli): add foo", body: "" }]);
    expect(bump).toBe("minor");
    expect(formatVersion(applyBump({ major: 1, minor: 2, patch: 3 }, bump, { v0: false }))).toBe(
      "v1.3.0",
    );
  });

  test("fix -> patch", () => {
    const bump = computeBump([{ subject: "fix(cli): correct bar", body: "" }]);
    expect(bump).toBe("patch");
    expect(formatVersion(applyBump({ major: 1, minor: 2, patch: 3 }, bump, { v0: false }))).toBe(
      "v1.2.4",
    );
  });

  test("perf -> patch", () => {
    const bump = computeBump([{ subject: "perf(cli): speed up baz", body: "" }]);
    expect(bump).toBe("patch");
  });

  test("breaking bang, under v0 -> minor bump", () => {
    const bump = computeBump([{ subject: "feat(cli)!: drop legacy flag", body: "" }]);
    expect(bump).toBe("major");
    expect(
      formatVersion(applyBump({ major: 0, minor: 5, patch: 1 }, bump, { v0: true })),
    ).toBe("v0.6.0");
  });

  test("breaking footer, above v0 -> major bump", () => {
    const bump = computeBump([
      { subject: "feat(cli): drop legacy flag", body: "BREAKING CHANGE: removes --old" },
    ]);
    expect(bump).toBe("major");
    expect(
      formatVersion(applyBump({ major: 1, minor: 5, patch: 1 }, bump, { v0: false })),
    ).toBe("v2.0.0");
  });

  test("breaking on major 0 bumps minor even without --v0", () => {
    const bump = computeBump([{ subject: "feat(cli)!: drop legacy flag", body: "" }]);
    expect(
      formatVersion(applyBump({ major: 0, minor: 5, patch: 1 }, bump, { v0: false })),
    ).toBe("v0.6.0");
  });

  test("mixed feat+fix -> minor wins over patch", () => {
    const bump = computeBump([
      { subject: "fix(cli): correct bar", body: "" },
      { subject: "feat(cli): add foo", body: "" },
    ]);
    expect(bump).toBe("minor");
    expect(formatVersion(applyBump({ major: 1, minor: 0, patch: 0 }, bump, { v0: false }))).toBe(
      "v1.1.0",
    );
  });

  test("docs/chore/style/refactor/test/ci/build only -> no bump", () => {
    const bump = computeBump([
      { subject: "chore: bump deps", body: "" },
      { subject: "docs: fix typo", body: "" },
      { subject: "ci: tweak workflow", body: "" },
      { subject: "style: reformat", body: "" },
      { subject: "refactor: rename var", body: "" },
      { subject: "test: add case", body: "" },
      { subject: "build: bump esbuild", body: "" },
    ]);
    expect(bump).toBe("none");
    const current = { major: 1, minor: 2, patch: 3 };
    expect(formatVersion(applyBump(current, bump, { v0: false }))).toBe(
      formatVersion(current),
    );
  });

  test("no tag -> derive from v0.0.0", () => {
    const bump = computeBump([{ subject: "feat: first feature", body: "" }]);
    expect(bump).toBe("minor");
    expect(
      formatVersion(applyBump({ major: 0, minor: 0, patch: 0 }, bump, { v0: false })),
    ).toBe("v0.1.0");
  });

  test("empty commit list -> no bump", () => {
    expect(computeBump([])).toBe("none");
  });

  test("merge commits (non-conventional type) do not bump", () => {
    const bump = computeBump([
      { subject: "merge: stab/some-branch (release-train unblock)", body: "" },
    ]);
    expect(bump).toBe("none");
  });
});

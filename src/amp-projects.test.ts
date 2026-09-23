import { describe, expect, test } from "bun:test";
import {
  ampOrbProjectRefs,
  ampProjectRefs,
  parseAmpProjectsList,
  validateAmpOrbProject,
  type DiscoveredAmpProjects,
} from "./amp-projects.js";

// Shape of `amp projects list --json` (amp 0.0.1790107230, 2026-09-22), ids redacted.
const LIST_JSON = JSON.stringify([
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "prism",
    namespace: "acme-ns",
    repositoryURL: "https://github.com/acme/prism",
    remoteURLs: ["https://github.com/acme/prism"],
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "orb-setup",
    namespace: "acme-ns",
    repositoryURL: "https://github.com/acme/orb-setup.git",
    remoteURLs: ["https://github.com/acme/orb-setup.git", "https://gitlab.com/group/sub/orb-setup"],
  },
]);

const discovered = (): DiscoveredAmpProjects => ({ projects: parseAmpProjectsList(LIST_JSON).projects, source: "command" });

describe("parseAmpProjectsList", () => {
  test("keeps id, namespace, name, and repository URLs", () => {
    const { projects, error } = parseAmpProjectsList(LIST_JSON);
    expect(error).toBeUndefined();
    expect(projects.map((project) => `${project.namespace}/${project.name}`)).toEqual(["acme-ns/prism", "acme-ns/orb-setup"]);
    expect(projects[0]?.repositoryURL).toBe("https://github.com/acme/prism");
  });

  test("skips rows without id/namespace/name and reports non-JSON", () => {
    expect(parseAmpProjectsList(JSON.stringify([{ name: "x" }, { id: "1", namespace: "n", name: "ok" }])).projects)
      .toEqual([{ id: "1", namespace: "n", name: "ok" }]);
    expect(parseAmpProjectsList("Error: not logged in").error).toContain("not JSON");
    expect(parseAmpProjectsList("{}").error).toContain("array");
  });
});

describe("ampProjectRefs", () => {
  test("admits the three documented --project forms", () => {
    const [prism, orbSetup] = discovered().projects;
    expect(ampProjectRefs(prism!)).toEqual(["acme-ns/prism", "acme/prism", "https://github.com/acme/prism"]);
    // owner/repo only from two-segment paths (.git stripped); a nested GitLab path contributes its URL only.
    expect(ampProjectRefs(orbSetup!)).toEqual([
      "acme-ns/orb-setup",
      "acme/orb-setup",
      "https://github.com/acme/orb-setup.git",
      "https://gitlab.com/group/sub/orb-setup",
    ]);
  });

  test("never admits project ids or @-prefixed refs", () => {
    const refs = ampOrbProjectRefs(discovered());
    expect(refs.some((ref) => ref.startsWith("@") || ref.startsWith("00000000"))).toBe(false);
  });
});

describe("validateAmpOrbProject", () => {
  test("accepts every admitted form", () => {
    for (const ref of ampOrbProjectRefs(discovered())) {
      expect(validateAmpOrbProject(ref, discovered())).toBeUndefined();
    }
  });

  test("unknown project fails with the known list, a nearby match, and the refresh remediation", () => {
    const error = validateAmpOrbProject("someone-else/prism", discovered());
    expect(error).toContain('Unknown Amp project "someone-else/prism"');
    expect(error).toContain('Did you mean "acme-ns/prism"?');
    expect(error).toContain("Known projects (namespace/name; the owner/repo and repository URL of each are also accepted): acme-ns/orb-setup, acme-ns/prism.");
    expect(error).toContain("prism workflow refresh-harness-types");
  });

  test("no snapshot or no discovered projects leaves project a free string", () => {
    expect(validateAmpOrbProject("anything/goes", undefined)).toBeUndefined();
    expect(validateAmpOrbProject("anything/goes", { projects: [], source: "empty", error: "not logged in" })).toBeUndefined();
  });
});

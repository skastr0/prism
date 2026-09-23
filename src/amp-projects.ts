/**
 * Amp orb projects, discovered by `prism workflow refresh-harness-types` from
 * `amp projects list --json` and used to type and validate `worker.project`
 * on `amp-orb` tasks and named workers.
 *
 * `amp --project` documents three identifier forms (namespace/name,
 * owner/repo, repository URL); each project contributes every form it has.
 * Project ids and `@namespace/name` also resolve through `amp projects get`,
 * but `--project` does not document them, so they are not admitted.
 */

export interface AmpProject {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly repositoryURL?: string;
  readonly remoteURLs?: readonly string[];
}

export interface DiscoveredAmpProjects {
  readonly projects: readonly AmpProject[];
  readonly source: "command" | "empty";
  readonly error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Parse `amp projects list --json`: an array of `{ id, namespace, name, repositoryURL, remoteURLs }`. */
export const parseAmpProjectsList = (stdout: string): { readonly projects: AmpProject[]; readonly error?: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    return { projects: [], error: `amp projects list --json is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!Array.isArray(parsed)) return { projects: [], error: "amp projects list --json did not return an array" };
  const projects: AmpProject[] = [];
  for (const row of parsed) {
    if (!isRecord(row)) continue;
    const id = nonBlank(row.id);
    const namespace = nonBlank(row.namespace);
    const name = nonBlank(row.name);
    if (id === undefined || namespace === undefined || name === undefined) continue;
    const repositoryURL = nonBlank(row.repositoryURL);
    const remoteURLs = Array.isArray(row.remoteURLs)
      ? row.remoteURLs.map(nonBlank).filter((url): url is string => url !== undefined)
      : [];
    projects.push({
      id,
      namespace,
      name,
      ...(repositoryURL !== undefined ? { repositoryURL } : {}),
      ...(remoteURLs.length > 0 ? { remoteURLs } : {}),
    });
  }
  return { projects };
};

/** The canonical `--project` form. */
export const ampProjectCanonicalRef = (project: AmpProject): string => `${project.namespace}/${project.name}`;

/** `owner/repo` from a two-segment repository URL path (`https://host/owner/repo[.git]`). */
const ownerRepoFromUrl = (url: string): string | undefined => {
  try {
    const segments = new URL(url).pathname.replace(/\.git$/u, "").split("/").filter((segment) => segment.length > 0);
    return segments.length === 2 ? `${segments[0]}/${segments[1]}` : undefined;
  } catch {
    return undefined;
  }
};

/** Every documented `--project` form for one project: namespace/name, owner/repo, and repository URLs. */
export const ampProjectRefs = (project: AmpProject): readonly string[] => {
  const urls = [...(project.repositoryURL !== undefined ? [project.repositoryURL] : []), ...(project.remoteURLs ?? [])];
  const ownerRepos = urls.map(ownerRepoFromUrl).filter((ref): ref is string => ref !== undefined);
  return [...new Set([ampProjectCanonicalRef(project), ...ownerRepos, ...urls])];
};

/** Sorted union of every admitted `worker.project` value. Empty when discovery found none. */
export const ampOrbProjectRefs = (discovered: DiscoveredAmpProjects | undefined): readonly string[] =>
  [...new Set((discovered?.projects ?? []).flatMap((project) => ampProjectRefs(project)))]
    .sort((left, right) => left.localeCompare(right));

/**
 * Fail closed on an `amp-orb` project that the snapshot does not list.
 * No snapshot, or a snapshot without projects, leaves `project` a free string
 * (the same fallback as every other discovered union).
 */
export const validateAmpOrbProject = (
  project: string,
  discovered: DiscoveredAmpProjects | undefined,
): string | undefined => {
  const projects = discovered?.projects ?? [];
  if (projects.length === 0) return undefined;
  if (ampOrbProjectRefs(discovered).includes(project)) return undefined;
  const wanted = project.replace(/\.git$/u, "").split("/").filter((segment) => segment.length > 0).at(-1)?.toLowerCase();
  const nearby = projects.filter((candidate) => candidate.name.toLowerCase() === wanted).map(ampProjectCanonicalRef);
  const known = projects.map(ampProjectCanonicalRef).sort((left, right) => left.localeCompare(right));
  return [
    `Unknown Amp project ${JSON.stringify(project)} for worker 'amp-orb'.`,
    nearby.length > 0 ? `Did you mean ${nearby.map((ref) => JSON.stringify(ref)).join(" or ")}?` : undefined,
    `Known projects (namespace/name; the owner/repo and repository URL of each are also accepted): ${known.join(", ")}.`,
    `Fix: set worker.project to one of them. If the project was just created, run \`prism workflow refresh-harness-types\` first.`,
  ].filter((line): line is string => line !== undefined).join(" ");
};

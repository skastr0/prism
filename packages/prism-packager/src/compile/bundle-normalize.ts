/**
 * Bun.build emits a `// <path>` banner comment above every bundled module,
 * with the path rendered relative to the build cwd. Those banners make bundle
 * bytes a function of where the compiler ran (cwd depth, checkout location,
 * tempdir), which breaks byte-determinism across machines and invocations.
 *
 * One normalizer strips every module banner so bundle bytes are a pure
 * function of (plugin source, prism version, bun version). Used by both the
 * MCP server bundler and the hook wrapper bundler — keep it the only one.
 *
 * A banner line is exactly `// ` followed by a single path-like token:
 * containing a slash, or a bare filename with a JS/TS extension.
 */
export const stripBundlerPathComments = (content: string): string =>
  content.replace(/^\/\/ (?:\S*\/\S*|\S+\.(?:m?[jt]s|[jt]sx|c[jt]s))\n/gm, "");

import { chmodFile, writeFile } from "../fs.js";

/**
 * Process-supervision (registering/reaping spawned MCP daemon child
 * processes) lived here before the UDS consolidation: it existed only to
 * support the manual `prism mcp serve`/`stop`/`restart` commands, which are
 * retired. Daemons are now resolve-or-spawned by the stdio shim and
 * idle-reap themselves (see `packages/prism-sdk/src/mcp/daemon-resolver.ts`
 * and `src/compile/mcp-bundle.ts`'s `MCP_SDK_HTTP_RUNTIME`), so there is no
 * long-lived parent process left to supervise a child. Only the plain
 * atomic-file-write helpers below remain in use (by
 * `src/mcp/runtime-metadata.ts`).
 */

export const writeSupervisorTextFile = async (
  path: string,
  content: string,
  options: { readonly mode?: number } = {},
): Promise<void> => {
  await writeFile(path, content, options);
  if (options.mode !== undefined) {
    await chmodFile(path, options.mode);
  }
};

export const writeSupervisorJsonFile = async (
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {},
): Promise<void> =>
  writeSupervisorTextFile(path, `${JSON.stringify(value, null, 2)}\n`, options);

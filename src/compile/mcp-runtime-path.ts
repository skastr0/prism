import { join } from "node:path";
import { runtimeMcpServerRelativePath } from "./mcp-runtime.js";

export interface RuntimeMcpPathTarget {
  readonly root: string;
  readonly mcpRuntimeRoot?: string;
  readonly sourcePluginName: string;
}

export const runtimeMcpServerPath = (
  runtimeRoot: string,
  sourcePluginName: string,
): string => join(runtimeRoot, ...runtimeMcpServerRelativePath(sourcePluginName).split("/"));

export const runtimeMcpServerPathForTarget = (
  target: RuntimeMcpPathTarget,
): string => runtimeMcpServerPath(
  target.mcpRuntimeRoot ?? target.root,
  target.sourcePluginName,
);

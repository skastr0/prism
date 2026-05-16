import { relative } from "node:path";

export const normalizeGeneratedPluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

export const sanitizeGeneratedToolSegment = (
  value: string,
  fallback: string,
): string => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

export const generatedToolNamespace = (pluginName: string): string =>
  sanitizeGeneratedToolSegment(normalizeGeneratedPluginName(pluginName), "plugin");

export const sourceIsInside = (sourcePath: string, root: string): boolean => {
  const rel = relative(root, sourcePath);
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("/"));
};

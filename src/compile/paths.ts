import { relative } from "node:path";

export const normalizeRelativePath = (from: string, to: string): string => {
  const path = relative(from, to).replace(/\\/g, "/");
  return path.length > 0 ? path : ".";
};

import { fileURLToPath } from "node:url";

declare const AGENTPKG_EFFECT_ENTRYPOINT: string | undefined;

const bundledEffectEntrypoint = (): string | undefined => {
  if (typeof AGENTPKG_EFFECT_ENTRYPOINT === "string" && AGENTPKG_EFFECT_ENTRYPOINT.length > 0) {
    return AGENTPKG_EFFECT_ENTRYPOINT.replace(/\\/g, "/");
  }
  return undefined;
};

export const effectBundleImportPath = (): string => {
  try {
    return fileURLToPath(import.meta.resolve("effect")).replace(/\\/g, "/");
  } catch (error) {
    const fallback = bundledEffectEntrypoint();
    if (fallback) return fallback;
    throw error;
  }
};

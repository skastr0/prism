import { fileURLToPath } from "node:url";

declare const PRISM_EFFECT_ENTRYPOINT: string | undefined;
declare const PRISM_OPENCODE_PLUGIN_ENTRYPOINT: string | undefined;

const bundledEntrypoint = (value: string | undefined): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value.replace(/\\/g, "/");
  }
  return undefined;
};

const bundledEffectEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_EFFECT_ENTRYPOINT);

const bundledOpenCodePluginEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_OPENCODE_PLUGIN_ENTRYPOINT);

const resolveBundleImportPath = (
  specifier: string,
  fallbackImportPath: () => string | undefined,
): string => {
  try {
    return fileURLToPath(import.meta.resolve(specifier)).replace(/\\/g, "/");
  } catch (error) {
    const fallback = fallbackImportPath();
    if (fallback) return fallback;
    throw error;
  }
};

export const effectBundleImportPath = (): string =>
  resolveBundleImportPath("effect", bundledEffectEntrypoint);

export const opencodePluginBundleImportPath = (): string =>
  resolveBundleImportPath("@opencode-ai/plugin", bundledOpenCodePluginEntrypoint);

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

export const effectBundleImportPath = (): string => {
  try {
    return fileURLToPath(import.meta.resolve("effect")).replace(/\\/g, "/");
  } catch (error) {
    const fallback = bundledEffectEntrypoint();
    if (fallback) return fallback;
    throw error;
  }
};

export const opencodePluginBundleImportPath = (): string => {
  try {
    return fileURLToPath(import.meta.resolve("@opencode-ai/plugin")).replace(/\\/g, "/");
  } catch (error) {
    const fallback = bundledOpenCodePluginEntrypoint();
    if (fallback) return fallback;
    throw error;
  }
};

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOWERER_CAPABILITIES } from "./lowerer-capabilities.js";
import { parseWorkflowToml } from "./workflow-bun-runtime.js";
import { WorkflowBunRuntimeUnavailableError } from "./workflow-errors.js";

const kimiEffortCapability = LOWERER_CAPABILITIES["kimi-code"].workflowEffort;
const KIMI_EFFORT_VALUES = kimiEffortCapability?.kind === "fixed"
  ? kimiEffortCapability.values
  : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const kimiCodeHome = (home?: string): string =>
  home ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");

export type KimiModelEffortSupport =
  | { readonly declared: false }
  | { readonly declared: true; readonly efforts: readonly string[] }
  | { readonly error: string };

/** Read one model's optional support_efforts entry from Kimi's config TOML. */
export const parseKimiModelEffortSupport = (
  source: string,
  model: string,
  configPath = "config.toml",
): KimiModelEffortSupport => {
  let parsed: unknown;
  try {
    parsed = parseWorkflowToml(source, "Kimi Code effort config parsing");
  } catch (cause) {
    if (cause instanceof WorkflowBunRuntimeUnavailableError) throw cause;
    return {
      error: `Cannot validate Kimi Code effort because ${configPath} is not valid TOML. Fix: correct ${configPath} before setting worker.effort.`,
    };
  }

  const models = isRecord(parsed) && isRecord(parsed.models) ? parsed.models : undefined;
  const modelConfig = models !== undefined && isRecord(models[model]) ? models[model] : undefined;
  if (modelConfig === undefined || !Object.hasOwn(modelConfig, "support_efforts")) {
    return { declared: false };
  }

  const configuredEfforts = modelConfig.support_efforts;
  if (!Array.isArray(configuredEfforts) || configuredEfforts.some((value) => typeof value !== "string")) {
    return {
      error: `Kimi Code model ${JSON.stringify(model)} has an invalid support_efforts value in ${configPath}. Fix: set support_efforts to a TOML string array.`,
    };
  }
  const allowed = new Set(KIMI_EFFORT_VALUES);
  return {
    declared: true,
    efforts: [...new Set(configuredEfforts.filter((value): value is string => allowed.has(value)))],
  };
};

const readKimiModelEffortSupport = (
  model: string,
  home?: string,
): KimiModelEffortSupport | undefined => {
  const configPath = join(kimiCodeHome(home), "config.toml");
  if (!existsSync(configPath)) return undefined;
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    return {
      error: `Cannot read Kimi Code effort settings from ${configPath}. Fix: make ${configPath} readable before setting worker.effort.`,
    };
  }
  return parseKimiModelEffortSupport(source, model, configPath);
};

/** Validate Kimi's optional model-specific ladder after checking the fixed union. */
export const validateKimiWorkflowEffort = (input: {
  readonly model?: string;
  readonly effort?: string;
  readonly kimiHome?: string;
}): string | undefined => {
  const { model, effort, kimiHome } = input;
  if (model === undefined || effort === undefined) return undefined;
  const support = readKimiModelEffortSupport(model, kimiHome);
  if (support === undefined || ("declared" in support && !support.declared)) return undefined;
  if ("error" in support) return support.error;
  if (support.efforts.includes(effort)) return undefined;

  const fix = support.efforts.length > 0
    ? `set worker.effort to ${JSON.stringify(support.efforts[0])}`
    : "remove worker.effort or select a model that declares supported effort values";
  return [
    `Kimi Code model ${JSON.stringify(model)} does not list effort ${JSON.stringify(effort)}.`,
    `Supported for this model: ${support.efforts.length > 0 ? support.efforts.join(", ") : "none"}.`,
    `Fix: ${fix}.`,
  ].join(" ");
};

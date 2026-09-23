/**
 * Fail-soft discovery of installed workflow-harness models.
 * Cache reads and CLI lists never throw; empty means "leave this worker as string".
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type DiscoveredHarnessModels,
  type HarnessModelOption,
  type HarnessTypesSnapshot,
  writeHarnessTypesSnapshot,
  type RefreshHarnessTypesResult,
  harnessDiscoveredPath,
} from "./harness-types.js";
import type { WorkflowWorkerId } from "./workflows.js";
import { parseAmpProjectsList, type DiscoveredAmpProjects } from "./amp-projects.js";
import {
  AMP_RUNNERS_PROMPT,
  AMP_TURN_ERROR_PREFIX,
  parseAmpRunnersStreamJson,
  type DiscoveredAmpRunners,
} from "./amp-runners.js";

const execFileAsync = promisify(execFile);

export type HarnessTypesReadText = (path: string) => string | undefined;
export type HarnessTypesCommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface DiscoverHarnessTypesOptions {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readText?: HarnessTypesReadText;
  readonly runCommand?: HarnessTypesCommandRunner;
  /**
   * Also snapshot the account-wide Amp runners with a one-shot `amp -x` turn
   * whose only job is calling the `list_runners` platform tool. Opt-in: the
   * turn creates a small Amp thread (cheapest mode, deleted afterwards).
   * A plain refresh never runs it and preserves a previously captured
   * runner snapshot.
   */
  readonly discoverAmpRunners?: boolean;
}

const CLAUDE_MODEL_ALIASES = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
  "opus[1m]",
  "sonnet[1m]",
  "fable[1m]",
] as const;

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const MIDDOT_RE = /\u00B7/g;

const defaultReadText: HarnessTypesReadText = (path) => {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const defaultRunCommand: HarnessTypesCommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const out = typeof stdout === "string" ? stdout : "";
    if (out.trim()) return out;
    return typeof stderr === "string" ? stderr : "";
  } catch {
    return "";
  }
};

const empty = (harness: WorkflowWorkerId, error: string): DiscoveredHarnessModels => ({
  harness,
  models: [],
  source: "empty",
  error,
});

const result = (
  harness: WorkflowWorkerId,
  models: readonly HarnessModelOption[],
  source: DiscoveredHarnessModels["source"],
  error?: string,
): DiscoveredHarnessModels => ({
  harness,
  models,
  source,
  ...(error !== undefined ? { error } : {}),
});

export const parseClaudeModelCache = (
  raw: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const doc = JSON.parse(raw) as { additionalModelOptionsCache?: unknown };
    const cache = doc.additionalModelOptionsCache;
    const models: HarnessModelOption[] = [];
    const seenIds = new Set<string>();
    const seenLabels = new Set<string>();
    if (Array.isArray(cache)) {
      for (const entry of cache) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const id =
          typeof rec.value === "string" ? rec.value : typeof rec.id === "string" ? rec.id : undefined;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const label = typeof rec.label === "string" ? rec.label : id;
        seenLabels.add(label.toLowerCase());
        models.push({
          id,
          label,
        });
      }
    }
    for (const alias of CLAUDE_MODEL_ALIASES) {
      if (seenIds.has(alias) || seenLabels.has(alias.toLowerCase())) continue;
      seenIds.add(alias);
      models.push({ id: alias, label: alias });
    }
    return { models };
  } catch (err) {
    return {
      models: CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id })),
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const readClaudeModels = (
  home: string,
  readText: HarnessTypesReadText,
): DiscoveredHarnessModels => {
  const raw = readText(join(home, ".claude.json"));
  if (raw === undefined) {
    return result(
      "claude-code",
      CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id })),
      "aliases",
      "missing ~/.claude.json",
    );
  }
  const parsed = parseClaudeModelCache(raw);
  const fromCache = parsed.models.some(
    (model) => !(CLAUDE_MODEL_ALIASES as readonly string[]).includes(model.id),
  );
  return result("claude-code", parsed.models, fromCache ? "cache" : "aliases", parsed.error);
};

export const parseCodexDebugModels = (
  stdout: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  const trimmed = stdout.trim();
  if (!trimmed) return { models: [], error: "empty codex debug models output" };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(doc)
        ? doc
        : doc && typeof doc === "object" && Array.isArray((doc as { models?: unknown }).models)
          ? (doc as { models: unknown[] }).models
          : null;
      if (!rows) return { models: [], error: "unrecognized codex models json" };
      const models: HarnessModelOption[] = [];
      for (const row of rows) {
        if (typeof row === "string") {
          models.push({ id: row });
          continue;
        }
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const id =
          typeof rec.id === "string"
            ? rec.id
            : typeof rec.slug === "string"
              ? rec.slug
              : typeof rec.name === "string"
                ? rec.name
                : undefined;
        if (!id) continue;
        const effortValues = rec.efforts ?? rec.reasoning_efforts ?? rec.effort;
        const efforts = Array.isArray(effortValues)
          ? effortValues.filter((value): value is string => typeof value === "string")
          : typeof effortValues === "string" ? [effortValues] : [];
        const supportedLevels = Array.isArray(rec.supported_reasoning_levels)
          ? rec.supported_reasoning_levels.flatMap((level) => {
            if (!level || typeof level !== "object") return [];
            const effort = (level as Record<string, unknown>).effort;
            return typeof effort === "string" ? [effort] : [];
          })
          : [];
        const allEfforts = [...new Set([...efforts, ...supportedLevels])];
        models.push({ id, ...(allEfforts.length > 0 ? { efforts: allEfforts } : {}) });
      }
      return { models };
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  const models: HarnessModelOption[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^model\b/i.test(t)) continue;
    const parts = t.split(/\s+/);
    const id = parts[0];
    if (!id) continue;
    const efforts = parts.slice(1).filter((part) => part.length > 0);
    models.push({ id, ...(efforts.length > 0 ? { efforts } : {}) });
  }
  return { models };
};

export const parseGrokModelsCache = (
  raw: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const doc = JSON.parse(raw) as { models?: Record<string, { info?: Record<string, unknown> } | unknown> };
    if (!doc.models || typeof doc.models !== "object") {
      return { models: [], error: "models_cache.json missing models map" };
    }
    const models: HarnessModelOption[] = [];
    for (const [id, entry] of Object.entries(doc.models)) {
      if (!id) continue;
      const info =
        entry && typeof entry === "object" && "info" in entry
          ? (entry as { info?: Record<string, unknown> }).info
          : undefined;
      const reasoningEfforts = info?.reasoning_efforts;
      const efforts = Array.isArray(reasoningEfforts)
        ? reasoningEfforts.flatMap((effort) => {
          if (typeof effort === "string") return [effort];
          if (!effort || typeof effort !== "object") return [];
          const value = (effort as Record<string, unknown>).value;
          return typeof value === "string" ? [value] : [];
        })
        : [];
      models.push({
        id,
        label:
          info && typeof info.name === "string"
            ? info.name
            : info && typeof info.model === "string"
              ? info.model
              : id,
        ...(efforts.length > 0 ? { efforts: [...new Set(efforts)] } : {}),
      });
    }
    models.sort((left, right) => left.id.localeCompare(right.id));
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

export const parseGrokModelsCli = (stdout: string): HarnessModelOption[] => {
  const defaultMatch = stdout.match(/Default model:\s*([^\s]+)/);
  const listed = stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:\*|-)\s+([^\s(]+)/)?.[1] ?? "")
    .filter((id) => id.length > 0);
  const slugs = [...new Set([...listed, defaultMatch?.[1] ?? ""].filter((id) => id.length > 0))];
  return slugs.map((id) => ({ id }));
};

export const parseHermesProviderModelsCache = (
  raw: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { models: [], error: "provider_models_cache.json is not an object" };
    }
    const seen = new Set<string>();
    const models: HarnessModelOption[] = [];
    for (const [provider, entry] of Object.entries(doc as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const modelsRaw = (entry as { models?: unknown }).models;
      if (!Array.isArray(modelsRaw)) continue;
      for (const row of modelsRaw) {
        let id: string | undefined;
        if (typeof row === "string") id = row.trim();
        else if (row && typeof row === "object") {
          const rec = row as Record<string, unknown>;
          id =
            typeof rec.id === "string"
              ? rec.id
              : typeof rec.name === "string"
                ? rec.name
                : typeof rec.model === "string"
                  ? rec.model
                  : undefined;
        }
        if (!id || seen.has(id)) continue;
        if (/^https?:\/\//i.test(id) || /\b404\b/.test(id) || id.includes("\n")) continue;
        seen.add(id);
        models.push({ id, provider });
      }
    }
    models.sort((left, right) => left.id.localeCompare(right.id));
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

export const parseOpenCodeModels = (stdout: string): HarnessModelOption[] =>
  [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))].map(
    (id) => ({ id }),
  );

export const parseCursorModelsList = (
  stdout: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const models: HarnessModelOption[] = [];
    const seen = new Set<string>();
    for (const rawLine of stdout.split("\n")) {
      const trimmed = rawLine.replace(ANSI_ESCAPE_RE, "").replace(MIDDOT_RE, ",").replace(/\r$/, "").trim();
      if (!trimmed || /^available models$/i.test(trimmed)) continue;
      const sep = trimmed.indexOf(" - ");
      if (sep < 0) continue;
      const id = trimmed.slice(0, sep).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: trimmed.slice(sep + 3).trim() || id });
    }
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

export const parseAgyModelsList = (
  stdout: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const models: HarnessModelOption[] = [];
    const seen = new Set<string>();
    for (const rawLine of stdout.split("\n")) {
      const trimmed = rawLine.replace(ANSI_ESCAPE_RE, "").replace(MIDDOT_RE, ",").replace(/\r$/, "").trim();
      if (!trimmed || /^fetching\b/i.test(trimmed)) continue;
      const tabIndex = trimmed.indexOf("\t");
      const id = tabIndex >= 0 ? trimmed.slice(0, tabIndex).trim() : trimmed;
      if (!id || seen.has(id) || /\s{2,}/.test(id) && tabIndex < 0 && /^(provider|model)\b/i.test(id)) continue;
      if (tabIndex < 0 && /^\s/.test(rawLine.replace(ANSI_ESCAPE_RE, ""))) continue;
      seen.add(id);
      models.push({
        id,
        label: tabIndex >= 0 ? trimmed.slice(tabIndex + 1).trim() || id : id,
      });
    }
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

export const parseDevinModelsList = (
  stdout: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  const models: HarnessModelOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, "").replace(/\r$/, "");
    if (!/^\s{2}/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("aliases:")) continue;
    const parts = trimmed.split(/\s{2,}|\t/);
    const id = parts[0];
    if (!id) continue;
    models.push({ id, label: parts.slice(1).join(" ").replace(/\[.*\]$/, "").trim() || id });
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return { models };
};

const OMP_THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto)$/u;

/** Canonical OMP `--model` pin is `selector` (`provider/id`). */
export const parseOmpModelsJson = (
  raw: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const doc = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(doc.models)) {
      return { models: [], error: "omp models --json missing models array" };
    }
    const models: HarnessModelOption[] = [];
    const seen = new Set<string>();
    for (const row of doc.models) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const selector = typeof rec.selector === "string" && rec.selector.length > 0
        ? rec.selector
        : typeof rec.provider === "string" && typeof rec.id === "string"
          ? `${rec.provider}/${rec.id}`
          : typeof rec.id === "string"
            ? rec.id
            : undefined;
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      models.push({
        id: selector,
        ...(typeof rec.name === "string" ? { label: rec.name } : {}),
        ...(typeof rec.provider === "string" ? { provider: rec.provider } : {}),
      });
    }
    models.sort((left, right) => left.id.localeCompare(right.id));
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

/** `modelRoles.default` from ~/.omp/agent/config.yml, without a trailing :thinking suffix. */
export const parseOmpConfigDefaultModel = (raw: string): string | undefined => {
  const match = /(?:^|\n)modelRoles:\s*\n(?:[ \t]+[^\n]+\n)*?[ \t]+default:\s*([^\s#]+)/u.exec(raw);
  const value = match?.[1]?.trim();
  if (value === undefined || value.length === 0) return undefined;
  return value.replace(OMP_THINKING_SUFFIX, "");
};

export const readOmpConfigDefaultModel = (
  home: string,
  readText: HarnessTypesReadText = defaultReadText,
): string | undefined => {
  const raw = readText(join(home, ".omp", "agent", "config.yml"));
  if (raw === undefined) return undefined;
  return parseOmpConfigDefaultModel(raw);
};

export const parseKimiProviderList = (stdout: string): HarnessModelOption[] => {
  const defaultMatch = stdout.match(/Default model:\s*([^\s]+)/);
  const slug = defaultMatch?.[1];
  if (!slug) return [];
  return [{ id: slug }];
};

const AMP_DIAL_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

/** Built-in `--mode` dial from `amp --help` (`low, medium, high, ultra, or a plugin mode…`). */
export const parseAmpModeHelp = (stdout: string): HarnessModelOption[] => {
  const match = stdout.match(/agent mode \(([^)]+)\)/i);
  if (!match?.[1]) return [];
  const head = match[1].split(/\s+or\s+/i)[0] ?? "";
  const ids = [
    ...new Set(
      head
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^[A-Za-z][A-Za-z0-9-]*$/.test(part)),
    ),
  ];
  return ids.map((id) => ({
    id,
    kind: "dial",
    label: AMP_DIAL_LABELS[id] ?? id,
  }));
};

/** Plugin-registered `--mode` keys from `amp plugins list` (`agent mode: grok45`). */
export const parseAmpPluginListModes = (stdout: string): HarnessModelOption[] => {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/agent mode:\s+(\S+)/i);
    if (match?.[1]) ids.push(match[1]);
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).map((id) => ({
    id,
    kind: "plugin-mode",
  }));
};

/** Curated `provider/model` catalog from `amp plugins show-agent-options --json`. */
export const parseAmpAgentOptions = (
  raw: string,
): { readonly models: HarnessModelOption[]; readonly error?: string } => {
  try {
    const doc = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(doc.models)) {
      return { models: [], error: "show-agent-options missing models array" };
    }
    const models: HarnessModelOption[] = [];
    const seen = new Set<string>();
    for (const row of doc.models) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const capabilities =
        rec.capabilities && typeof rec.capabilities === "object"
          ? (rec.capabilities as Record<string, unknown>)
          : undefined;
      const effortsRaw = capabilities?.efforts;
      const efforts = Array.isArray(effortsRaw)
        ? effortsRaw.filter((value): value is string => typeof value === "string")
        : undefined;
      models.push({
        id,
        kind: "model",
        label:
          typeof rec.displayName === "string"
            ? rec.displayName
            : typeof rec.name === "string"
              ? rec.name
              : id,
        ...(typeof rec.provider === "string" ? { provider: rec.provider } : {}),
        ...(efforts !== undefined && efforts.length > 0 ? { efforts } : {}),
      });
    }
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
};

const mergeAmpInventory = (entries: readonly HarnessModelOption[]): HarnessModelOption[] => {
  const seen = new Set<string>();
  const models: HarnessModelOption[] = [];
  for (const model of entries) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
};

const discoverAmpModes = async (run: HarnessTypesCommandRunner): Promise<DiscoveredHarnessModels> => {
  const [help, plugins, optionsJson] = await Promise.all([
    run("amp", ["--help"]),
    run("amp", ["plugins", "list"]),
    run("amp", ["plugins", "show-agent-options", "--json"]),
  ]);
  const curated = parseAmpAgentOptions(optionsJson);
  const models = mergeAmpInventory([
    ...parseAmpModeHelp(help),
    ...parseAmpPluginListModes(plugins),
    ...curated.models,
  ]);
  if (models.length === 0) {
    return empty(
      "amp-code",
      curated.error ?? "amp --help / plugins list / show-agent-options produced no modes or models",
    );
  }
  return result("amp-code", models, "command", curated.error);
};

const fromCommand = async (
  harness: WorkflowWorkerId,
  run: HarnessTypesCommandRunner,
  command: string,
  args: readonly string[],
  parse: (stdout: string) => { readonly models: HarnessModelOption[]; readonly error?: string } | HarnessModelOption[],
): Promise<DiscoveredHarnessModels> => {
  const stdout = await run(command, args);
  if (!stdout.trim()) return empty(harness, `${command} ${args.join(" ")} produced no output`);
  const parsed = parse(stdout);
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  const error = Array.isArray(parsed) ? undefined : parsed.error;
  return result(harness, models, models.length > 0 ? "command" : "empty", error);
};

export const discoverWorkflowHarnessModels = async (
  options: DiscoverHarnessTypesOptions = {},
): Promise<readonly DiscoveredHarnessModels[]> => {
  const home = options.home ?? homedir();
  const readText = options.readText ?? defaultReadText;
  const run = options.runCommand ?? defaultRunCommand;

  const grokCache = (): DiscoveredHarnessModels => {
    const raw = readText(join(home, ".grok", "models_cache.json"));
    if (raw === undefined) return empty("grok", "missing ~/.grok/models_cache.json");
    const parsed = parseGrokModelsCache(raw);
    return result("grok", parsed.models, parsed.models.length > 0 ? "cache" : "empty", parsed.error);
  };

  const hermesCache = (): DiscoveredHarnessModels => {
    const raw = readText(join(home, ".hermes", "provider_models_cache.json"));
    if (raw === undefined) return empty("hermes", "missing ~/.hermes/provider_models_cache.json");
    const parsed = parseHermesProviderModelsCache(raw);
    return result("hermes", parsed.models, parsed.models.length > 0 ? "cache" : "empty", parsed.error);
  };

  const [
    amp,
    claude,
    codex,
    grokCli,
    hermes,
    grokFromCache,
    opencode,
    cursor,
    antigravity,
    devin,
    kimi,
    omp,
  ] = await Promise.all([
    discoverAmpModes(run),
    Promise.resolve(readClaudeModels(home, readText)),
    fromCommand("codex-cli", run, "codex", ["debug", "models"], parseCodexDebugModels),
    fromCommand("grok", run, "grok", ["models"], (stdout) => parseGrokModelsCli(stdout)),
    Promise.resolve(hermesCache()),
    Promise.resolve(grokCache()),
    fromCommand("opencode", run, "opencode", ["models"], (stdout) => parseOpenCodeModels(stdout)),
    fromCommand("cursor", run, "agent", ["models"], parseCursorModelsList),
    fromCommand("antigravity-cli", run, "agy", ["models"], parseAgyModelsList),
    fromCommand("devin", run, "devin", ["models", "list"], parseDevinModelsList),
    fromCommand("kimi-code", run, "kimi", ["provider", "list"], parseKimiProviderList),
    fromCommand("omp", run, "omp", ["models", "--json"], parseOmpModelsJson),
  ]);

  const grok = grokFromCache.models.length > 0 ? grokFromCache : grokCli;

  return [
    amp,
    claude,
    codex,
    grok,
    hermes,
    opencode,
    cursor,
    antigravity,
    devin,
    kimi,
    omp,
  ];
};

/** Amp orb projects from `amp projects list --json`. Fail-soft like model discovery. */
export const discoverAmpProjects = async (
  options: DiscoverHarnessTypesOptions = {},
): Promise<DiscoveredAmpProjects> => {
  const run = options.runCommand ?? defaultRunCommand;
  const stdout = await run("amp", ["projects", "list", "--json"]);
  if (!stdout.trim()) return { projects: [], source: "empty", error: "amp projects list --json produced no output" };
  const parsed = parseAmpProjectsList(stdout);
  return {
    projects: parsed.projects,
    source: parsed.projects.length > 0 ? "command" : "empty",
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  };
};

/**
 * Runner discovery turns can take a couple of minutes (an agent turn, not a
 * CLI list), so they get their own runner with a longer timeout than the
 * 8s `defaultRunCommand`. On failure the reason is surfaced through the
 * `AMP_TURN_ERROR:` sentinel instead of being swallowed.
 */
const defaultAmpTurnRunner: HarnessTypesCommandRunner = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return typeof stdout === "string" ? stdout : "";
  } catch (error) {
    const cause = error as { message?: string; stderr?: string };
    const detail = [cause.message ?? "", typeof cause.stderr === "string" ? cause.stderr.trim() : ""]
      .filter((part) => part.length > 0).join(" — ");
    return `${AMP_TURN_ERROR_PREFIX} ${detail.slice(0, 500)}`;
  }
};

/**
 * Snapshot the account-wide Amp runners: one `amp -x --stream-json` turn in
 * the cheapest mode whose only job is calling `list_runners`, parsed from the
 * tool result. Fail-soft: a failed capture records the reason and no runners,
 * but still deletes any thread the turn created (its partial stdout carries
 * the session id even when the turn times out). The reason is also returned
 * so the caller can surface it when the capture was explicitly requested.
 */
export const discoverAmpRunners = async (
  options: DiscoverHarnessTypesOptions = {},
): Promise<{ readonly discovered: DiscoveredAmpRunners; readonly failedExplicit?: string }> => {
  const run = options.runCommand ?? defaultAmpTurnRunner;
  const stdout = await run("amp", ["-x", AMP_RUNNERS_PROMPT, "--stream-json", "--mode", "low"]);
  const parsed = parseAmpRunnersStreamJson(stdout);
  if (parsed.sessionId !== undefined) {
    await run("amp", ["threads", "delete", parsed.sessionId]);
  } else {
    // A failed turn still created its thread (session_id arrives in the init
    // line before any failure); recover it from the partial stdout.
    const leaked = [...stdout.matchAll(/"session_id":"(T-[^"]+)"/g)].map((match) => match[1]!);
    for (const id of [...new Set(leaked)]) {
      await run("amp", ["threads", "delete", id]);
    }
  }
  const discovered: DiscoveredAmpRunners = {
    runners: parsed.runners,
    source: parsed.runners.length > 0 ? "command" : "empty",
    capturedAt: new Date().toISOString(),
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  };
  return { discovered, ...(parsed.error !== undefined ? { failedExplicit: parsed.error } : {}) };
};

/** Previously captured runner snapshot, preserved by a plain refresh. */
export const previousAmpRunners = (prismHome: string): DiscoveredAmpRunners | undefined => {
  try {
    const path = harnessDiscoveredPath(prismHome);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HarnessTypesSnapshot;
    return parsed && typeof parsed === "object" ? parsed.ampRunners : undefined;
  } catch {
    return undefined;
  }
};

export const refreshHarnessTypes = async (
  prismHome: string,
  options: DiscoverHarnessTypesOptions = {},
): Promise<RefreshHarnessTypesResult> => {
  const [harnesses, ampProjects] = await Promise.all([
    discoverWorkflowHarnessModels(options),
    discoverAmpProjects(options),
  ]);
  const previous = previousAmpRunners(prismHome);
  let ampRunners: DiscoveredAmpRunners | undefined = previous;
  let ampRunnersCaptureError: string | undefined;
  if (options.discoverAmpRunners === true) {
    const { discovered, failedExplicit } = await discoverAmpRunners(options);
    // A failed capture keeps the previously captured runners (an old entry is
    // valid); a legitimate empty capture (no live runners) replaces them.
    ampRunners = failedExplicit !== undefined && (previous?.runners.length ?? 0) > 0 ? previous : discovered;
    // An explicit capture failure is never silent: the operator asked for it.
    if (failedExplicit !== undefined) {
      const kept = ampRunners?.runners.length ?? 0;
      ampRunnersCaptureError = [
        `The Amp runner capture failed: ${failedExplicit}`,
        kept > 0 && ampRunners?.capturedAt !== undefined
          ? `The previous runner snapshot from ${ampRunners.capturedAt} (${kept} runner${kept === 1 ? "" : "s"}) was kept.`
          : "No previous runner snapshot was kept.",
        "Check `amp login` / network access and re-run the same command.",
      ].join(" ");
    }
  }
  const snapshot: HarnessTypesSnapshot = {
    generatedAt: new Date().toISOString(),
    harnesses,
    ampProjects,
    ...(ampRunners !== undefined ? { ampRunners } : {}),
  };
  const written = writeHarnessTypesSnapshot(prismHome, snapshot);
  return { ...written, ...(ampRunnersCaptureError !== undefined ? { ampRunnersCaptureError } : {}) };
};

export const renderHarnessTypesRefreshHuman = (result: RefreshHarnessTypesResult): string => {
  const lines = [
    `Wrote ${result.modelsPath}`,
    `Snapshot ${result.discoveredPath}`,
    "",
  ];
  for (const entry of result.snapshot.harnesses) {
    const count = entry.models.length;
    const note = entry.error !== undefined && count === 0 ? ` — ${entry.error}` : "";
    lines.push(`  ${entry.harness}: ${String(count)} model${count === 1 ? "" : "s"} (${entry.source})${note}`);
  }
  const projects = result.snapshot.ampProjects;
  if (projects !== undefined) {
    const count = projects.projects.length;
    const note = projects.error !== undefined && count === 0 ? ` — ${projects.error}` : "";
    lines.push(`  amp-orb: ${String(count)} project${count === 1 ? "" : "s"} (${projects.source})${note}`);
  }
  const runners = result.snapshot.ampRunners;
  if (runners !== undefined) {
    const count = runners.runners.length;
    const dirs = runners.runners.reduce((sum, runner) => sum + runner.directories.length, 0);
    const note = runners.error !== undefined && count === 0 ? ` — ${runners.error}` : "";
    lines.push(
      `  amp-runner: ${String(count)} runner${count === 1 ? "" : "s"}, ${String(dirs)} served dir${dirs === 1 ? "" : "s"} (${runners.source})${note}`,
    );
  }
  return lines.join("\n");
};

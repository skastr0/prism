/** Hermes Agent lowerer. */

import { join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { cliToolNameForBinding } from "../tool-runtime-bundle.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  pushDesiredFile,
  renderGeneratedOrbitSkill,
  type LowerOutput,
  bundleGeneratedHookWrapper,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  renderPrePostSessionHookWrapperEntry,
  yamlScalar,
} from "./shared.js";
import { Effect } from "effect";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { ResolvedContractBinding } from "../resolve.js";

const TARGET_ID = "hermes" as const;

export interface HermesLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: HermesLowerTarget;
}

const hermesSkillsRoot = (target: HermesLowerTarget): string =>
  join(target.root, "skills");

const configPath = (target: HermesLowerTarget): string =>
  join(target.root, "config.yaml");

const targetIncludesHermes = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsHermes = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesHermes(registry?.targets[artifact]);

const renderHermesOrbitSkillMarkdown = (
  orbit: Orbit,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    registry,
    trailingNewline: true,
  });

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsHermes(input.registry, "skills")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of sourceFiles) {
    pushDesiredFile(files, {
      targetPath: join(hermesSkillsRoot(input.target), file.relativePath),
      content: await readFile(file.sourcePath),
      plugin: input.target.sourcePluginName,
    });
  }
};

const hermesGeneratedRoot = (target: HermesLowerTarget): string =>
  join(target.root, "plugins", `prism-generated-${normalizeBundleSegment(target.sourcePluginName)}`);

const hermesNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "pre_tool_call";
    case "tool.after":
      return "post_tool_call";
    case "prompt.submit":
      return "pre_llm_call";
    case "session.start":
      return "on_session_start";
    case "session.end":
      return "on_session_end";
    case "subagent.stop":
      return "subagent_stop";
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
};

const collectCanonicalToolNames = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> =>
  collectBindingNameMap(bindings, (binding) => {
    const owner = ownerPluginForBinding(sourcePluginName, binding);
    return cliToolNameForBinding(owner, binding);
  });

const hookMatcher = (
  nativeEvent: string,
  resolved: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  if (nativeEvent !== "pre_tool_call" && nativeEvent !== "post_tool_call") {
    return undefined;
  }
  return matcherForResolvedToolHook(resolved, canonicalToolNames);
};

const renderHermesHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
  hookSourcePath: string,
): string => {
  return renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    nativeToolInputExpression: "input?.tool_input",
    resultHandlingSource: `const writeHookJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const output = {};
if (result.decision === "block") {
  output.decision = "block";
  output.reason = result.message || "";
} else if (${JSON.stringify(hook.event)} === "prompt.submit") {
  const ctx = result.additionalContext || result.systemMessage;
  if (ctx) {
    output.context = ctx;
  }
}
if (Object.keys(output).length > 0) writeHookJson(output);`,
  });
};

const bundleHermesHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-hermes-hook-",
    buildLabel: `Hermes '${hook.name}'`,
    renderEntry: (currentHook, hookRuntimePath, hookSourcePath) =>
      renderHermesHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath, hookSourcePath),
  });
};

interface HermesHookEntry {
  readonly command: string;
  readonly matcher?: string;
  readonly timeout?: number;
}

// One hermes native event maps to a single `<event>:` key holding a LIST of
// hook entries. Multiple Prism hooks that lower to the same native event
// (e.g. two tool.before hooks) MUST share one key — separate `<event>:` keys
// under `hooks:` would be duplicate YAML mapping keys.
const renderHermesHookYaml = (options: {
  readonly nativeEvent: string;
  readonly entries: ReadonlyArray<HermesHookEntry>;
}): string[] => {
  const lines = [`  ${options.nativeEvent}:`];
  for (const entry of options.entries) {
    lines.push(`    - command: ${yamlScalar(entry.command)}`);
    if (entry.matcher) {
      lines.push(`      matcher: ${yamlScalar(entry.matcher)}`);
    }
    if (entry.timeout !== undefined) {
      lines.push(`      timeout: ${entry.timeout}`);
    }
  }
  return lines;
};

const assertHermesLoweringInput = (input: LowerInput): void => {
  if (input.agents.length > 0) {
    throw new Error(
      "Hermes lowerer received agents after target capability validation; this indicates a compiler planning bug.",
    );
  }
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const files: DesiredFile[] = [];
  const regions: DesiredRegion[] = [];
  const plugin = input.target.sourcePluginName;

  assertHermesLoweringInput(input);

  await copyTargetedSkillArtifacts(input, files);

  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: join(hermesSkillsRoot(input.target), `${orbit.name}/SKILL.md`),
      content: renderHermesOrbitSkillMarkdown(orbit, input.registry),
      plugin,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(
          hermesSkillsRoot(input.target),
          `${orbit.name}/references/${reference.filename}`,
        ),
        content: reference.content,
        plugin,
      });
    }
  }

  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (hooks.length > 0 && input.registry) {
    const bindings = mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools,
      input.agents,
    );
    const canonicalToolNames = collectCanonicalToolNames(
      input.target.sourcePluginName,
      bindings,
    );

    // Group hooks by native event: one `<event>:` key holds every hook that
    // lowers to it. Wrapper files stay per-hook (distinct handlers); only the
    // config-region key is shared, in stable hook-name order for determinism.
    const entriesByEvent = new Map<string, HermesHookEntry[]>();
    for (const hook of [...hooks].sort((a, b) => a.name.localeCompare(b.name))) {
      const nativeEvent = hermesNativeHookEvent(hook.event);
      const resolved = await Effect.runPromise(
        resolveHookMatchForTarget(hook, input.registry, "hermes"),
      );
      const matcher = hookMatcher(nativeEvent, resolved, canonicalToolNames);
      const wrapperContent = await bundleHermesHookWrapper(hook, nativeEvent);

      const relativePath = join("hooks", `${normalizeBundleSegment(hook.name, "hook")}.mjs`);
      const wrapperAbsPath = join(hermesGeneratedRoot(input.target), relativePath);

      pushDesiredFile(files, {
        targetPath: wrapperAbsPath,
        content: wrapperContent,
        plugin,
        mode: 0o755,
      });

      const entry: HermesHookEntry = { command: `node ${wrapperAbsPath}`, timeout: 60 };
      const withMatcher = matcher ? { ...entry, matcher } : entry;
      const list = entriesByEvent.get(nativeEvent);
      if (list) list.push(withMatcher);
      else entriesByEvent.set(nativeEvent, [withMatcher]);
    }

    for (const [nativeEvent, entries] of [...entriesByEvent].sort(([a], [b]) => a.localeCompare(b))) {
      regions.push({
        kind: "marker",
        targetPath: configPath(input.target),
        regionKey: `hermes.hooks.${nativeEvent}`,
        commentPrefix: "#",
        anchor: "hooks:",
        content: renderHermesHookYaml({ nativeEvent, entries }).join("\n"),
        plugin,
      });
    }
  }

  return { files, regions };
};

/**
 * OpenCode lowerer.
 *
 * Takes a set of ComposedAgents + lifecycles and produces:
 *
 *   1. Per-agent markdown at <opencode-root>/agents/<name>.md with
 *      {name, description, tools?} frontmatter and the composed body.
 *      When the agent has contract-bound tools, the frontmatter's `tools`
 *      block enables only those synthetic tools and denies every other
 *      agent's synthetic tools.
 *
 *   2. Idempotent patches to <opencode-root>/opencode.json:
 *        - agent.<name> block (compiler-owned keys only; hand-authored keys preserved)
 *        - plugin array entry for the source-plugin-owned generated plugin
 *          (for example `agentpkg-generated-review-core`) when any agent has
 *          tool bindings
 *
 *   3. Per-lifecycle skills at <opencode-root>/skills/<name>/SKILL.md.
 *      Lifecycles remain source-language constructs; the generated skill is
 *      the runtime-facing lowering that OpenCode actually loads.
 *
 *   4. A generated OpenCode plugin directory at
 *      <opencode-root>/plugins/agentpkg-generated-<source-plugin>/ containing:
 *        - package.json
 *        - src/server.ts
 *        - src/runtime/schema-bridge.ts
 *        - src/adapters/<source-plugin>/<name>.adapter.ts
 *        - src/plugins/<source-plugin>/{contracts,schemas}/...
 *
 * The generated plugin tree is compiler-owned except for runtime-managed
 * entries like node_modules/ and lockfiles, which are preserved across syncs.
 */

import { dirname, join } from "node:path";
import {
  composeLifecyclePhaseReference,
  type ComposedAgent,
} from "../compose.js";
import type { Contract, Lifecycle } from "../sources.js";
import type { HarnessScope } from "../../types.js";
import {
  backupFile,
  readFile,
  writeFile,
  listDirRecursive,
  removeDir,
  removeFile,
} from "../../fs.js";

// Keys at agent.<name>.* that the compiler owns. Other keys on an existing
// block are preserved verbatim during patching.
const COMPILER_OWNED_KEYS = [
  "model",
  "variant",
  "mode",
  "color",
  "permission",
  "temperature",
  "top_p",
  "maxSteps",
  "disable",
] as const;

const GENERATED_PLUGIN_PREFIX = "agentpkg-generated";

export interface OpenCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  /** Root plugin.json name for the compile invocation that owns this output. */
  readonly sourcePluginName: string;
}

const agentMdPath = (target: OpenCodeLowerTarget, name: string): string =>
  join(target.root, "agents", `${name}.md`);

const lifecycleSkillMdPath = (
  target: OpenCodeLowerTarget,
  name: string
): string => join(target.root, "skills", name, "SKILL.md");

const lifecycleSkillRelativePath = (name: string): string =>
  `skills/${name}/SKILL.md`;

const opencodeJsonPath = (target: OpenCodeLowerTarget): string =>
  join(target.root, "opencode.json");

const normalizeGeneratedPluginSourcePluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

const sanitizeSyntheticToolSegment = (
  value: string,
  fallback: string
): string => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const syntheticToolNamespace = (sourcePluginName: string): string =>
  sanitizeSyntheticToolSegment(
    normalizeGeneratedPluginSourcePluginName(sourcePluginName),
    "plugin"
  );

const syntheticToolName = (
  sourcePluginName: string,
  agentName: string,
  logicalName: string
): string =>
  `${syntheticToolNamespace(sourcePluginName)}_${sanitizeSyntheticToolSegment(agentName, "agent")}_${sanitizeSyntheticToolSegment(logicalName, "tool")}`;

const generatedPluginId = (target: OpenCodeLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeGeneratedPluginSourcePluginName(target.sourcePluginName)}`;

const generatedPluginRoot = (target: OpenCodeLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

// ---------------------------------------------------------------------------
// Operation shape
// ---------------------------------------------------------------------------

export type LowerOperation =
  | {
      readonly kind: "write-md";
      readonly target: string;
      readonly content: string;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "patch-json";
      readonly target: string;
      readonly agentName: string;
      readonly nextBlock: Record<string, unknown>;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "write-plugin-file";
      readonly target: string;
      readonly content: string;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "patch-opencode-plugins";
      readonly target: string;
      readonly pluginId: string;
      readonly desiredPresent: boolean;
      readonly reason: "new" | "changed" | "unchanged";
    }
  | {
      readonly kind: "prune-plugin-path";
      readonly target: string;
      readonly targetType: "file" | "dir";
      readonly reason: "stale";
    };

// ---------------------------------------------------------------------------
// Agent markdown
// ---------------------------------------------------------------------------

interface SyntheticToolInventory {
  /** All synthetic tool names across every agent. Format: <plugin>_<agent>_<logical>. */
  readonly allToolNames: ReadonlyArray<string>;
  /** Tool names owned by each agent. */
  readonly byAgent: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Synthetic tool names are `<plugin-sanitized>_<agent-sanitized>_<logical-sanitized>`.
 *
 * The plugin namespace keeps independently generated OpenCode plugins from
 * colliding inside the harness-global tool registry. Agent and logical names
 * are sanitized the same way so generated frontmatter keys and server exports
 * stay aligned and JS-safe.
 */
const buildInventory = (
  sourcePluginName: string,
  agents: ReadonlyArray<ComposedAgent>
): SyntheticToolInventory => {
  const byAgent = new Map<string, string[]>();
  const all: string[] = [];
  for (const agent of agents) {
    const own: string[] = [];
    for (const binding of agent.toolBindings) {
      const toolName = syntheticToolName(
        sourcePluginName,
        agent.name,
        binding.logicalName
      );
      own.push(toolName);
      all.push(toolName);
    }
    byAgent.set(agent.name, own);
  }
  return { allToolNames: all, byAgent };
};

const serializeFrontmatter = (
  fm: Record<string, string>,
  tools: Record<string, boolean>
): string => {
  const keys = Object.keys(fm);
  const lines = ["---"];
  for (const key of keys) {
    const value = fm[key];
    if (value === undefined) continue;
    if (value.includes(":") || value.includes("#") || value.includes('"')) {
      const escaped = value.replace(/"/g, '\\"');
      lines.push(`${key}: "${escaped}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  const toolKeys = Object.keys(tools).sort();
  if (toolKeys.length > 0) {
    lines.push("tools:");
    for (const k of toolKeys) {
      lines.push(`  ${k}: ${tools[k] ? "true" : "false"}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

const renderAgentMarkdown = (
  agent: ComposedAgent,
  inventory: SyntheticToolInventory
): string => {
  const own = new Set([
    ...(inventory.byAgent.get(agent.name) ?? []),
    ...agent.allowedTools,
  ]);
  const tools: Record<string, boolean> = {};
  for (const tool of new Set([...inventory.allToolNames, ...agent.allowedTools])) {
    tools[tool] = own.has(tool);
  }
  const frontmatter = serializeFrontmatter(
    { name: agent.name, description: agent.description },
    tools
  );
  return `${frontmatter}\n\n${agent.body}\n`;
};

// ---------------------------------------------------------------------------
// opencode.json patching
// ---------------------------------------------------------------------------

const composeAgentBlock = (
  agent: ComposedAgent,
  existing: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};

  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!(COMPILER_OWNED_KEYS as readonly string[]).includes(key)) {
        next[key] = value;
      }
    }
  }

  if (agent.model) {
    for (const [key, value] of Object.entries(agent.model)) {
      if ((COMPILER_OWNED_KEYS as readonly string[]).includes(key)) {
        next[key] = value;
      }
    }
  }

  if (agent.color) {
    next.color = agent.color;
  }

  const override = agent.targetOverride.opencode as
    | Record<string, unknown>
    | undefined;
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      next[key] = value;
    }
  }

  return next;
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao).sort();
  const keysB = Object.keys(bo).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every((k) => deepEqual(ao[k], bo[k]));
};

const fileExists = async (path: string): Promise<boolean> => {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(path: string): Promise<T> => {
  return Bun.file(path).json() as Promise<T>;
};

// ---------------------------------------------------------------------------
// Lifecycle skill rendering
// ---------------------------------------------------------------------------

const lifecycleSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- agentpkg:lifecycle-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const isOwnedLifecycleSkill = (
  content: string,
  sourcePluginName: string
): boolean => content.includes(lifecycleSkillOwnerMarker(sourcePluginName));

const renderLifecycleSkill = (
  lifecycle: Lifecycle,
  sourcePluginName: string
): string => {
  const lines: string[] = [];
  lines.push(
    serializeFrontmatter(
      { name: lifecycle.name, description: lifecycle.description },
      {},
    ),
  );
  lines.push("");
  lines.push(lifecycleSkillOwnerMarker(sourcePluginName));
  lines.push("");
  lines.push(`# ${lifecycle.name}`);
  lines.push("");
  lines.push(lifecycle.description);
  lines.push("");
  lines.push(
    "_Runtime-facing lowering of a concrete lifecycle instance. Parameterized lifecycle templates remain source-only until another lifecycle binds them._",
  );
  lines.push("");

  if (lifecycle.produces) {
    lines.push("## Produces");
    lines.push("");
    lines.push(lifecycle.produces);
    lines.push("");
  }

  lines.push("## Phases");
  lines.push("");
  let i = 1;
  for (const phase of lifecycle.phases) {
    const reference = composeLifecyclePhaseReference(phase);
    lines.push(`### ${i}. ${phase.name} — ${reference.label}`);
    lines.push("");
    for (const detail of reference.detailLines) {
      lines.push(detail);
    }
    if (phase.notes) {
      for (const [name, value] of Object.entries(phase.notes)) {
        lines.push(`- **${name}**: ${value}`);
      }
    }
    lines.push("");
    i++;
  }

  if (lifecycle.taste_checkpoints.length > 0) {
    lines.push("## Taste Checkpoints");
    lines.push("");
    for (const cp of lifecycle.taste_checkpoints) {
      const parts: string[] = [];
      if (cp.after) parts.push(`after: ${cp.after}`);
      if (cp.before) parts.push(`before: ${cp.before}`);
      if (cp.note) parts.push(`note: ${cp.note}`);
      lines.push(`- ${parts.join(" — ")}`);
    }
    lines.push("");
  }

  if (lifecycle.evolution) {
    lines.push("## Evolution");
    lines.push("");
    lines.push(lifecycle.evolution.trim());
    lines.push("");
  }

  const body = lifecycle.body.trim();
  if (body.length > 0) {
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Generated plugin emission
//
// Layout:
//   agentpkg-generated-<source-plugin>/
//   ├── package.json
//   └── src/
//       ├── server.ts                          (imports adapters)
//       ├── runtime/schema-bridge.ts           (Effect Schema → tool.schema)
//       ├── adapters/<plugin>/<name>.adapter.ts
//       └── plugins/<plugin>/                  (mirrored source plugin tree)
//           ├── contracts/*.contract.ts
//           └── schemas/*.ts
// ---------------------------------------------------------------------------

/** Source-plugin subdirectories that get mirrored into src/plugins/<name>/. */
const MIRRORED_SUBDIRS = ["contracts", "schemas", "tools"] as const;

interface PluginMirror {
  readonly pluginName: string;
  readonly files: ReadonlyArray<{
    relativePath: string;
    sourcePath?: string;
    content?: string;
  }>;
}

interface AdapterSpec {
  readonly pluginName: string;
  readonly contractName: string;
  /**
   * Path to the contract file relative to the generated plugin's
   * src/plugins/<pluginName>/ mirror — i.e. always starts with "contracts/".
   */
  readonly contractRelativePath: string;
}

const RUNTIME_MANAGED_PLUGIN_DIRS = new Set(["node_modules"]);
const RUNTIME_MANAGED_PLUGIN_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

interface PluginTree {
  readonly files: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
}

const isRuntimeManagedPluginPath = (relativePath: string): boolean => {
  const [first] = relativePath.split("/");
  if (!first) return false;
  if (RUNTIME_MANAGED_PLUGIN_DIRS.has(first)) return true;
  return !relativePath.includes("/") && RUNTIME_MANAGED_PLUGIN_FILES.has(first);
};

const collectPluginTree = async (root: string): Promise<PluginTree> => {
  if (!(await fileExists(root))) {
    return { files: [], dirs: [] };
  }

  const fs = await import("node:fs/promises");
  const files: string[] = [];
  const dirs: string[] = [];

  const walk = async (dir: string, prefix = ""): Promise<void> => {
    let entries: Array<{ readonly name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isRuntimeManagedPluginPath(relativePath)) continue;

      if (entry.isDirectory()) {
        dirs.push(relativePath);
        await walk(join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  };

  await walk(root);
  return { files, dirs };
};

const collectDesiredPluginDirs = (
  desiredFiles: ReadonlySet<string>
): Set<string> => {
  const dirs = new Set<string>();
  for (const file of desiredFiles) {
    const segments = file.split("/");
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current = current ? `${current}/${segments[i]}` : segments[i]!;
      dirs.add(current);
    }
  }
  return dirs;
};

const relativePathDepth = (relativePath: string): number =>
  relativePath.split("/").length;

const planPluginPruning = async (
  root: string,
  desiredFiles: ReadonlySet<string>
): Promise<LowerOperation[]> => {
  const existing = await collectPluginTree(root);
  const desiredDirs = collectDesiredPluginDirs(desiredFiles);
  const operations: LowerOperation[] = [];

  for (const relativePath of existing.files) {
    if (desiredFiles.has(relativePath)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: join(root, relativePath),
      targetType: "file",
      reason: "stale",
    });
  }

  const staleDirs = [...existing.dirs]
    .filter((relativePath) => !desiredDirs.has(relativePath))
    .sort(
      (a, b) =>
        relativePathDepth(b) - relativePathDepth(a) || b.localeCompare(a)
    );

  for (const relativePath of staleDirs) {
    operations.push({
      kind: "prune-plugin-path",
      target: join(root, relativePath),
      targetType: "dir",
      reason: "stale",
    });
  }

  return operations;
};

const planLifecycleSkillPruning = async (
  target: OpenCodeLowerTarget,
  desiredSkillFiles: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const skillsRoot = join(target.root, "skills");
  if (!(await fileExists(skillsRoot))) {
    return operations;
  }

  const existingSkillFiles = await listDirRecursive(skillsRoot);
  for (const relativePath of existingSkillFiles) {
    const rootRelativePath = `skills/${relativePath}`;
    if (desiredSkillFiles.has(rootRelativePath)) continue;

    const absolutePath = join(skillsRoot, relativePath);
    const current = await readFile(absolutePath);
    if (!isOwnedLifecycleSkill(current, target.sourcePluginName)) continue;

    operations.push({
      kind: "prune-plugin-path",
      target: absolutePath,
      targetType: "file",
      reason: "stale",
    });

    const skillDir = dirname(absolutePath);
    const remainingFiles = await listDirRecursive(skillDir);
    if (remainingFiles.length === 1 && remainingFiles[0] === "SKILL.md") {
      operations.push({
        kind: "prune-plugin-path",
        target: skillDir,
        targetType: "dir",
        reason: "stale",
      });
    }
  }

  return operations;
};

const planPluginMirrors = async (
  bindings: ReadonlyArray<ComposedAgent["toolBindings"][number]>,
): Promise<PluginMirror[]> => {
  const byPlugin = new Map<string, { pluginRoot: string }>();
  const generatedFiles = new Map<string, Map<string, string>>();

  const contracts = bindings.map((binding) => binding.contract);
  for (const contract of contracts) {
    if (contract.generatedFiles && contract.generatedFiles.length > 0) {
      const pluginFiles = generatedFiles.get(contract.pluginName) ?? new Map<string, string>();
      for (const file of contract.generatedFiles) {
        const existing = pluginFiles.get(file.relativePath);
        if (!existing || existing === file.content) {
          pluginFiles.set(file.relativePath, file.content);
        }
      }
      generatedFiles.set(contract.pluginName, pluginFiles);
    }

    if (!byPlugin.has(contract.pluginName)) {
      const contractsDir = dirname(contract.sourcePath);
      const pluginRoot = dirname(contractsDir);
      byPlugin.set(contract.pluginName, { pluginRoot });
    }
  }

  for (const binding of bindings) {
    if (byPlugin.has(binding.canonicalToolPlugin)) continue;
    const toolsDir = dirname(binding.canonicalToolSourcePath);
    const pluginRoot = dirname(toolsDir);
    byPlugin.set(binding.canonicalToolPlugin, { pluginRoot });
  }

  const mirrors: PluginMirror[] = [];
  for (const [pluginName, { pluginRoot }] of byPlugin) {
    const files: Array<{ relativePath: string; sourcePath?: string; content?: string }> = [];
    for (const sub of MIRRORED_SUBDIRS) {
      const subRoot = join(pluginRoot, sub);
      const entries = await listDirRecursive(subRoot);
      for (const rel of entries) {
        if (!rel.endsWith(".ts")) continue;
        files.push({
          sourcePath: join(subRoot, rel),
          relativePath: `${sub}/${rel}`,
        });
      }
    }
    const generated = generatedFiles.get(pluginName);
    if (generated) {
      for (const [relativePath, content] of generated) {
        if (files.some((file) => file.relativePath === relativePath)) continue;
        files.push({ relativePath, content });
      }
    }
    mirrors.push({ pluginName, files });
  }

  for (const [pluginName, files] of generatedFiles) {
    if (mirrors.some((mirror) => mirror.pluginName === pluginName)) continue;
    mirrors.push({
      pluginName,
      files: [...files.entries()].map(([relativePath, content]) => ({
        relativePath,
        content,
      })),
    });
  }

  return mirrors;
};

const planAdapters = (
  agents: ReadonlyArray<ComposedAgent>,
): AdapterSpec[] => {
  const seen = new Set<string>();
  const specs: AdapterSpec[] = [];
  for (const agent of agents) {
    for (const binding of agent.toolBindings) {
      const key = `${binding.contract.pluginName}/${binding.contract.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({
        pluginName: binding.contract.pluginName,
        contractName: binding.contract.name,
        contractRelativePath: `contracts/${binding.contract.name}.contract`,
      });
    }
  }
  return specs;
};

const normalizeMirroredPluginSource = (
  relativePath: string,
  source: string,
): string => {
  if (!relativePath.endsWith(".tool.ts")) {
    return source;
  }

  return source
    .replace(/^\s*import\s+\{\s*defineTool\s*\}\s+from\s+["']agentpkg["'];\s*\n/m, "")
    .replace(/\bdefineTool\s*\(/g, "(");
};

const renderAdapter = (spec: AdapterSpec): string => {
  // adapter is at: src/adapters/<pluginName>/<contractName>.adapter.ts
  // contract is at: src/plugins/<pluginName>/contracts/<contractName>.contract.ts
  // bridge is at:   src/runtime/schema-bridge.ts
  const contractImport = `../../plugins/${spec.pluginName}/${spec.contractRelativePath}`;
  const bridgeImport = `../../runtime/schema-bridge`;
  const lines: string[] = [];
  lines.push(`// GENERATED by agentpkg — do not edit.`);
  lines.push(`// Adapter for contract '${spec.pluginName}:${spec.contractName}'.`);
  lines.push("");
  lines.push(`import { tool, type ToolContext } from "@opencode-ai/plugin";`);
  lines.push(`import * as contract from "${contractImport}";`);
  lines.push(
    `import { toolArgsFromSchema, decodeInput, type ToolRuntimeContext } from "${bridgeImport}";`,
  );
  lines.push("");
  lines.push(`type SyntheticToolExecuteContext = ToolContext & {`);
  lines.push(`  sessionTitle?: ToolRuntimeContext["sessionTitle"];`);
  lines.push(`  durationMs?: ToolRuntimeContext["durationMs"];`);
  lines.push(`  cost?: ToolRuntimeContext["cost"];`);
  lines.push(`  workingDirectory?: ToolRuntimeContext["workingDirectory"];`);
  lines.push(`  repoRoot?: ToolRuntimeContext["repoRoot"];`);
  lines.push(`};`);
  lines.push("");
  lines.push(`export default tool({`);
  lines.push(`  description: (contract as any).description ?? "",`);
  lines.push(`  args: toolArgsFromSchema((contract as any).Input),`);
  lines.push(`  async execute(rawArgs, context) {`);
  lines.push(
    `    const input = decodeInput((contract as any).Input, rawArgs);`,
  );
  lines.push(`    const toolContext = context as SyntheticToolExecuteContext;`);
  lines.push(`    const runtimeContext: ToolRuntimeContext = {`);
  lines.push(`      sessionID: context.sessionID,`);
  lines.push(`      agent: context.agent,`);
  lines.push(`      timestamp: new Date().toISOString(),`);
  lines.push(`      sessionTitle: toolContext.sessionTitle,`);
  lines.push(`      durationMs: toolContext.durationMs,`);
  lines.push(`      cost: toolContext.cost,`);
  lines.push(`      workingDirectory: toolContext.workingDirectory ?? context.directory,`);
  lines.push(`      repoRoot: toolContext.repoRoot ?? context.worktree,`);
  lines.push(`    };`);
  lines.push(`    const output = await contract.handle(input, runtimeContext);`);
  lines.push(`    return JSON.stringify(output, null, 2);`);
  lines.push(`  },`);
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
};

const renderGeneratedServerTs = (
  agents: ReadonlyArray<ComposedAgent>,
  sourcePluginName: string,
  pluginId: string,
  adapters: AdapterSpec[],
): string => {
  const importEntries = adapters.map((a, idx) => {
    const ident = `adapter_${idx}_${a.pluginName.replace(/[^a-zA-Z0-9_]/g, "_")}_${a.contractName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const importPath = `./adapters/${a.pluginName}/${a.contractName}.adapter`;
    return { ident, importPath, pluginName: a.pluginName, contractName: a.contractName };
  });

  const toolEntries: string[] = [];
  for (const agent of agents) {
    for (const binding of agent.toolBindings) {
      const toolName = syntheticToolName(
        sourcePluginName,
        agent.name,
        binding.logicalName
      );
      const entry = importEntries.find(
        (e) =>
          e.pluginName === binding.contract.pluginName &&
          e.contractName === binding.contract.name,
      );
      if (!entry) continue;
      toolEntries.push(`    ${JSON.stringify(toolName)}: ${entry.ident},`);
    }
  }

  const lines: string[] = [];
  lines.push("// GENERATED by agentpkg — do not edit.");
  lines.push("// Re-run `agentpkg compile` to regenerate.");
  lines.push("");
  lines.push(
    'import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";',
  );
  for (const e of importEntries) {
    lines.push(`import ${e.ident} from "${e.importPath}";`);
  }
  lines.push("");
  lines.push("const server: Plugin = async () => ({");
  lines.push("  tool: {");
  lines.push(...toolEntries);
  lines.push("  },");
  lines.push("} satisfies Hooks);");
  lines.push("");
  lines.push(
    `export default { id: "${pluginId}", server } satisfies PluginModule;`,
  );
  lines.push("");
  return lines.join("\n");
};

const GENERATED_PACKAGE_JSON = (pluginId: string): string =>
  JSON.stringify(
    {
      name: pluginId,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/server.ts",
      exports: {
        "./server": "./src/server.ts",
      },
      dependencies: {
        "@opencode-ai/plugin": "^1.4.6",
        effect: "^3.21.0",
      },
    },
    null,
    2,
  ) + "\n";

declare const SCHEMA_BRIDGE_SOURCE: string | undefined;

const getSchemaBridgeSource = async (): Promise<string> => {
  if (typeof SCHEMA_BRIDGE_SOURCE === "string") {
    return SCHEMA_BRIDGE_SOURCE;
  }

  const sourcePath = new URL("../runtime/schema-bridge.ts", import.meta.url).pathname;
  return readFile(sourcePath);
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly lifecycles: ReadonlyArray<Lifecycle>;
  readonly target: OpenCodeLowerTarget;
}

export const planLowering = async (
  input: LowerInput
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const inventory = buildInventory(input.target.sourcePluginName, input.agents);
  const hasAnyTool = inventory.allToolNames.length > 0;
  const desiredPluginFiles = new Set<string>();
  const desiredLifecycleSkillFiles = new Set<string>();
  const ownedGeneratedPluginId = generatedPluginId(input.target);

  // ---- Per-agent markdown
  for (const agent of input.agents) {
    const mdTarget = agentMdPath(input.target, agent.name);
    const desiredMd = renderAgentMarkdown(agent, inventory);
    let reason: "new" | "changed" | "unchanged";
    if (await fileExists(mdTarget)) {
      const current = await readFile(mdTarget);
      reason = current === desiredMd ? "unchanged" : "changed";
    } else {
      reason = "new";
    }
    operations.push({
      kind: "write-md",
      target: mdTarget,
      content: desiredMd,
      reason,
    });
  }

  // ---- opencode.json agent.<name> patches
  const jsonTarget = opencodeJsonPath(input.target);
  let config: Record<string, unknown> = {};
  if (await fileExists(jsonTarget)) {
    config = await readJson<Record<string, unknown>>(jsonTarget);
  }
  const agentsMap =
    (config.agent as Record<string, unknown> | undefined) || {};

  for (const agent of input.agents) {
    const existingBlock = agentsMap[agent.name] as
      | Record<string, unknown>
      | undefined;
    const nextBlock = composeAgentBlock(agent, existingBlock);
    let reason: "new" | "changed" | "unchanged";
    if (!existingBlock) reason = "new";
    else if (deepEqual(existingBlock, nextBlock)) reason = "unchanged";
    else reason = "changed";
    operations.push({
      kind: "patch-json",
      target: jsonTarget,
      agentName: agent.name,
      nextBlock,
      reason,
    });
  }

  // ---- Lifecycle lowering (source lifecycles -> runtime skills)
  for (const lifecycle of input.lifecycles) {
    const target = lifecycleSkillMdPath(input.target, lifecycle.name);
    desiredLifecycleSkillFiles.add(lifecycleSkillRelativePath(lifecycle.name));
    const desired = renderLifecycleSkill(
      lifecycle,
      input.target.sourcePluginName,
    );
    let reason: "new" | "changed" | "unchanged";
    if (await fileExists(target)) {
      const current = await readFile(target);
      reason = current === desired ? "unchanged" : "changed";
    } else {
      reason = "new";
    }
    operations.push({
      kind: "write-md",
      target,
      content: desired,
      reason,
    });
  }

  operations.push(
    ...(await planLifecycleSkillPruning(
      input.target,
      desiredLifecycleSkillFiles,
    )),
  );

  // ---- Generated plugin emission (only if any agent has tool bindings)
  if (hasAnyTool) {
    const root = generatedPluginRoot(input.target);

    // package.json
    desiredPluginFiles.add("package.json");
    const pkgTarget = join(root, "package.json");
    const desiredPkg = GENERATED_PACKAGE_JSON(ownedGeneratedPluginId);
    let pkgReason: "new" | "changed" | "unchanged";
    if (await fileExists(pkgTarget)) {
      const current = await readFile(pkgTarget);
      pkgReason = current === desiredPkg ? "unchanged" : "changed";
    } else {
      pkgReason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target: pkgTarget,
      content: desiredPkg,
      reason: pkgReason,
    });

    // schema-bridge.ts (shipped verbatim from agentpkg)
    desiredPluginFiles.add("src/runtime/schema-bridge.ts");
    const bridgeTarget = join(root, "src", "runtime", "schema-bridge.ts");
    const desiredBridge = await getSchemaBridgeSource();
    let bridgeReason: "new" | "changed" | "unchanged";
    if (await fileExists(bridgeTarget)) {
      const current = await readFile(bridgeTarget);
      bridgeReason = current === desiredBridge ? "unchanged" : "changed";
    } else {
      bridgeReason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target: bridgeTarget,
      content: desiredBridge,
      reason: bridgeReason,
    });

    // Mirror every source plugin's contracts/ and schemas/ under src/plugins/<name>/
    const referencedBindings = input.agents.flatMap((a) => a.toolBindings);
    const mirrors = await planPluginMirrors(referencedBindings);
    for (const mirror of mirrors) {
      for (const file of mirror.files) {
        const relativeTarget = `src/plugins/${mirror.pluginName}/${file.relativePath}`;
        desiredPluginFiles.add(relativeTarget);
        const target = join(
          root,
          "src",
          "plugins",
          mirror.pluginName,
          file.relativePath,
        );
        const raw = file.content ?? (await readFile(file.sourcePath!));
        const desired = normalizeMirroredPluginSource(file.relativePath, raw);
        let reason: "new" | "changed" | "unchanged";
        if (await fileExists(target)) {
          const current = await readFile(target);
          reason = current === desired ? "unchanged" : "changed";
        } else {
          reason = "new";
        }
        operations.push({
          kind: "write-plugin-file",
          target,
          content: desired,
          reason,
        });
      }
    }

    // Generated adapters, one per bound contract
    const adapters = planAdapters(input.agents);
    for (const spec of adapters) {
      const relativeTarget = `src/adapters/${spec.pluginName}/${spec.contractName}.adapter.ts`;
      desiredPluginFiles.add(relativeTarget);
      const target = join(
        root,
        "src",
        "adapters",
        spec.pluginName,
        `${spec.contractName}.adapter.ts`,
      );
      const desired = renderAdapter(spec);
      let reason: "new" | "changed" | "unchanged";
      if (await fileExists(target)) {
        const current = await readFile(target);
        reason = current === desired ? "unchanged" : "changed";
      } else {
        reason = "new";
      }
      operations.push({
        kind: "write-plugin-file",
        target,
        content: desired,
        reason,
      });
    }

    // Generated server.ts (imports adapters)
    desiredPluginFiles.add("src/server.ts");
    const serverTarget = join(root, "src", "server.ts");
    const desiredServer = renderGeneratedServerTs(
      input.agents,
      input.target.sourcePluginName,
      ownedGeneratedPluginId,
      adapters,
    );
    let serverReason: "new" | "changed" | "unchanged";
    if (await fileExists(serverTarget)) {
      const current = await readFile(serverTarget);
      serverReason = current === desiredServer ? "unchanged" : "changed";
    } else {
      serverReason = "new";
    }
    operations.push({
      kind: "write-plugin-file",
      target: serverTarget,
      content: desiredServer,
      reason: serverReason,
    });

    operations.push(...(await planPluginPruning(root, desiredPluginFiles)));
  }

  // ---- opencode.json plugin array entry for this compile root only
  const plugins = (config.plugin as unknown) instanceof Array
    ? (config.plugin as unknown[])
    : [];
  const already = plugins.includes(ownedGeneratedPluginId);
  const pluginReason: "new" | "changed" | "unchanged" = hasAnyTool
    ? already
      ? "unchanged"
      : "new"
    : already
      ? "changed"
      : "unchanged";
  operations.push({
    kind: "patch-opencode-plugins",
    target: jsonTarget,
    pluginId: ownedGeneratedPluginId,
    desiredPresent: hasAnyTool,
    reason: pluginReason,
  });

  return operations;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const executeLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean }
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  // Apply non-JSON operations first, JSON last so we aggregate agent + plugin
  // patches into a single read-modify-write-of opencode.json.

  for (const op of operations) {
    if (op.reason === "unchanged") continue;
    if (op.kind === "patch-json" || op.kind === "patch-opencode-plugins") continue;

    if (op.kind === "write-md" || op.kind === "write-plugin-file") {
      if (options.backup && op.kind === "write-md") {
        const b = await backupFile(op.target);
        if (b) backups.push(b);
      }
      await writeFile(op.target, op.content);
      continue;
    }

    if (op.kind === "prune-plugin-path") {
      if (op.targetType === "dir") {
        await removeDir(op.target);
      } else {
        await removeFile(op.target);
      }
      continue;
    }
  }

  // Aggregate all JSON patches into one write.
  const jsonOps = operations.filter(
    (op) =>
      (op.kind === "patch-json" || op.kind === "patch-opencode-plugins") &&
      op.reason !== "unchanged"
  );
  if (jsonOps.length > 0) {
    const jsonTarget = jsonOps[0]!.target;
    if (options.backup) {
      const b = await backupFile(jsonTarget);
      if (b) backups.push(b);
    }

    let config: Record<string, unknown> = {};
    if (await fileExists(jsonTarget)) {
      config = await readJson<Record<string, unknown>>(jsonTarget);
    }

    const agentsMap =
      (config.agent as Record<string, unknown> | undefined) || {};

    for (const op of jsonOps) {
      if (op.kind === "patch-json") {
        agentsMap[op.agentName] = op.nextBlock;
      } else if (op.kind === "patch-opencode-plugins") {
        const hadPluginKey = Object.prototype.hasOwnProperty.call(config, "plugin");
        const plugins = Array.isArray(config.plugin)
          ? [...(config.plugin as unknown[])]
          : [];

        if (op.desiredPresent) {
          if (!plugins.includes(op.pluginId)) {
            plugins.push(op.pluginId);
          }
        } else {
          const nextPlugins = plugins.filter((pluginId) => pluginId !== op.pluginId);
          plugins.length = 0;
          plugins.push(...nextPlugins);
        }

        if (plugins.length > 0 || hadPluginKey) {
          config.plugin = plugins;
        } else {
          delete config.plugin;
        }
      }
    }
    config.agent = agentsMap;

    const serialized = JSON.stringify(config, null, 2) + "\n";
    await writeFile(jsonTarget, serialized);
  }

  return { backups };
};

export const describeOperation = (op: LowerOperation): string => {
  switch (op.kind) {
    case "write-md":
      return `${op.reason.padEnd(9)} md     ${op.target}`;
    case "patch-json":
      return `${op.reason.padEnd(9)} json   ${op.target} [agent.${op.agentName}]`;
    case "write-plugin-file":
      return `${op.reason.padEnd(9)} plugin ${op.target}`;
    case "patch-opencode-plugins":
      return `${op.reason.padEnd(9)} json   ${op.target} [plugin ${op.desiredPresent ? "+=" : "-="} ${op.pluginId}]`;
    case "prune-plugin-path":
      return `${op.reason.padEnd(9)} prune  ${op.target}${op.targetType === "dir" ? " [dir]" : ""}`;
  }
};

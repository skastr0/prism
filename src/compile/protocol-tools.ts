import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import { Schema } from "effect";
import {
  Contract,
  type CanonicalTool,
  type NormalizedTraitBinding,
  type NormalizedTraitBindingToolSlot,
  type Trait,
} from "./sources.js";
import type { PluginRegistry } from "./registry.js";

export interface ProtocolSurfaceError {
  readonly field: string;
  readonly message: string;
}

export interface ToolPermissionBinding {
  readonly kind: "permission";
  readonly logicalName: string;
  readonly contract?: undefined;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly toolSourcePath: string;
}

export interface SyntheticToolBinding {
  readonly kind: "synthetic";
  readonly logicalName: string;
  readonly contract: Contract;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly toolSourcePath: string;
}

export type MaterializedTraitTool = ToolPermissionBinding | SyntheticToolBinding;
export type MaterializedLifecycleToolPermission = MaterializedTraitTool;

export type TraitBindingValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProtocolSurfaceError };

const protocolError = (field: string, message: string): ProtocolSurfaceError => ({
  field,
  message,
});

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value));

const parseNamedRef = (ref: string): { pluginPrefix: string | undefined; name: string } => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return { pluginPrefix: ref.slice(0, colon), name: ref.slice(colon + 1) };
};

const resolveToolRef = (
  ref: string,
  registry: PluginRegistry,
): { tool: CanonicalTool; pluginName: string; registry: PluginRegistry } | undefined => {
  const parsed = parseNamedRef(ref);
  const owner = parsed.pluginPrefix ? registry.deps.get(parsed.pluginPrefix) : registry;
  if (!owner) return undefined;
  const tool = owner.tools.get(parsed.name);
  if (!tool) return undefined;
  return { tool, pluginName: owner.pluginName, registry: owner };
};

const normalizeGeneratedPluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

const externalGeneratedPluginModulePath = (
  pluginName: string,
  modulePath: string,
): string =>
  `../../../../../agentpkg-generated-${normalizeGeneratedPluginName(pluginName)}/src/plugins/${pluginName}/${modulePath}`;

const pluginModuleImportPath = (
  contractPluginName: string,
  modulePluginName: string,
  modulePath: string,
): string =>
  contractPluginName === modulePluginName
    ? `../${modulePath}`
    : externalGeneratedPluginModulePath(modulePluginName, modulePath);

const toolImportPath = (
  contractPluginName: string,
  toolPluginName: string,
  toolName: string,
): string =>
  pluginModuleImportPath(
    contractPluginName,
    toolPluginName,
    `tools/${toolName}.tool`,
  );

const sourceIsInside = (sourcePath: string, pluginPath: string): boolean => {
  const rel = relative(pluginPath, sourcePath);
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const registries = function* (registry: PluginRegistry): Generator<PluginRegistry> {
  yield registry;
  for (const dep of registry.deps.values()) {
    yield* registries(dep);
  }
};

const resolveSourcePlugin = (
  sourcePath: string,
  registry: PluginRegistry,
): { pluginName: string; modulePath: string } | undefined => {
  let best: PluginRegistry | undefined;
  for (const candidate of registries(registry)) {
    if (!sourceIsInside(sourcePath, candidate.pluginPath)) continue;
    if (!best || candidate.pluginPath.length > best.pluginPath.length) {
      best = candidate;
    }
  }
  if (!best) return undefined;
  const rel = relative(best.pluginPath, sourcePath).replace(/\\/g, "/");
  return {
    pluginName: best.pluginName,
    modulePath: rel.replace(/\.ts$/, ""),
  };
};

const schemaImportPath = (
  contractPluginName: string,
  schemaPluginName: string,
  modulePath: string,
): string => pluginModuleImportPath(contractPluginName, schemaPluginName, modulePath);

const bindingSignature = (
  toolRef: string,
  slots: Readonly<Record<string, NormalizedTraitBindingToolSlot>>,
): string =>
  stableStringify({
    toolRef,
    slots: Object.fromEntries(
      Object.entries(slots)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([slotName, slot]) => [
          slotName,
          {
            sourcePath: slot.source.sourcePath,
            exportName: slot.source.exportName,
          },
        ]),
    ),
  });

const renderSlotWrapperContractSource = (options: {
  readonly description: string;
  readonly contractPluginName: string;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly slots: Readonly<Record<string, NormalizedTraitBindingToolSlot>>;
  readonly registry: PluginRegistry;
}): string | ProtocolSurfaceError => {
  const imports: string[] = [];
  const structLines: string[] = [];

  for (const [index, [slotName, slot]] of Object.entries(options.slots)
    .sort(([left], [right]) => left.localeCompare(right))
    .entries()) {
    const resolvedSource = resolveSourcePlugin(slot.source.sourcePath, options.registry);
    if (!resolvedSource) {
      return protocolError(
        `tools.${options.toolName}.slots.${slotName}`,
        `schema source '${slot.source.sourcePath}' is outside the plugin graph`,
      );
    }

    const localName = `slot_${index}_${slotName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const importPath = schemaImportPath(
      options.contractPluginName,
      resolvedSource.pluginName,
      resolvedSource.modulePath,
    );
    if (slot.source.exportName === "default") {
      imports.push(`import ${localName} from ${JSON.stringify(importPath)};`);
    } else {
      imports.push(
        `import { ${slot.source.exportName} as ${localName} } from ${JSON.stringify(importPath)};`,
      );
    }
    structLines.push(`  ${JSON.stringify(slotName)}: ${localName},`);
  }

  const lines: string[] = [];
  lines.push('import { Schema } from "effect";');
  lines.push(
    `import { default as canonical } from ${JSON.stringify(toolImportPath(options.contractPluginName, options.toolPluginName, options.toolName))};`,
  );
  lines.push(...imports);
  lines.push("");
  lines.push(`export const description = ${JSON.stringify(options.description)};`);
  lines.push(
    `export const Input = Schema.extend(canonical.input as Schema.Schema.AnyNoContext, Schema.Struct({`,
  );
  lines.push(...structLines);
  lines.push(`}));`);
  lines.push(`export const Output = canonical.output as Schema.Schema.AnyNoContext;`);
  lines.push("");
  lines.push("export const handle = canonical.handle;");
  lines.push("");
  return lines.join("\n");
};

export const validateTraitBindingSlots = (
  trait: Trait,
  binding: NormalizedTraitBinding,
): TraitBindingValidationResult => {
  const unknownToolNames = Object.keys(binding.tools).filter(
    (logicalName) => !Object.prototype.hasOwnProperty.call(trait.tools, logicalName),
  );
  if (unknownToolNames.length > 0) {
    return {
      ok: false,
      error: protocolError(
        "traits.tools",
        `fills slots for unknown tool(s): ${unknownToolNames.join(", ")}`,
      ),
    };
  }

  return { ok: true };
};

const permissionBinding = (
  logicalName: string,
  resolved: { tool: CanonicalTool; pluginName: string },
): ToolPermissionBinding => {
  const toolName = basename(resolved.tool.sourcePath, ".tool.ts");
  return {
    kind: "permission",
    logicalName,
    toolPluginName: resolved.pluginName,
    toolName,
    toolSourcePath: resolved.tool.sourcePath,
  };
};

export const materializeTraitTools = (options: {
  readonly agentName: string;
  readonly ownerPluginName: string;
  readonly canonicalTraitId: string;
  readonly trait: Trait;
  readonly binding: NormalizedTraitBinding;
  readonly registry: PluginRegistry;
}): ReadonlyArray<MaterializedTraitTool> | ProtocolSurfaceError => {
  const materialized: MaterializedTraitTool[] = [];

  for (const [logicalName, attachment] of Object.entries(options.trait.tools).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const resolved = resolveToolRef(attachment.ref, options.registry);
    if (!resolved) {
      return protocolError(
        `traits.${options.trait.name}.tools.${logicalName}.ref`,
        `references unknown tool '${attachment.ref}'`,
      );
    }

    const filledSlots = options.binding.tools[logicalName]?.slots ?? {};
    const filledSlotEntries = Object.entries(filledSlots);
    if (filledSlotEntries.length === 0) {
      materialized.push(permissionBinding(logicalName, resolved));
      continue;
    }

    const unknownSlots = filledSlotEntries
      .map(([slotName]) => slotName)
      .filter((slotName) => !Object.prototype.hasOwnProperty.call(resolved.tool.slots, slotName));
    if (unknownSlots.length > 0) {
      return protocolError(
        `traits.${options.trait.name}.tools.${logicalName}.slots`,
        `fills undeclared tool slot(s): ${unknownSlots.join(", ")}`,
      );
    }

    for (const [slotName, slot] of filledSlotEntries) {
      if (!Schema.isSchema(slot.schema)) {
        return protocolError(
          `traits.${options.trait.name}.tools.${logicalName}.slots.${slotName}`,
          "must resolve to an Effect Schema",
        );
      }
    }

    const toolName = basename(resolved.tool.sourcePath, ".tool.ts");
    const contractSource = renderSlotWrapperContractSource({
      description: resolved.tool.description,
      contractPluginName: options.ownerPluginName,
      toolPluginName: resolved.pluginName,
      toolName,
      slots: filledSlots,
      registry: options.registry,
    });
    if (typeof contractSource !== "string") return contractSource;

    const suffix = createHash("sha256")
      .update(bindingSignature(attachment.ref, filledSlots))
      .digest("hex")
      .slice(0, 12);
    const contractName = `${options.trait.name}__${logicalName}__${suffix}`;

    materialized.push({
      kind: "synthetic",
      logicalName,
      contract: new Contract({
        name: contractName,
        sourcePath: `${options.trait.sourcePath}#${logicalName}`,
        pluginName: options.ownerPluginName,
        generatedFiles: [
          {
            relativePath: `contracts/${contractName}.contract.ts`,
            content: contractSource,
          },
        ],
      }),
      toolPluginName: resolved.pluginName,
      toolName,
      toolSourcePath: resolved.tool.sourcePath,
    });
  }

  return materialized;
};

export const materializeLifecycleToolPermission = (options: {
  readonly logicalName: string;
  readonly toolRef: string;
  readonly registry: PluginRegistry;
}): MaterializedLifecycleToolPermission | ProtocolSurfaceError => {
  const resolved = resolveToolRef(options.toolRef, options.registry);
  if (!resolved) {
    return protocolError(
      "tool_permissions.tools.ref",
      `references unknown tool '${options.toolRef}'`,
    );
  }

  return permissionBinding(options.logicalName, resolved);
};

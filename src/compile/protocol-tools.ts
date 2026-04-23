import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Schema, SchemaAST } from "effect";
import {
  Contract,
  type CanonicalTool,
  type InlineSchemaValue,
  type NormalizedTraitBinding,
  type NormalizedTraitToolAttachment,
  type NormalizedTraitToolSchemaValue,
  type Trait,
  type TraitSlot,
  type TraitSlotRef,
} from "./sources.js";
import type { PluginRegistry } from "./registry.js";

export interface ProtocolSurfaceError {
  readonly field: string;
  readonly message: string;
}

export interface MaterializedTraitTool {
  readonly logicalName: string;
  readonly contract: Contract;
  readonly canonicalToolPlugin: string;
  readonly canonicalToolName: string;
}

export type TraitBindingValidationResult =
  | { readonly ok: true; readonly slots: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: ProtocolSurfaceError };

const protocolError = (field: string, message: string): ProtocolSurfaceError => ({
  field,
  message,
});

const isEffectSchema = (value: unknown): value is Schema.Schema.AnyNoContext =>
  Schema.isSchema(value);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

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

const propertyPath = (field: string, name: PropertyKey): string =>
  field.length > 0 ? `${field}.${String(name)}` : String(name);

const arrayPath = (field: string): string =>
  field.length > 0 ? `${field}[]` : "[]";

const stripOptionalUnion = (ast: SchemaAST.AST): SchemaAST.AST | undefined => {
  if (ast._tag !== "Union") return undefined;

  const nonUndefined = ast.types.filter((type) => type._tag !== "UndefinedKeyword");
  const undefinedCount = ast.types.length - nonUndefined.length;
  if (ast.types.length === 2 && undefinedCount === 1 && nonUndefined.length === 1) {
    return nonUndefined[0];
  }

  return undefined;
};

const schemaAstToSource = (
  ast: SchemaAST.AST,
  field: string,
): string | ProtocolSurfaceError => {
  switch (ast._tag) {
    case "StringKeyword":
      return "Schema.String";
    case "NumberKeyword":
      return "Schema.Number";
    case "BooleanKeyword":
      return "Schema.Boolean";
    case "Literal":
      return `Schema.Literal(${JSON.stringify(ast.literal)})`;
    case "Union": {
      if (ast.types.every((type) => type._tag === "Literal")) {
        return `Schema.Literal(${ast.types
          .map((type) => JSON.stringify((type as SchemaAST.Literal).literal))
          .join(", ")})`;
      }

      const optional = stripOptionalUnion(ast);
      if (optional) {
        const inner = schemaAstToSource(optional, field);
        if (typeof inner !== "string") return inner;
        return `Schema.optional(${inner})`;
      }

      return protocolError(field, `uses unsupported schema AST '${ast._tag}'`);
    }
    case "TupleType": {
      if (ast.elements.length === 0 && ast.rest.length === 1) {
        const nested = schemaAstToSource(ast.rest[0]!.type, arrayPath(field));
        if (typeof nested !== "string") return nested;
        return `Schema.Array(${nested})`;
      }

      return protocolError(field, `uses unsupported schema AST '${ast._tag}'`);
    }
    case "TypeLiteral": {
      if (ast.indexSignatures.length > 0) {
        return protocolError(field, "record-like schemas are not supported in protocol tools");
      }

      if (ast.propertySignatures.length === 0) {
        return "Schema.Struct({})";
      }

      const properties: string[] = [];
      for (const prop of ast.propertySignatures) {
        const innerAst = prop.isOptional ? stripOptionalUnion(prop.type) ?? prop.type : prop.type;
        const nested = schemaAstToSource(innerAst, propertyPath(field, prop.name));
        if (typeof nested !== "string") return nested;
        const rendered = prop.isOptional ? `Schema.optional(${nested})` : nested;
        properties.push(`  ${JSON.stringify(String(prop.name))}: ${rendered},`);
      }

      return `Schema.Struct({\n${properties.join("\n")}\n})`;
    }
    case "Refinement":
      return schemaAstToSource(ast.from, field);
    case "Transformation":
      return schemaAstToSource(ast.from, field);
    case "Suspend":
      return schemaAstToSource(ast.f(), field);
    default:
      return protocolError(field, `uses unsupported schema AST '${ast._tag}'`);
  }
};

const schemaToSource = (
  schema: Schema.Schema.AnyNoContext,
  field: string,
): string | ProtocolSurfaceError => schemaAstToSource(schema.ast, field);

const valueLiteralSource = (value: unknown, field: string): string | ProtocolSurfaceError => {
  if (value === undefined) {
    return protocolError(field, "must not be undefined");
  }

  const serialized = stableStringify(value);
  if (serialized === undefined) {
    return protocolError(field, "must be JSON-serializable");
  }

  return serialized;
};

const renderTemplateValue = (
  slotName: string,
  value: unknown,
  field: string,
): string | ProtocolSurfaceError => {
  if (isEffectSchema(value)) {
    return protocolError(field, `slot '${slotName}' is a schema slot and cannot be interpolated into text`);
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  const serialized = valueLiteralSource(value, field);
  if (typeof serialized !== "string") return serialized;
  return serialized;
};

const renderTemplate = (
  template: string,
  slots: Readonly<Record<string, unknown>>,
  field: string,
): string | ProtocolSurfaceError => {
  let error: ProtocolSurfaceError | undefined;
  const rendered = template.replace(/\$\{([^}]+)\}/g, (_, rawName: string) => {
    const slotName = rawName.trim();
    if (!Object.prototype.hasOwnProperty.call(slots, slotName)) {
      error = protocolError(field, `requires bound slot '${slotName}'`);
      return "";
    }

    const replacement = renderTemplateValue(slotName, slots[slotName], field);
    if (typeof replacement !== "string") {
      error = replacement;
      return "";
    }

    return replacement;
  });

  return error ?? rendered;
};

const resolveSchemaSlot = (
  slots: Readonly<Record<string, unknown>>,
  slotRef: TraitSlotRef,
  field: string,
): Schema.Schema.AnyNoContext | ProtocolSurfaceError => {
  const bound = slots[slotRef.slot];
  if (bound === undefined) {
    return protocolError(field, `requires bound schema slot '${slotRef.slot}'`);
  }

  if (!isEffectSchema(bound)) {
    return protocolError(field, `slot '${slotRef.slot}' must be bound to an Effect Schema`);
  }

  return bound;
};

const resolveToolSchema = (
  slots: Readonly<Record<string, unknown>>,
  value: NormalizedTraitToolSchemaValue | undefined,
  field: string,
): Schema.Schema.AnyNoContext | ProtocolSurfaceError => {
  if (!value) {
    return protocolError(field, "must be defined");
  }

  if (value.kind === "trait-slot-ref") {
    return resolveSchemaSlot(slots, value, field);
  }

  if (!isEffectSchema(value.schema)) {
    return protocolError(field, "must resolve to an Effect Schema");
  }

  return value.schema;
};

const renderSlotsObjectSource = (
  slots: Readonly<Record<string, unknown>>,
  field: string,
): string | ProtocolSurfaceError => {
  const entries = Object.entries(slots).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "{}";
  }

  const rendered: string[] = [];
  for (const [slotName, value] of entries) {
    const literal = isEffectSchema(value)
      ? schemaToSource(value, `${field}.${slotName}`)
      : valueLiteralSource(value, `${field}.${slotName}`);
    if (typeof literal !== "string") return literal;
    rendered.push(`  ${JSON.stringify(slotName)}: ${literal},`);
  }

  return `{\n${rendered.join("\n")}\n}`;
};

const renderContractSource = (options: {
  readonly description: string;
  readonly inputSource: string;
  readonly outputSource: string;
  readonly slotsSource: string;
  readonly canonicalToolImportPath: string;
}): string => {
  const lines: string[] = [];
  lines.push('import { Schema } from "effect";');
  lines.push(`import { default as canonical } from "${options.canonicalToolImportPath}";`);
  lines.push("");
  lines.push(`export const description = ${JSON.stringify(options.description)};`);
  lines.push(`export const Input = ${options.inputSource};`);
  lines.push(`export const Output = ${options.outputSource};`);
  lines.push("");
  lines.push(`const slots = ${options.slotsSource};`);
  lines.push("");
  lines.push("export const handle = canonical.handle;");
  lines.push("");
  return lines.join("\n");
};

export const validateTraitBindingSlots = (
  trait: Trait,
  binding: NormalizedTraitBinding,
): TraitBindingValidationResult => {
  const providedNames = Object.keys(binding.slots);
  const unknownSlots = providedNames.filter(
    (slotName) => !Object.prototype.hasOwnProperty.call(trait.slots, slotName),
  );
  if (unknownSlots.length > 0) {
    return {
      ok: false,
      error: protocolError("traits.slots", `provides unknown slot(s): ${unknownSlots.join(", ")}`),
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const [slotName, slot] of Object.entries(trait.slots).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const hasBinding = Object.prototype.hasOwnProperty.call(binding.slots, slotName);
    if (!hasBinding) {
      if (slot.required === false) continue;
      return {
        ok: false,
        error: protocolError("traits.slots", `is missing required slot '${slotName}'`),
      };
    }

    const value = binding.slots[slotName];
    if (slot.kind === "schema") {
      if (!isEffectSchema(value)) {
        return {
          ok: false,
          error: protocolError(
            "traits.slots",
            `slot '${slotName}' must be bound to an Effect Schema`,
          ),
        };
      }
      normalized[slotName] = value;
      continue;
    }

    const decoded = Schema.decodeUnknownEither(slot.schema as Schema.Schema.AnyNoContext)(value);
    if (decoded._tag === "Left") {
      return {
        ok: false,
        error: protocolError(
          "traits.slots",
          `slot '${slotName}' failed validation: ${decoded.left.message}`,
        ),
      };
    }
    normalized[slotName] = decoded.right;
  }

  return { ok: true, slots: normalized };
};

const parseNamedRef = (ref: string): { pluginPrefix: string | undefined; name: string } => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return { pluginPrefix: ref.slice(0, colon), name: ref.slice(colon + 1) };
};

const resolveCanonicalToolRef = (
  ref: string,
  registry: PluginRegistry,
): { tool: CanonicalTool; pluginName: string } | undefined => {
  const parsed = parseNamedRef(ref);
  const owner = parsed.pluginPrefix ? registry.deps.get(parsed.pluginPrefix) : registry;
  if (!owner) return undefined;
  const tool = owner.tools.get(parsed.name);
  if (!tool) return undefined;
  return { tool, pluginName: owner.pluginName };
};

const canonicalToolImportPath = (
  contractPluginName: string,
  toolPluginName: string,
  toolName: string,
): string => {
  if (contractPluginName === toolPluginName) {
    return `../tools/${toolName}.tool`;
  }
  return `../../${toolPluginName}/tools/${toolName}.tool`;
};

export const materializeTraitTools = (options: {
  readonly agentName: string;
  readonly ownerPluginName: string;
  readonly canonicalTraitId: string;
  readonly trait: Trait;
  readonly binding: NormalizedTraitBinding;
  readonly boundSlots: Readonly<Record<string, unknown>>;
  readonly registry: PluginRegistry;
}): ReadonlyArray<MaterializedTraitTool> | ProtocolSurfaceError => {
  const materialized: MaterializedTraitTool[] = [];

  for (const [logicalName, attachment] of Object.entries(options.trait.tools).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const resolved = resolveCanonicalToolRef(attachment.ref, options.registry);
    if (!resolved) {
      return protocolError(
        `traits.${options.trait.name}.tools.${logicalName}.ref`,
        `references unknown canonical tool '${attachment.ref}'`,
      );
    }

    const canonical = resolved.tool;
    const descriptionTemplate = attachment.description ?? canonical.description;
    const description = renderTemplate(
      descriptionTemplate,
      options.boundSlots,
      `traits.${options.trait.name}.tools.${logicalName}.description`,
    );
    if (typeof description !== "string") return description;

    const inputValue = attachment.input ?? { kind: "inline-schema", schema: canonical.input };
    const inputSchema = resolveToolSchema(
      options.boundSlots,
      inputValue,
      `traits.${options.trait.name}.tools.${logicalName}.input`,
    );
    if (!isEffectSchema(inputSchema)) return inputSchema;

    const outputValue = attachment.output ?? { kind: "inline-schema", schema: canonical.output };
    const outputSchema = resolveToolSchema(
      options.boundSlots,
      outputValue,
      `traits.${options.trait.name}.tools.${logicalName}.output`,
    );
    if (!isEffectSchema(outputSchema)) return outputSchema;

    const inputSource = schemaToSource(
      inputSchema,
      `traits.${options.trait.name}.tools.${logicalName}.input`,
    );
    if (typeof inputSource !== "string") return inputSource;

    const outputSource = schemaToSource(
      outputSchema,
      `traits.${options.trait.name}.tools.${logicalName}.output`,
    );
    if (typeof outputSource !== "string") return outputSource;

    const slotsSource = renderSlotsObjectSource(
      options.boundSlots,
      `traits.${options.trait.name}.slots`,
    );
    if (typeof slotsSource !== "string") return slotsSource;

    const toolFileStem = basename(canonical.sourcePath, ".tool.ts");
    const importPath = canonicalToolImportPath(
      options.ownerPluginName,
      resolved.pluginName,
      toolFileStem,
    );

    const contractSource = renderContractSource({
      description,
      inputSource,
      outputSource,
      slotsSource,
      canonicalToolImportPath: importPath,
    });

    const suffix = createHash("sha256")
      .update(
        stableStringify({
          trait: options.canonicalTraitId,
          logicalName,
          description,
          inputSource,
          outputSource,
          slots: options.boundSlots,
          canonicalToolRef: attachment.ref,
        }),
      )
      .digest("hex")
      .slice(0, 12);
    const contractName = `${options.trait.name}__${logicalName}__${suffix}`;

    materialized.push({
      logicalName,
      contract: new Contract({
        name: contractName,
        sourcePath: `${options.trait.sourcePath}#${logicalName}:${options.agentName}`,
        pluginName: options.ownerPluginName,
        generatedFiles: [
          {
            relativePath: `contracts/${contractName}.contract.ts`,
            content: contractSource,
          },
        ],
      }),
      canonicalToolPlugin: resolved.pluginName,
      canonicalToolName: toolFileStem,
    });
  }

  return materialized;
};

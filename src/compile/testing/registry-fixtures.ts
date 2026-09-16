/**
 * Property-test arbitraries for compile-language source models.
 *
 * Generators stay inside the schema-bridge-supported subset and valid
 * plugin-graph invariants so tests prove refinement laws, not just
 * "invalid input throws".  Adversarial inputs are built explicitly in
 * the tests that expect a specific CompileError / ProtocolSurfaceError.
 */

import fc from "fast-check";
import { Schema } from "effect";
import { emptyRegistry, type PluginRegistry } from "../registry.js";
import { Modelspace, Skillspace } from "../sources.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export const arbitraryIdentifier = (opts: { minLength?: number; maxLength?: number } = {}): fc.Arbitrary<string> =>
  fc.string({ minLength: opts.minLength ?? 1, maxLength: opts.maxLength ?? 16 })
    .map((s) => s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_"))
    .filter((s) => !RESERVED_PROPERTY_NAMES.has(s));

export const arbitraryPluginName = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 24 }).map((s) =>
    s.replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "").replace(/^[0-9]/, "p")
  );

export const arbitrarySourcePath = (root: string, ...segments: string[]): fc.Arbitrary<string> =>
  fc.constant(joinSourcePath(root, ...segments));

const joinSourcePath = (root: string, ...segments: string[]): string => {
  const joined = [root, ...segments].join("/").replace(/\/+/g, "/");
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
};

// ---------------------------------------------------------------------------
// Schema-bridge-supported subset
// ---------------------------------------------------------------------------

export interface BridgeSupportedSchemaOptions {
  readonly maxDepth?: number;
  readonly maxProperties?: number;
}

export const arbitraryBridgeSupportedSchema = (
  opts: BridgeSupportedSchemaOptions = {},
): fc.Arbitrary<Schema.Top> => {
  const maxDepth = opts.maxDepth ?? 3;
  const maxProperties = opts.maxProperties ?? 4;

  const primitive: fc.Arbitrary<Schema.Top> = fc.oneof(
    fc.constant(Schema.String),
    fc.constant(Schema.Number),
    fc.constant(Schema.Boolean),
    fc.constant(Schema.Unknown),
    fc.string({ minLength: 1, maxLength: 12 }).map((value) => Schema.Literal(value)),
    fc.integer({ min: -100, max: 100 }).map((value) => Schema.Literal(value)),
    fc.boolean().map((value) => Schema.Literal(value)),
  );

  const leaf: fc.Arbitrary<Schema.Top> = primitive;

  const schemaAtDepth = (depth: number): fc.Arbitrary<Schema.Top> => {
    if (depth <= 0) return leaf;

    const field = fc.record({
      name: arbitraryIdentifier(),
      schema: schemaAtDepth(depth - 1),
      optional: fc.boolean(),
    });

    const struct = fc.array(field, { minLength: 0, maxLength: maxProperties }).map((fields) => {
      const entries = fields.map((f) => [f.name, f.optional ? Schema.optional(f.schema) : f.schema] as const);
      return entries.length === 0 ? Schema.Struct({}) : Schema.Struct(Object.fromEntries(entries));
    });

    const array = schemaAtDepth(depth - 1).map((item) => Schema.Array(item));

    const enumSchema = fc
      .array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 4 })
      .map((values) => Schema.Literals(values));

    return fc.oneof(
      { weight: 3, arbitrary: struct },
      { weight: 1, arbitrary: array },
      { weight: 1, arbitrary: enumSchema },
      { weight: 1, arbitrary: leaf },
    );
  };

  return schemaAtDepth(maxDepth);
};

// ---------------------------------------------------------------------------
// Registry graph
// ---------------------------------------------------------------------------

export interface ArbitraryRegistryOptions {
  readonly maxDepth?: number;
  readonly maxDeps?: number;
  readonly rootPath?: string;
}

export const arbitraryRegistry = (opts: ArbitraryRegistryOptions = {}): fc.Arbitrary<PluginRegistry> => {
  const maxDepth = opts.maxDepth ?? 2;
  const maxDeps = opts.maxDeps ?? 2;

  const registryAtDepth = (depth: number, rootPath: string): fc.Arbitrary<PluginRegistry> =>
    fc.tuple(arbitraryPluginName(), fc.array(arbitraryPluginName(), { minLength: 0, maxLength: maxDeps })).chain(
      ([pluginName, depNames]) => {
        const depNameSet = new Set(depNames);
        depNameSet.delete(pluginName);
        const uniqueDepNames = [...depNameSet];
        const registry = emptyRegistry(`${rootPath}/${pluginName}`, pluginName, "0.1.0");

        if (depth <= 0 || uniqueDepNames.length === 0) {
          return fc.constant(registry);
        }

        return fc
          .tuple(
            ...uniqueDepNames.map((depName) => registryAtDepth(depth - 1, `${rootPath}/${pluginName}/deps/${depName}`)),
          )
          .map((depRegistries) => {
            for (const [index, depName] of uniqueDepNames.entries()) {
              const dep = depRegistries[index];
              if (dep) {
                registry.deps.set(depName, dep);
                registry.dependencyPaths[depName] = dep.pluginPath;
              }
            }
            return registry;
          });
      },
    );

  return registryAtDepth(maxDepth, opts.rootPath ?? "/tmp/prism-fixtures");
};

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export const arbitraryModelspace = (root: string): fc.Arbitrary<Modelspace> =>
  fc
    .tuple(
      arbitraryIdentifier(),
      fc.array(fc.tuple(arbitraryIdentifier(), arbitraryIdentifier(), fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean()))), {
        minLength: 0,
        maxLength: 4,
      }),
    )
    .map(([name, profileTuples]) => {
      const profiles: Record<string, { description?: string; targets: Record<string, object> }> = {};
      for (const [profileName, targetId, block] of profileTuples) {
        profiles[profileName] = {
          description: `Profile ${profileName}`,
          targets: { [targetId]: block as object },
        };
      }
      return new Modelspace({
        name,
        sourcePath: joinSourcePath(root, "modelspaces", `${name}.modelspace`),
        description: `Modelspace ${name}`,
        profiles,
      });
    });

export const arbitrarySkillspace = (root: string): fc.Arbitrary<Skillspace> =>
  fc
    .tuple(
      arbitraryIdentifier(),
      fc.array(fc.tuple(arbitraryIdentifier(), arbitraryIdentifier(), arbitraryIdentifier()), {
        minLength: 0,
        maxLength: 4,
      }),
    )
    .map(([name, skillTuples]) => {
      const skills: Record<string, { description?: string; targets: Record<string, { name: string }> }> = {};
      for (const [skillName, targetId, nativeName] of skillTuples) {
        skills[skillName] = {
          description: `Skill ${skillName}`,
          targets: { [targetId]: { name: nativeName } },
        };
      }
      return new Skillspace({
        name,
        sourcePath: joinSourcePath(root, "skillspaces", `${name}.skillspace`),
        description: `Skillspace ${name}`,
        skills,
      });
    });

// ---------------------------------------------------------------------------
// Test-run configuration
// ---------------------------------------------------------------------------

export const propertyTestConfig = (): { numRuns: number; seed?: number } => {
  const seed = process.env.FC_SEED ? Number.parseInt(process.env.FC_SEED, 10) : undefined;
  return { numRuns: 100, seed: Number.isNaN(seed) ? undefined : seed };
};

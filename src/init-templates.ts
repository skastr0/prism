export const createTypescriptPackageJson = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      type: "module",
      private: true,
      scripts: {
        lint: "oxlint .",
        "lint:fix": "oxlint . --fix",
        format: "oxfmt . --write",
        "format:check": "oxfmt . --check",
        typecheck: "tsc --noEmit",
      },
      devDependencies: {
        oxlint: "^1.62.0",
        oxfmt: "^0.47.0",
        typescript: "^5.8.3",
      },
    },
    null,
    2
  )}\n`;

export const typescriptTsconfigJson = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: [
      "agents/**/*.ts",
      "lifecycles/**/*.ts",
      "modelspaces/**/*.ts",
      "schemas/**/*.ts",
      "skillspaces/**/*.ts",
      "slots/**/*.ts",
      "tools/**/*.ts",
      "toolspaces/**/*.ts",
      "traits/**/*.ts",
    ],
  },
  null,
  2
)}\n`;

export const oxlintConfigJson = `${JSON.stringify(
  {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    jsPlugins: [
      {
        name: "agentpkg",
        specifier: "./agentpkg-oxlint-plugin.js",
      },
    ],
    categories: {
      correctness: "warn",
      suspicious: "warn",
    },
    rules: {
      "agentpkg/no-inline-slot-schemas": "error",
      "agentpkg/no-trait-tool-contract-overrides": "error",
    },
    ignorePatterns: ["node_modules/**", "dist/**", ".agentpkg/**"],
  },
  null,
  2
)}\n`;

export const oxfmtConfigJson = `${JSON.stringify(
  {
    $schema: "./node_modules/oxfmt/configuration_schema.json",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    ignorePatterns: ["node_modules/**", "dist/**", ".agentpkg/**"],
  },
  null,
  2
)}\n`;

export const agentpkgOxlintPluginJs = `const DSL_PATH_PATTERN = /(^|\\/)(agents|lifecycles|modelspaces|skillspaces|toolspaces|traits)(\\/|$)|\\.(agent|lifecycle|modelspace|skillspace|toolspace|trait)\\.ts$/;

const getPropertyName = (property) => {
  if (!property || property.type !== "Property") {
    return undefined;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  if (property.key.type === "Literal") {
    return String(property.key.value);
  }
  return undefined;
};

const findProperty = (node, name) => {
  if (!node || node.type !== "ObjectExpression") {
    return undefined;
  }
  return node.properties.find((property) => getPropertyName(property) === name);
};

const isSchemaMemberExpression = (node) => {
  if (!node || node.type !== "MemberExpression") {
    return false;
  }
  const object = node.object;
  return object.type === "Identifier" && object.name === "Schema";
};

const containsInlineSchemaUsage = (node) => {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (isSchemaMemberExpression(node)) {
    return true;
  }
  if (node.type === "CallExpression" && isSchemaMemberExpression(node.callee)) {
    return true;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((child) => containsInlineSchemaUsage(child))) {
        return true;
      }
    } else if (value && typeof value === "object" && containsInlineSchemaUsage(value)) {
      return true;
    }
  }
  return false;
};

const getLintFilename = (context) => context.filename ?? context.getFilename?.() ?? "";

const isDslFile = (context) => DSL_PATH_PATTERN.test(getLintFilename(context));

const getCalleeName = (node) => {
  if (node.type === "Identifier") {
    return node.name;
  }
  return undefined;
};

const reportInlineSlotSchemas = (context, callNode) => {
  if (getCalleeName(callNode.callee) !== "bindTrait") {
    return;
  }
  const options = callNode.arguments?.[1];
  const tools = findProperty(options, "tools")?.value;
  if (!tools || tools.type !== "ObjectExpression") {
    return;
  }

  for (const toolProperty of tools.properties) {
    const slots = findProperty(toolProperty.value, "slots")?.value;
    if (!slots || slots.type !== "ObjectExpression") {
      continue;
    }
    for (const slotProperty of slots.properties) {
      if (containsInlineSchemaUsage(slotProperty.value)) {
        context.report({
          node: slotProperty.value,
          message:
            "Tool slot fills must reference imported runtime schema identifiers; move inline Effect Schema definitions to schemas/ or slots/ and import the symbol.",
        });
      }
    }
  }
};

const reportTraitContractOverrides = (context, callNode) => {
  if (getCalleeName(callNode.callee) !== "defineTrait") {
    return;
  }
  const definition = callNode.arguments?.[0];
  if (!definition || definition.type !== "ObjectExpression") {
    return;
  }

  const rootSlots = findProperty(definition, "slots");
  if (rootSlots) {
    context.report({
      node: rootSlots,
      message:
        "Traits must not define root-level slots; slots belong to runtime tools and agents may fill declared tool slots.",
    });
  }

  const tools = findProperty(definition, "tools")?.value;
  if (!tools || tools.type !== "ObjectExpression") {
    return;
  }
  for (const toolProperty of tools.properties) {
    const attachment = toolProperty.value;
    if (!attachment || attachment.type !== "ObjectExpression") {
      continue;
    }
    for (const propertyName of ["input", "output"]) {
      const replacement = findProperty(attachment, propertyName);
      if (replacement) {
        context.report({
          node: replacement,
          message:
            "Trait tool input/output replacement is not supported; define a runtime tool slot and fill it from an agent binding.",
        });
      }
    }
  }
};

const noInlineSlotSchemas = {
  meta: {
    type: "problem",
  },
  create(context) {
    if (!isDslFile(context)) {
      return {};
    }
    return {
      CallExpression(node) {
        reportInlineSlotSchemas(context, node);
      },
    };
  },
};

const noTraitToolContractOverrides = {
  meta: {
    type: "problem",
  },
  create(context) {
    if (!isDslFile(context)) {
      return {};
    }
    return {
      CallExpression(node) {
        reportTraitContractOverrides(context, node);
      },
    };
  },
};

export default {
  meta: {
    name: "agentpkg",
  },
  rules: {
    "no-inline-slot-schemas": noInlineSlotSchemas,
    "no-trait-tool-contract-overrides": noTraitToolContractOverrides,
  },
};
`;

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
      "orbits/**/*.ts",
      "modelspaces/**/*.ts",
      "schemas/**/*.ts",
      "skillspaces/**/*.ts",
      "slots/**/*.ts",
      "tools/**/*.ts",
    ],
  },
  null,
  2
)}\n`;

export const oxlintConfigJson = `${JSON.stringify(
  {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    categories: {
      correctness: "warn",
      suspicious: "warn",
    },
    ignorePatterns: ["node_modules/**", "dist/**", ".prism/**"],
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
    ignorePatterns: ["node_modules/**", "dist/**", ".prism/**"],
  },
  null,
  2
)}\n`;


import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type * as TypeScript from "typescript";
import { expandPath } from "./fs.js";
import { compileManifestPath } from "./compile/compile-manifest.js";
import { typescriptBundleImportPath } from "./compile/runtime-deps.js";
import { resolvePrismHome } from "./prism-home.js";
import {
  deriveProjectKey,
  projectGeneratedAgentsPath,
  projectGeneratedRefsDir,
} from "./project-key.js";
import {
  buildWorkflowPaths,
  generateWorkflowTsconfig,
  resolveWorkflowTypeDirs,
  WORKFLOW_TSCONFIG_FILENAME,
} from "./workflow-tsconfig.js";

const ts = createRequire(import.meta.url)(typescriptBundleImportPath()) as typeof TypeScript;

export interface WorkflowTypecheckDiagnostic {
  readonly file: string;
  readonly line: number | null;
  readonly character: number | null;
  readonly message: string;
}

export class WorkflowTypecheckError extends Error {
  override readonly name = "WorkflowTypecheckError";
  constructor(
    readonly filePath: string,
    readonly diagnostics: ReadonlyArray<WorkflowTypecheckDiagnostic>,
  ) {
    const summary = diagnostics
      .slice(0, 5)
      .map((d) => `${d.file}:${d.line ?? "?"}:${d.character ?? "?"}: ${d.message}`)
      .join("\n");
    super(
      `workflow type error in ${filePath}:\n${summary}` +
        (diagnostics.length > 5 ? `\n... and ${diagnostics.length - 5} more` : ""),
    );
  }
}

export interface WorkflowTypecheckResult {
  readonly filePath: string;
  readonly tsconfigPath: string;
}

interface TsconfigJson {
  readonly compilerOptions?: Record<string, unknown>;
  readonly include?: string[];
}

const workflowRefsFilePath = (prismHome: string): string => {
  const { key } = deriveProjectKey();
  return projectGeneratedAgentsPath(prismHome, key);
};

const workflowRefsDirectory = (prismHome: string): string | undefined => {
  const { key } = deriveProjectKey();
  const agentsPath = projectGeneratedAgentsPath(prismHome, key);
  return existsSync(agentsPath) ? projectGeneratedRefsDir(prismHome, key) : undefined;
};

const MANIFEST_HASH_RE = /\*\s+Source:\s+compile manifest\s+([a-f0-9]+)/;

const extractRefsManifestHash = async (refsPath: string): Promise<string | undefined> => {
  if (!existsSync(refsPath)) return undefined;
  try {
    const slice = (await readFile(refsPath, "utf8")).slice(0, 512);
    return MANIFEST_HASH_RE.exec(slice)?.[1];
  } catch {
    return undefined;
  }
};

const readCurrentManifestHash = async (
  prismHome: string,
  projectKey: string,
): Promise<string | undefined> => {
  const manifestPath = compileManifestPath(prismHome, projectKey);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { readonly manifestHash?: string };
    return typeof raw.manifestHash === "string" ? raw.manifestHash : undefined;
  } catch {
    return undefined;
  }
};

export const checkWorkflowRefsFreshness = async (options: {
  readonly prismHome?: string;
}): Promise<void> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const { key } = deriveProjectKey();
  const refsPath = workflowRefsFilePath(prismHome);

  const [refsHash, currentHash] = await Promise.all([
    extractRefsManifestHash(refsPath),
    readCurrentManifestHash(prismHome, key),
  ]);

  if (refsHash === undefined || currentHash === undefined) return;
  if (refsHash === currentHash) return;

  process.stderr.write(
    `warning: generated workflow refs are stale (refs were generated from manifest ` +
      `${refsHash.slice(0, 12)}, current manifest is ${currentHash.slice(0, 12)}). ` +
      `Run \`prism compile\` to regenerate refs.\n`,
  );
};

const BASE_WORKFLOW_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
} as const;

interface WorkflowTypeEnvironment {
  readonly compilerOptions: TypeScript.CompilerOptions;
  readonly hasPrismTypes: boolean;
  readonly hasEffectTypes: boolean;
  readonly hasRefs: boolean;
}

const resolveWorkflowTypeEnvironment = (
  prismHome: string,
): WorkflowTypeEnvironment | null => {
  const typeDirs = resolveWorkflowTypeDirs();
  const refsPath = workflowRefsFilePath(prismHome);
  const hasRefs = existsSync(refsPath);

  const paths = buildWorkflowPaths({
    typeDirs,
    refsDir: hasRefs ? dirname(refsPath) : undefined,
  });

  const onDiskBase = readOnDiskWorkflowCompilerOptions(prismHome);
  const compilerOptionsJson: Record<string, unknown> = {
    ...BASE_WORKFLOW_COMPILER_OPTIONS,
    ...onDiskBase,
    paths,
  };

  const { options, errors } = ts.convertCompilerOptionsFromJson(
    compilerOptionsJson,
    resolvePath(prismHome, "state"),
  );
  if (errors.length > 0) return null;

  const hasPrismTypes = typeDirs.prismTypesDir !== undefined;
  const hasEffectTypes = typeDirs.effectDtsDir !== undefined;

  if (!hasPrismTypes && !hasEffectTypes && !hasRefs) return null;
  return { compilerOptions: options, hasPrismTypes, hasEffectTypes, hasRefs };
};

const readOnDiskWorkflowCompilerOptions = (
  prismHome: string,
): Record<string, unknown> => {
  const { key } = deriveProjectKey();
  const candidates = [
    resolvePath(prismHome, "state", "projects", key, "tsconfig.json"),
    resolvePath(prismHome, "state", WORKFLOW_TSCONFIG_FILENAME),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const configJson = JSON.parse(readFileSync(candidate, "utf8")) as TsconfigJson;
      const { paths: _paths, ...rest } = configJson.compilerOptions ?? {};
      return rest;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
};

const ENVIRONMENT_DIAGNOSTIC_CODES = new Set<number>([
  2307,
  2792,
]);

const IMPLICIT_ANY_CODE = 7006;

export const typecheckWorkflowFile = (
  filePath: string,
  options: { readonly prismHome?: string } = {},
): void => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const environment = resolveWorkflowTypeEnvironment(prismHome);
  if (environment === null) {
    process.stderr.write(
      `warning: workflow type environment unavailable (no generated refs or ` +
        `shipped declarations for this project); skipping typecheck and ` +
        `proceeding with the run. Run \`prism compile\` to enable typechecking.\n`,
    );
    return;
  }

  const compilerOptions = environment.compilerOptions;
  const host = ts.createCompilerHost(compilerOptions);
  const program = ts.createProgram([filePath], compilerOptions, host);
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const fileDiagnostics = allDiagnostics.filter((d) => {
    if (!d.file) return false;
    return d.file.fileName.replace(/\\/g, "/") === normalizedFilePath;
  });

  if (fileDiagnostics.length === 0) return;

  const hasEnvironmentDiagnostic = fileDiagnostics.some((d) =>
    ENVIRONMENT_DIAGNOSTIC_CODES.has(d.code),
  );

  const realErrors = fileDiagnostics.filter((d) => {
    if (ENVIRONMENT_DIAGNOSTIC_CODES.has(d.code)) return false;
    if (d.code === IMPLICIT_ANY_CODE && hasEnvironmentDiagnostic) return false;
    return true;
  });

  const toStructured = (d: TypeScript.Diagnostic): WorkflowTypecheckDiagnostic => {
    const pos =
      d.file !== undefined && d.start !== undefined
        ? ts.getLineAndCharacterOfPosition(d.file, d.start)
        : null;
    return {
      file: d.file?.fileName ?? filePath,
      line: pos ? pos.line + 1 : null,
      character: pos ? pos.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  };

  if (realErrors.length === 0) {
    const summary = fileDiagnostics
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("; ");
    process.stderr.write(
      `warning: workflow types could not be fully resolved for ${filePath} ` +
        `(${summary}); proceeding with the run.\n`,
    );
    return;
  }

  throw new WorkflowTypecheckError(filePath, realErrors.map(toStructured));
};

export const runWorkflowTypecheck = async (
  filePath: string,
  options: { readonly prismHome?: string } = {},
): Promise<WorkflowTypecheckResult> => {
  const resolved = expandPath(filePath);
  const prismHome = options.prismHome ?? resolvePrismHome();
  const generated = await generateWorkflowTsconfig({
    prismHome,
    refsDir: workflowRefsDirectory(prismHome),
    workflowDir: dirname(resolved),
  });
  typecheckWorkflowFile(resolved, { prismHome });
  await checkWorkflowRefsFreshness({ prismHome });
  return { filePath: resolved, tsconfigPath: generated.path };
};

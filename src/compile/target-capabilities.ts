export type GeneratedCanonicalToolSupport = "executable" | "unsupported";

export interface CompileTargetCapabilities {
  readonly generatedCanonicalTools: GeneratedCanonicalToolSupport;
}

const CAPABILITIES: Record<string, CompileTargetCapabilities> = {
  opencode: {
    generatedCanonicalTools: "executable",
  },
  "claude-code": {
    generatedCanonicalTools: "unsupported",
  },
};

export const getCompileTargetCapabilities = (
  target: string,
): CompileTargetCapabilities =>
  CAPABILITIES[target] ?? {
    generatedCanonicalTools: "unsupported",
  };

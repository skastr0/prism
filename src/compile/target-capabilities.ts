export type GeneratedCanonicalToolSupport = "executable" | "unsupported";
export type SkillPermissionSupport = "supported" | "unsupported";
export type CompileSurfaceSupport = "supported" | "unsupported";

export interface CompileTargetCapabilities {
  readonly agents: CompileSurfaceSupport;
  readonly generatedCanonicalTools: GeneratedCanonicalToolSupport;
  readonly hooks: CompileSurfaceSupport;
  readonly skillPermissions: SkillPermissionSupport;
}

const CAPABILITIES: Record<string, CompileTargetCapabilities> = {
  opencode: {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  },
  "claude-code": {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  },
  "gemini-cli": {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  },
  "codex-cli": {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  },
  "amp-code": {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "unsupported",
    skillPermissions: "supported",
  },
  hermes: {
    agents: "unsupported",
    generatedCanonicalTools: "executable",
    hooks: "unsupported",
    skillPermissions: "unsupported",
  },
  grok: {
    agents: "supported",
    generatedCanonicalTools: "executable",
    hooks: "supported",
    skillPermissions: "supported",
  },
};

export const getCompileTargetCapabilities = (
  target: string,
): CompileTargetCapabilities =>
  CAPABILITIES[target] ?? {
    agents: "unsupported",
    generatedCanonicalTools: "unsupported",
    hooks: "unsupported",
    skillPermissions: "unsupported",
  };

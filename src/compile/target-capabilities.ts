export type GeneratedCanonicalToolSupport = "executable" | "unsupported";
export type SkillPermissionSupport = "supported" | "unsupported";

export interface CompileTargetCapabilities {
  readonly generatedCanonicalTools: GeneratedCanonicalToolSupport;
  readonly skillPermissions: SkillPermissionSupport;
}

const CAPABILITIES: Record<string, CompileTargetCapabilities> = {
  opencode: {
    generatedCanonicalTools: "executable",
    skillPermissions: "supported",
  },
  "claude-code": {
    generatedCanonicalTools: "unsupported",
    skillPermissions: "unsupported",
  },
};

export const getCompileTargetCapabilities = (
  target: string,
): CompileTargetCapabilities =>
  CAPABILITIES[target] ?? {
    generatedCanonicalTools: "unsupported",
    skillPermissions: "unsupported",
  };

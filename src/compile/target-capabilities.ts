import type { HarnessId } from "../types.js";
import {
  getCompileTargetCapabilities,
  LOWERER_CAPABILITIES,
} from "../lowerer-capabilities.js";

export { getCompileTargetCapabilities };

export const targetHasGeneratedMcpConfig = (target: HarnessId): boolean =>
  LOWERER_CAPABILITIES[target].surfaces.mcpConfig.kind !== "unsupported";

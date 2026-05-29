import { createHash } from "node:crypto";

export const computeContentHash = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

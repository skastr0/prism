import { spawn } from "node:child_process";
import { resolveBunExecutable } from "../bun-runtime.js";

export const buildHookWrapperWithBun = (
  entry: string,
  outdir: string,
  label: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      resolveBunExecutable(),
      [
        "build",
        entry,
        `--outfile=${outdir}/wrapper.mjs`,
        "--target=node",
        "--format=esm",
        "--packages=bundle",
        "--sourcemap=none",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `failed to build ${label} hook wrapper with bun build: ${stderr.trim() || stdout.trim() || `exit ${code}`}`,
          ),
        );
      }
    });
  });

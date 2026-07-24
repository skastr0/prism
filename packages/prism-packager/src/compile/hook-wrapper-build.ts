export const buildHookWrapperWithBun = (
  entry: string,
  outdir: string,
  label: string,
): Promise<void> =>
  Bun.build({
    entrypoints: [entry],
    outdir,
    target: "node",
    format: "esm",
    packages: "bundle",
    naming: "wrapper.mjs",
    sourcemap: "none",
  }).then((build) => {
    if (build.success) return;
    const diagnostics = build.logs.map((log) => log.message).join("\n").trim();
    throw new Error(
      `failed to build ${label} hook wrapper with bun build: ${diagnostics || "unknown build failure"}`,
    );
  });

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

let cachedBunExecutable: string | undefined;

const pathExists = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

const isBunExecutableName = (path: string): boolean => /^(?:bun|bun\.exe)$/iu.test(basename(path));

const normalizeBunExecutablePath = (path: string | undefined): string | undefined => {
  if (!path || !path.startsWith("/") || !pathExists(path)) return undefined;
  if (!isBunExecutableName(path)) return undefined;
  try {
    const realPath = realpathSync(path);
    return isBunExecutableName(realPath) ? realPath : undefined;
  } catch {
    return path;
  }
};

const commandOutput = (command: string, args: ReadonlyArray<string>): string | undefined => {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const bunFromMiseShim = (path: string | undefined): string | undefined => {
  if (!path || !/(?:^|[/\\])shims[/\\]bun(?:\.exe)?$/iu.test(path)) return undefined;
  return normalizeBunExecutablePath(join(dirname(dirname(path)), "installs", "bun", "latest", "bin", "bun"));
};

export const resolveBunExecutable = (): string => {
  if (cachedBunExecutable) return cachedBunExecutable;

  const currentProcess = /(?:^|[/\\])bun(?:\.exe)?$/iu.test(process.execPath)
    ? normalizeBunExecutablePath(process.execPath)
    : undefined;
  const fromMise = normalizeBunExecutablePath(commandOutput("mise", ["which", "bun"]));
  const pathOutput = commandOutput("/usr/bin/which", ["bun"]);
  const fromMiseShim = bunFromMiseShim(pathOutput);
  const fromPath = normalizeBunExecutablePath(pathOutput);

  cachedBunExecutable = currentProcess ?? fromMise ?? fromMiseShim ?? fromPath ?? "bun";
  return cachedBunExecutable;
};

/**
 * Filesystem utilities using Bun APIs
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return resolve(path);
}

/**
 * Check if a path exists (file or directory)
 */
export async function exists(path: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if path is a directory
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * Read file contents as string
 */
export async function readFile(path: string): Promise<string> {
  const file = Bun.file(path);
  return file.text();
}

/**
 * Read and parse JSON file
 */
export async function readJson<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  return file.json() as Promise<T>;
}

/**
 * Write string content to file
 */
export async function writeFile(
  path: string,
  content: string,
  options: { readonly mode?: number } = {}
): Promise<void> {
  await ensureDir(dirname(path));
  await Bun.write(path, content);
  if (options.mode !== undefined) {
    await chmodFile(path, options.mode);
  }
}

export async function chmodFile(path: string, mode: number): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.chmod(path, mode).catch(() => undefined);
}

/**
 * Copy a file from source to target
 */
export async function copyFile(
  source: string,
  target: string
): Promise<void> {
  const fs = await import("node:fs/promises");

  await ensureDir(dirname(target));
  await fs.copyFile(source, target);

  try {
    const stat = await fs.stat(source);
    await fs.chmod(target, stat.mode);
  } catch {
    // Ignore permission propagation failures on platforms that do not support chmod.
  }
}

export function pathContains(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export async function realPathContainedBy(
  rootPath: string,
  candidatePath: string,
): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const [rootRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);

  return pathContains(rootRealPath, candidateRealPath) ? candidateRealPath : null;
}

/**
 * Append content to a file (creates if doesn't exist)
 */
export async function appendFile(
  path: string,
  content: string
): Promise<void> {
  await ensureDir(dirname(path));

  let existing = "";
  if (await exists(path)) {
    existing = await readFile(path);
  }

  // Add newline separator if file has content
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  await Bun.write(path, existing + separator + content);
}

/**
 * Ensure directory exists (recursive mkdir)
 */
export async function ensureDir(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path, { recursive: true });
}

/**
 * List files in a directory (non-recursive)
 */
export async function listDir(path: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(path);
    return entries;
  } catch (error) {
    if (isRecoverableDirectoryReadError(error)) return [];
    throw error;
  }
}

/**
 * List files in a directory recursively
 */
export async function listDirRecursive(path: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const results: string[] = [];

  async function walk(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), relativePath);
        } else {
          results.push(relativePath);
        }
      }
    } catch (error) {
      if (!isRecoverableDirectoryReadError(error)) {
        throw error;
      }
    }
  }

  await walk(path);
  return results;
}

const isRecoverableDirectoryReadError = (error: unknown): boolean => {
  const code = getNodeErrorCode(error);
  return code === "ENOENT";
};

/**
 * Remove a file
 */
export async function removeFile(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  try {
    await fs.unlink(path);
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Remove a directory recursively
 */
export async function removeDir(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rm(path, { recursive: true, force: true });
}

const getNodeErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;

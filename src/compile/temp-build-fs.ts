import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const makeTempBuildRoot = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix));

export const removeTempBuildRoot = (root: string): Promise<void> =>
  rm(root, { recursive: true, force: true });

export const writeTempBuildFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<string> => {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
};

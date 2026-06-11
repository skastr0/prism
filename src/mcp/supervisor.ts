import { chmodFile, writeFile } from "../fs.js";

export const writeSupervisorTextFile = async (
  path: string,
  content: string,
  options: { readonly mode?: number } = {},
): Promise<void> => {
  await writeFile(path, content, options);
  if (options.mode !== undefined) {
    await chmodFile(path, options.mode);
  }
};

export const writeSupervisorJsonFile = async (
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {},
): Promise<void> =>
  writeSupervisorTextFile(path, `${JSON.stringify(value, null, 2)}\n`, options);

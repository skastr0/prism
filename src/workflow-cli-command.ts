import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const APP_VERSION: string | undefined;

const modulePath = fileURLToPath(import.meta.url);
const sourceModule = /[/\\]src[/\\]workflow-cli-command\.[cm]?[jt]s$/u.test(modulePath);

export const currentCliCommand = (): string[] => {
  if (sourceModule) {
    return [process.execPath, "run", join(dirname(modulePath), `cli${extname(modulePath)}`)];
  }
  if (typeof APP_VERSION === "string" && APP_VERSION.length > 0) {
    return [process.execPath];
  }
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return [process.execPath];
  }
  if (/\.[cm]?[jt]s$/u.test(entrypoint)) {
    return [process.execPath, "run", entrypoint];
  }
  return [entrypoint];
};

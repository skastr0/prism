import { createServer } from "node:net";

export const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePortValue, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate TCP port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePortValue(port));
    });
  });

export const isPortAvailable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { resolvePrismHomeForSdk } from "./prism-home-resolve";
import { udsPathFor } from "./uds-path";

const shortPrismHome = "/short/prism-home";

const socketIdentity = (prismHome: string, plugin: string, bundleHash: string): string =>
  createHash("sha256")
    .update(prismHome)
    .update("\0")
    .update(plugin)
    .update("\0")
    .update(bundleHash)
    .digest("hex")
    .slice(0, 32);

const socketRoot = `/tmp/prism-mcp-${typeof process.getuid === "function" ? process.getuid() : "user"}`;

describe("udsPathFor", () => {
  describe("path shape", () => {
    it("produces correct format with standard inputs", () => {
      const hash = "abcd1234abcd1234abcd1234abcd1234";
      const path = udsPathFor("my-plugin", hash, shortPrismHome);
      expect(path).toBe(`${shortPrismHome}/runtime/mcp/my-plugin/abcd1234abcd1234.sock`);
    });

    it("matches the durable runtime directory when the path fits", () => {
      const path = udsPathFor("auth", "deadbeefdeadbeefdeadbeefdeadbeef", shortPrismHome);
      expect(path).toMatch(/\/short\/prism-home\/runtime\/mcp\/auth\/[a-f0-9]{16}\.sock$/);
      expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(100);
    });

    it("embeds a normal explicit Prism home", () => {
      const path = udsPathFor("test", "0000000000000000", shortPrismHome);
      expect(path).toContain(shortPrismHome);
      expect(path).not.toContain("~");
    });

    it("truncates the bundle hash when the preferred path fits", () => {
      const prefix = "abcdef0123456789";
      expect(udsPathFor("plugin", `${prefix}a`, shortPrismHome)).toBe(
        udsPathFor("plugin", `${prefix}b`, shortPrismHome),
      );
    });
  });

  describe("prismHome override", () => {
    it("uses the explicit prismHome instead of raw homedir()-based ~/.prism", () => {
      const hash = "abcd1234abcd1234";
      const path = udsPathFor("my-plugin", hash, "/custom/prism-home");
      expect(path).toBe("/custom/prism-home/runtime/mcp/my-plugin/abcd1234abcd1234.sock");
      expect(path).not.toContain(resolvePrismHomeForSdk());
    });

    it("uses the SDK Prism-home resolver when prismHome is omitted", () => {
      const hash = "abcd1234abcd1234";
      const withoutOverride = udsPathFor("my-plugin", hash);
      const withUndefinedOverride = udsPathFor("my-plugin", hash, undefined);
      const withResolvedHome = udsPathFor("my-plugin", hash, resolvePrismHomeForSdk());
      expect(withoutOverride).toBe(withResolvedHome);
      expect(withUndefinedOverride).toBe(withoutOverride);
    });

    it("isolates identical plugins and bundles across Prism homes", () => {
      const first = udsPathFor("my-plugin", "abcd1234", "/tmp/first-home");
      const second = udsPathFor("my-plugin", "abcd1234", "/tmp/second-home");
      expect(first).not.toBe(second);
    });

    it("normalizes lexically-equivalent overflow roots to one socket identity", () => {
      const suffix = `${"deep/".repeat(40)}prism-home`;
      const first = udsPathFor("my-plugin", "abcd1234", `/tmp/base/../base/${suffix}`);
      const second = udsPathFor("my-plugin", "abcd1234", `/tmp/base/${suffix}/../prism-home`);
      expect(first).toBe(second);
    });
  });

  describe("determinism", () => {
    it("produces same path for same inputs", () => {
      const plugin = "stable-plugin";
      const hash = "1234567890abcdef1234567890abcdef";

      const path1 = udsPathFor(plugin, hash, shortPrismHome);
      const path2 = udsPathFor(plugin, hash, shortPrismHome);
      const path3 = udsPathFor(plugin, hash, shortPrismHome);

      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });

    it("ignores hash content beyond the first 16 characters on the preferred path", () => {
      const hash1 = "1234567890abcdef";
      const hash2 = "1234567890abcdef" + "extra_stuff_here";
      const hash3 = "1234567890abcdef" + "completely_different_tail";

      const path1 = udsPathFor("plugin", hash1, shortPrismHome);
      const path2 = udsPathFor("plugin", hash2, shortPrismHome);
      const path3 = udsPathFor("plugin", hash3, shortPrismHome);

      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });
  });

  describe("length bound enforcement", () => {
    it("allows paths under limit with typical names", () => {
      const path = udsPathFor("http-handler", "abcd1234abcd1234", shortPrismHome);
      expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(100);
    });

    it("keeps long Prism homes and plugin names below the socket limit", () => {
      const prismHome = `/a/${"deep/".repeat(80)}prism-home`;
      const plugin = `very-long-plugin-name-${"x".repeat(80)}`;
      const bundleHash = "abcd1234abcd1234";
      const path = udsPathFor(
        plugin,
        bundleHash,
        prismHome,
      );
      expect(path).toBe(`${socketRoot}/${socketIdentity(prismHome, plugin, bundleHash)}.sock`);
      expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(100);
    });

    it("uses the complete bundle hash in the overflow identity", () => {
      const prismHome = `/tmp/${"long/".repeat(40)}prism-home`;
      const prefix = "abcdef0123456789";
      expect(udsPathFor("plugin", `${prefix}a`, prismHome)).not.toBe(
        udsPathFor("plugin", `${prefix}b`, prismHome),
      );
    });

    it("path length calculation accounts for UTF-8 byte encoding", () => {
      // ASCII plugin name: 1 byte per char
      const asciiPath = udsPathFor("test", "abcd1234abcd1234", shortPrismHome);
      const asciiBytes = Buffer.byteLength(asciiPath, "utf8");
      expect(asciiBytes).toBeLessThanOrEqual(100);

      // Verify calculation is exact
      expect(asciiBytes).toBe(asciiPath.length); // ASCII is 1:1 mapping
    });

    it("stays within limit regardless of valid plugin-name length", () => {
      const path = udsPathFor("a".repeat(1_000), "0123456789abcdef", shortPrismHome);
      expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(100);
    });
  });

  describe("validation and rejection", () => {
    it("rejects plugin name with invalid characters", () => {
      expect(() => udsPathFor("plugin/name", "abcd1234abcd1234")).toThrow(
        Error
      );
      expect(() => udsPathFor("plugin.name", "abcd1234abcd1234")).toThrow(
        Error
      );
      expect(() => udsPathFor("plugin@name", "abcd1234abcd1234")).toThrow(
        Error
      );
      expect(() => udsPathFor("plugin name", "abcd1234abcd1234")).toThrow(
        Error
      );
    });

    it("accepts valid plugin names with alphanumeric, dash, underscore", () => {
      expect(() =>
        udsPathFor("valid-plugin-123", "abcd1234abcd1234")
      ).not.toThrow();
      expect(() =>
        udsPathFor("valid_plugin_123", "abcd1234abcd1234")
      ).not.toThrow();
      expect(() => udsPathFor("ValidPlugin", "abcd1234abcd1234")).not.toThrow();
      expect(() => udsPathFor("v1", "abcd1234abcd1234")).not.toThrow();
    });

    it("rejects empty plugin name", () => {
      expect(() => udsPathFor("", "abcd1234abcd1234")).toThrow(Error);
    });
  });

  describe("hash handling", () => {
    it("works with full-length hash (64 hex chars)", () => {
      const fullHash = "a".repeat(64);
      const path = udsPathFor("plugin", fullHash, shortPrismHome);
      expect(path).toContain("/" + "a".repeat(16) + ".sock");
    });

    it("works with short hash", () => {
      const shortHash = "abc123";
      const path = udsPathFor("plugin", shortHash, shortPrismHome);
      expect(path).toContain("/abc123.sock");
    });

    it("handles empty hash string", () => {
      const path = udsPathFor("plugin", "", shortPrismHome);
      expect(path).toContain("/.sock");
    });
  });
});

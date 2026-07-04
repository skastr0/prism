import { describe, it, expect } from "bun:test";
import { udsPathFor, UDSPathLengthError } from "./uds-path";
import { homedir } from "os";

describe("udsPathFor", () => {
  describe("path shape", () => {
    it("produces correct format with standard inputs", () => {
      const path = udsPathFor("my-plugin", "abcd1234abcd1234abcd1234abcd1234");
      const home = homedir();
      expect(path).toBe(`${home}/.prism/runtime/mcp/my-plugin/abcd1234abcd1234.sock`);
    });

    it("matches expected directory structure", () => {
      const path = udsPathFor("auth", "deadbeefdeadbeefdeadbeefdeadbeef");
      expect(path).toMatch(/\.prism\/runtime\/mcp\/auth\/[a-f0-9]{16}\.sock$/);
    });

    it("expands tilde to home directory", () => {
      const path = udsPathFor("test", "0000000000000000");
      expect(path).toContain(homedir());
      expect(path).not.toContain("~");
    });

    it("truncates hash to first 16 hex characters", () => {
      const longHash = "abcdef0123456789" + "ffffffffffffffff";
      const path = udsPathFor("plugin", longHash);
      expect(path).toContain("/abcdef0123456789.sock");
    });
  });

  describe("determinism", () => {
    it("produces same path for same inputs", () => {
      const plugin = "stable-plugin";
      const hash = "1234567890abcdef1234567890abcdef";

      const path1 = udsPathFor(plugin, hash);
      const path2 = udsPathFor(plugin, hash);
      const path3 = udsPathFor(plugin, hash);

      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });

    it("ignores hash content beyond first 16 characters", () => {
      const hash1 = "1234567890abcdef";
      const hash2 = "1234567890abcdef" + "extra_stuff_here";
      const hash3 = "1234567890abcdef" + "completely_different_tail";

      const path1 = udsPathFor("plugin", hash1);
      const path2 = udsPathFor("plugin", hash2);
      const path3 = udsPathFor("plugin", hash3);

      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });
  });

  describe("length bound enforcement", () => {
    it("allows paths under limit with typical names", () => {
      const path = udsPathFor("http-handler", "abcd1234abcd1234");
      expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(100);
    });

    it("rejects path when plugin name causes overflow", () => {
      // Construct a plugin name long enough to push over the limit
      // Each character is 1 byte; with home path + structure, we need ~60+ char plugin
      const longPlugin = "very-long-plugin-name-" + "x".repeat(60);

      expect(() => udsPathFor(longPlugin, "abcd1234abcd1234")).toThrow(
        UDSPathLengthError
      );
    });

    it("long plugin name error includes path length and attempted path", () => {
      const longPlugin = "x".repeat(80);

      try {
        udsPathFor(longPlugin, "abcd1234abcd1234");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UDSPathLengthError);
        if (err instanceof UDSPathLengthError) {
          expect(err.message).toContain("exceeds");
          expect(err.message).toContain("100-byte");
          expect(err.attemptedPath).toContain(longPlugin);
        }
      }
    });

    it("path length calculation accounts for UTF-8 byte encoding", () => {
      // ASCII plugin name: 1 byte per char
      const asciiPath = udsPathFor("test", "abcd1234abcd1234");
      const asciiBytes = Buffer.byteLength(asciiPath, "utf8");
      expect(asciiBytes).toBeLessThanOrEqual(100);

      // Verify calculation is exact
      expect(asciiBytes).toBe(asciiPath.length); // ASCII is 1:1 mapping
    });

    it("stays within limit with maximum-length valid plugin name", () => {
      // Find the longest valid plugin name that still fits
      let plugin = "a-plugin";
      while (Buffer.byteLength(
        `${homedir()}/.prism/runtime/mcp/${plugin}/0123456789abcdef.sock`,
        "utf8"
      ) <= 100) {
        plugin += "a";
      }
      // Remove last char to get just under limit
      plugin = plugin.slice(0, -1);

      const path = udsPathFor(plugin, "0123456789abcdef");
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

    it("throws specific UDSPathLengthError type for path overflow", () => {
      const longPlugin = "x".repeat(80);

      try {
        udsPathFor(longPlugin, "abcd1234abcd1234");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UDSPathLengthError);
        expect((err as UDSPathLengthError).kind).toBe("uds-path-length-error");
      }
    });
  });

  describe("hash handling", () => {
    it("works with full-length hash (64 hex chars)", () => {
      const fullHash = "a".repeat(64);
      const path = udsPathFor("plugin", fullHash);
      expect(path).toContain("/" + "a".repeat(16) + ".sock");
    });

    it("works with short hash", () => {
      const shortHash = "abc123";
      const path = udsPathFor("plugin", shortHash);
      expect(path).toContain("/abc123.sock");
    });

    it("handles empty hash string", () => {
      const path = udsPathFor("plugin", "");
      expect(path).toContain("/.sock");
    });
  });
});

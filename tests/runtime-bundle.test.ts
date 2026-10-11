import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { minifyRuntimeBundle, minifyRuntimeSource } from "../tools/runtime-bundle.ts";

const globals = globalThis as typeof globalThis & { __runtimeBundleProbe?: number };

afterEach(() => {
  delete globals.__runtimeBundleProbe;
});

describe("runtime bundle finalizer", () => {
  test("preserves global behavior while removing comments and whitespace", () => {
    const source = `
      // a production bundle comment
      (() => {
        const left = 20;
        const right = 22;
        globalThis.__runtimeBundleProbe = left + right;
      })();
    `;
    const output = minifyRuntimeSource(source);
    expect(output.length).toBeLessThan(source.length);
    expect(output).not.toContain("production bundle comment");
    expect(minifyRuntimeSource(output)).toBe(output);
    Function(output)();
    expect(globals.__runtimeBundleProbe).toBe(42);
  });

  test("finalizes a built bundle in place", () => {
    const directory = mkdtempSync(join(import.meta.dir, ".runtime-bundle-"));
    const path = join(directory, "main.js");
    const source = `
      // frame export retained by the finalizer guard
      globalThis.frame = () => 42;
    `;
    try {
      writeFileSync(path, source);
      const sizes = minifyRuntimeBundle(path);
      const output = readFileSync(path, "utf8");
      expect(sizes).toEqual({ before: Buffer.byteLength(source), after: Buffer.byteLength(output) });
      expect(sizes.after).toBeLessThan(sizes.before);
      expect(output).toContain("globalThis.frame");
      expect(output).not.toContain("frame export retained");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

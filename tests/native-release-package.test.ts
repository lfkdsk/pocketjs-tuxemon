import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  POCKET_SECTION,
  encodePocketPackage,
  type PocketPackageSection,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/pocket-package.ts";
import { quickJsEngineAbiForTarget } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/quickjs-bytecode.ts";
import { assertNativeReleasePackage } from "../tools/native-release-package.ts";

const scratch: string[] = [];
const desktopTarget = process.platform === "darwin" ? "macos-app" : "linux-app";
const nativeTargets = [desktopTarget, "psp"] as const;
const root = resolve(import.meta.dir, "..");

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function bytecodeEnvelope(target: string, payload = new Uint8Array([1, 2, 3])): Uint8Array {
  const abi = quickJsEngineAbiForTarget(target);
  if (!abi) throw new Error(`test target ${target} has no QuickJS ABI`);
  const digest = Uint8Array.from(
    abi.sha256.slice("sha256:".length).match(/../g)!,
    (hex) => Number.parseInt(hex, 16),
  );
  const bytes = new Uint8Array(48 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43424a51, true); // QJBC
  view.setUint32(4, 1, true);
  view.setUint32(8, 48, true);
  view.setUint32(12, 0, true);
  bytes.set(digest, 16);
  bytes.set(payload, 48);
  return bytes;
}

function release(target: string, sections: PocketPackageSection[]): string {
  const scratchRoot = join(root, ".pocket", "test-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "native-release-"));
  scratch.push(directory);
  const path = join(directory, "release.pocket");
  writeFileSync(path, encodePocketPackage({
    manifest: new TextEncoder().encode("{}"),
    variants: [{ target, hostAbi: 1, sections }],
  }));
  return path;
}

const source = new TextEncoder().encode("globalThis.frame=()=>0;\0");

describe("native release package gate", () => {
  test("native release scripts opt in while Web stays on source JavaScript", () => {
    for (const name of ["desktop.ts", "psp.ts"]) {
      expect(readFileSync(join(root, "tools", name), "utf8"))
        .toContain("writeNativeReleasePackage");
    }
    const web = readFileSync(join(root, "tools", "web.ts"), "utf8");
    expect(web).not.toContain("writeNativeReleasePackage");
    expect(web).not.toContain("--bytecode");
    const packager = readFileSync(
      join(root, "tools", "native-release-package.ts"),
      "utf8",
    );
    expect(packager).toMatch(/packageNativeArtifacts\(\{[\s\S]*?bytecode:\s*true,/);
  });

  test("recognises target bytecode while retaining the source fallback", () => {
    for (const target of nativeTargets) {
      const result = assertNativeReleasePackage(release(target, [
        { kind: POCKET_SECTION.js, bytes: source },
        { kind: POCKET_SECTION.bytecode, bytes: bytecodeEnvelope(target) },
      ]), target);

      expect(result.sourceBytes).toBe(source.byteLength - 1);
      expect(result.bytecodeBytes).toBe(3);
      expect(result.engineAbi).toBe(quickJsEngineAbiForTarget(target)!.sha256);
    }
  });

  test("fails a source-only publication when the bytecode opt-in is omitted", () => {
    for (const target of nativeTargets) {
      const path = release(target, [{ kind: POCKET_SECTION.js, bytes: source }]);
      expect(() => assertNativeReleasePackage(path, target)).toThrow(
        "missing QuickJS bytecode; pass --bytecode",
      );
    }
  });

  test("rejects bytecode-only and wrong-engine publications", () => {
    for (const target of nativeTargets) {
      expect(() => assertNativeReleasePackage(release(target, [
        { kind: POCKET_SECTION.bytecode, bytes: bytecodeEnvelope(target) },
      ]), target)).toThrow("source fallback");

      const wrongAbi = bytecodeEnvelope(target);
      wrongAbi[16] ^= 0xff;
      expect(() => assertNativeReleasePackage(release(target, [
        { kind: POCKET_SECTION.js, bytes: source },
        { kind: POCKET_SECTION.bytecode, bytes: wrongAbi },
      ]), target)).toThrow("QuickJS engine ABI drifted");
    }
  });
});

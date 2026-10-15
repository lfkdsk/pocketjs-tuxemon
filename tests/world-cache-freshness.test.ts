import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { writeDesktopBuildReceipt } from "../tools/desktop-build-receipt.ts";

const ROOT = resolve(import.meta.dir, "..");
const APP_ID = "dev.example.world-cache-freshness";
const OUTPUT = "pocket-tuxemon";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SCRIPTS = [
  "tools/verify-world-cache-quickjs.sh",
  "tools/bench-cotton-quickjs.sh",
] as const;
const scratch: string[] = [];

interface Fixture {
  readonly root: string;
  readonly appDist: string;
  readonly bundle: string;
  readonly startupPak: string;
  readonly nativePackage: string;
  readonly projectShell: string;
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function shell(hash: string): string {
  return JSON.stringify({ format: "rpgkit-project/v1", mapManifestHash: hash }) + "\n";
}

function fixture(): Fixture {
  const scratchRoot = join(ROOT, ".pocket", "test-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "world-cache-freshness-"));
  scratch.push(root);
  const appDist = join(root, "dist", "linux-app");
  const data = join(root, "dist", "runtime-data", APP_ID, "data", "l10n");
  const bundle = join(appDist, `${OUTPUT}.js`);
  const startupPak = join(appDist, `${OUTPUT}.pak`);
  const nativePackage = join(appDist, `${OUTPUT}.pocket`);
  const projectShell = join(root, "dist", "project-shell.json");
  const chineseProjectShell = join(root, "dist", "project-shell.zh_CN.json");
  mkdirSync(appDist, { recursive: true });
  mkdirSync(join(data, "en_US"), { recursive: true });
  mkdirSync(join(data, "zh_CN"), { recursive: true });
  writeFileSync(join(root, "pocket.json"), JSON.stringify({
    id: APP_ID,
    app: { output: OUTPUT },
  }) + "\n");
  // Deliberately omit HASH_A: reverting the production check to grep the JS
  // bundle must make the fresh-fixture test fail.
  writeFileSync(bundle, "globalThis.frame = () => 0;\n");
  writeFileSync(startupPak, new Uint8Array([80, 65, 75, 0]));
  writeFileSync(nativePackage, new Uint8Array([80, 67, 75, 84]));
  writeFileSync(projectShell, shell(HASH_A));
  writeFileSync(chineseProjectShell, shell("c".repeat(64)));
  writeFileSync(join(data, "en_US", "project-shell.json"), readFileSync(projectShell));
  writeFileSync(
    join(data, "zh_CN", "project-shell.json"),
    readFileSync(chineseProjectShell),
  );
  writeDesktopBuildReceipt({
    inputRoot: root,
    appDist,
    target: "linux-app",
    appId: APP_ID,
    output: OUTPUT,
  });
  return { root, appDist, bundle, startupPak, nativePackage, projectShell };
}

function run(script: typeof SCRIPTS[number], value: Fixture) {
  const result = Bun.spawnSync(["bash", join(ROOT, script)], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORLD_CACHE_INPUT_ROOT: value.root,
      WORLD_CACHE_DIST: value.appDist,
      WORLD_CACHE_BENCH_ROOT: join(value.root, "bench"),
      WORLD_CACHE_FRESHNESS_ONLY: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("world-cache desktop build freshness", () => {
  test("both public validators accept sidecar shells without embedding their hash in JS", () => {
    const value = fixture();
    expect(readFileSync(value.bundle, "utf8")).not.toContain(HASH_A);
    for (const script of SCRIPTS) {
      const result = run(script, value);
      expect(result, script).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout, script).toContain("desktop build is fresh");
    }
  });

  test("both public validators reject a generated shell newer than data.fs", () => {
    const value = fixture();
    writeFileSync(value.projectShell, shell(HASH_B));
    for (const script of SCRIPTS) {
      const result = run(script, value);
      expect(result.exitCode, script).toBe(1);
      expect(result.stderr, script).toContain("stale relative to project-shell.json");
      expect(result.stdout, script).not.toContain("desktop build is fresh");
    }
  });

  test("the receipt rejects independently replaced JavaScript, pak and native package files", () => {
    const value = fixture();
    for (const path of [value.bundle, value.startupPak, value.nativePackage]) {
      const original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from([1])]));
      for (const script of SCRIPTS) {
        const result = run(script, value);
        expect(result.exitCode, `${script}: ${path}`).toBe(1);
        expect(result.stderr, `${script}: ${path}`).toContain(
          "receipt does not match the current bundle, pak, native package and project shells",
        );
      }
      writeFileSync(path, original);
    }
  });
});

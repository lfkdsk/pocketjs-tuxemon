// Build a readable copy of the production entry and place native-clock
// checkpoints at Bun's emitted module boundaries. The normal shipped bundle
// stays fully minified; this diagnostic copy is consumed only by the QuickJS
// startup harness with G6_STARTUP_PROFILE=1.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MODULE_BOUNDARY = /^  \/\/ (.+\.(?:c?js|mjs|json|ts|tsx))\r?$/gm;
const END_MARKER = "__end__";

export interface InstrumentedStartupModules {
  source: string;
  modules: string[];
}

export function instrumentStartupModules(source: string): InstrumentedStartupModules {
  if (source.includes("__startupModuleEvalMark")) {
    throw new Error("startup module profile source is already instrumented");
  }
  const modules: string[] = [];
  const marked = source.replace(MODULE_BOUNDARY, (line, module: string) => {
    modules.push(module);
    return `${line}\n  globalThis.__startupModuleEvalMark(${JSON.stringify(module)});`;
  });
  if (modules.length === 0) {
    throw new Error("startup module profile found no readable Bun module boundaries");
  }
  const close = marked.lastIndexOf("\n})();");
  if (close < 0) {
    throw new Error("startup module profile expected a Bun IIFE bundle");
  }
  return {
    source:
      marked.slice(0, close) +
      `\n  globalThis.__startupModuleEvalMark(${JSON.stringify(END_MARKER)});` +
      marked.slice(close),
    modules,
  };
}

async function buildProfile(outputDir: string): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const rawDir = join(outputDir, "raw");
  const buildTool = join(
    root,
    "vendor",
    "pocket-rpgkit",
    "vendor",
    "pocketjs",
    "tools",
    "build.ts",
  );
  const productionPak = join(root, "dist", "linux-app", "pocket-tuxemon.pak");
  mkdirSync(rawDir, { recursive: true });
  const build = Bun.spawn({
    cmd: [
      process.execPath,
      buildTool,
      join(root, "main.tsx"),
      `--project-root=${root}`,
      `--outdir=${rawDir}`,
    ],
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if ((await build.exited) !== 0) {
    throw new Error("startup module profile readable build failed");
  }
  const rawPath = join(rawDir, "main.js");
  const raw = readFileSync(rawPath, "utf8");
  const instrumented = instrumentStartupModules(raw);
  const jsPath = join(outputDir, "pocket-tuxemon.js");
  const pakPath = join(outputDir, "pocket-tuxemon.pak");
  writeFileSync(jsPath, instrumented.source);
  copyFileSync(productionPak, pakPath);
  writeFileSync(
    join(outputDir, "startup-modules.json"),
    `${JSON.stringify(
      {
        rawBytes: Buffer.byteLength(raw),
        instrumentedBytes: Buffer.byteLength(instrumented.source),
        moduleCount: instrumented.modules.length,
        modules: instrumented.modules,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `startup module profile: ${instrumented.modules.length} modules, ${Buffer.byteLength(raw)} -> ${Buffer.byteLength(instrumented.source)} bytes`,
  );
  console.log(`startup module profile dist: ${outputDir}`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const outputDir = resolve(
    process.argv[2] ??
      join(process.env.TMPDIR ?? "/var/tmp", "pocket-tuxemon-startup-module-profile"),
  );
  const productionPak = join(root, "dist", "linux-app", "pocket-tuxemon.pak");
  if (!(await Bun.file(productionPak).exists())) {
    throw new Error("build the desktop application before profiling startup modules");
  }
  await buildProfile(outputDir);
}

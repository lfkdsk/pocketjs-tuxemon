// Game-owned finalization for PocketJS application JavaScript. PocketJS keeps
// its generic pass-2 output readable (`minify: false`); this shipped game
// removes comments and whitespace after asset discovery has completed so the
// QuickJS host compiles fewer source bytes at cold start.

import { readFileSync, writeFileSync } from "node:fs";

const transpiler = new Bun.Transpiler({
  loader: "js",
  minifyWhitespace: true,
});

export function minifyRuntimeSource(source: string): string {
  return transpiler.transformSync(source).trimEnd() + "\n";
}

export function minifyRuntimeBundle(path: string): { before: number; after: number } {
  const source = readFileSync(path, "utf8");
  const output = minifyRuntimeSource(source);
  if (!output.includes("globalThis.frame")) {
    throw new Error(`runtime bundle finalizer: ${path} lost the PocketJS frame export`);
  }
  if (output.length > source.length) {
    throw new Error(
      `runtime bundle finalizer: ${path} grew from ${source.length} to ${output.length} bytes`,
    );
  }
  writeFileSync(path, output);
  return { before: Buffer.byteLength(source), after: Buffer.byteLength(output) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: bun tools/runtime-bundle.ts <application.js>");
  const { before, after } = minifyRuntimeBundle(path);
  console.log(`runtime bundle: ${before} -> ${after} bytes`);
}

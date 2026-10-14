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

export async function minifyRuntimeBundle(path: string): Promise<{ before: number; after: number }> {
  const source = readFileSync(path, "utf8");
  // The first PocketJS pass must stay readable while it discovers literal
  // assets. Once that work is complete, rebundle the emitted IIFE so Bun can
  // shorten local identifiers and syntax as well as whitespace. A plain
  // Transpiler pass deliberately cannot rename top-level bindings and left
  // roughly a quarter of the shipped QuickJS source on the table.
  const result = await Bun.build({
    entrypoints: [path],
    format: "iife",
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new Error(
      `runtime bundle finalizer: ${path} failed: ${result.logs.map((log) => log.message).join("; ")}`,
    );
  }
  const artifact = result.outputs.find((candidate) => candidate.kind === "entry-point");
  if (!artifact) throw new Error(`runtime bundle finalizer: ${path} produced no JavaScript`);
  const output = (await artifact.text()).trimEnd() + "\n";
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
  const { before, after } = await minifyRuntimeBundle(path);
  console.log(`runtime bundle: ${before} -> ${after} bytes`);
}

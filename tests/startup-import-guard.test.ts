import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = resolve(root, "main.tsx");
const forbidden = new Set([
  resolve(root, "dist", "project-shell.json"),
  resolve(root, "dist", "battle-runtime-shell.json"),
]);

type SourceReader = (path: string) => string;

function resolveLocalImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.json`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
        resolve(base, "index.js"),
      ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function startupImportGraph(readSource: SourceReader = (path) => readFileSync(path, "utf8")) {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (path.endsWith(".json")) continue;
    const loader = path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : "js";
    const imports = new Bun.Transpiler({ loader }).scanImports(readSource(path));
    for (const imported of imports) {
      const resolved = resolveLocalImport(path, imported.path);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

function assertStartupShellsStayExternal(readSource?: SourceReader): void {
  const graph = startupImportGraph(readSource);
  const bundled = [...forbidden].filter((path) => graph.has(path));
  if (bundled.length > 0) {
    throw new Error(
      `startup shells must be read from data.fs, not imported into the main bundle: ${bundled.join(", ")}`,
    );
  }
}

describe("startup import graph", () => {
  test("keeps English project and battle shells out of the main bundle", () => {
    const graph = startupImportGraph();
    expect(graph.size).toBeGreaterThan(200);
    assertStartupShellsStayExternal();
  });

  test("fails when a deferred shell is statically imported at the entry", () => {
    const normal: SourceReader = (path) => readFileSync(path, "utf8");
    const mutated: SourceReader = (path) =>
      path === entry
        ? `${normal(path)}\nimport startupRegression from "./dist/project-shell.json";\nvoid startupRegression;\n`
        : normal(path);
    expect(() => assertStartupShellsStayExternal(mutated)).toThrow(
      "startup shells must be read from data.fs",
    );
  });
});

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve, sep } from "node:path";

import { SERVER_RUNTIME_DECLARATION } from "./server-runtime-declaration.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ENTRY = resolve(ROOT, "battle/server-runtime.ts");
const SHARED_NAMES = resolve(ROOT, "battle/battle-names.ts");
const SERVER_NAMES = resolve(ROOT, "battle/server-battle-names.ts");
const OUTPUT = resolve(ROOT, "server-runtime/index.mjs");
const DECLARATION_OUTPUT = resolve(ROOT, "server-runtime/index.d.mts");

const ASSET_EXTENSIONS = new Set([
  ".bin", ".bmp", ".gif", ".jpeg", ".jpg", ".mp3", ".ogg", ".pak", ".png",
  ".svg", ".wav", ".webp", ".yaml", ".yml",
]);

export interface ServerRuntimeBoundaryViolation {
  code: "ASSET_INPUT" | "BUN_HOST" | "NODE_HOST" | "UI_INPUT" | "UNBUNDLED_IMPORT";
  path: string;
  importer?: string;
}

export interface ServerRuntimeBuild {
  bytes: Uint8Array;
  declarationBytes: Uint8Array;
  sha256: string;
  metafile: NonNullable<Awaited<ReturnType<typeof Bun.build>>["metafile"]>;
  inputs: string[];
  aliasCount: number;
  violations: ServerRuntimeBoundaryViolation[];
}

const DECLARATION_IMPORT = /\bimport\b/;
const DECLARATION_EXPORT_FROM =
  /\bexport\s+(?:type\s+)?(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\})\s+from\s*["']/m;
const DECLARATION_REFERENCE = /\/\/\/\s*<reference\b/i;

function slash(path: string): string {
  return path.split(sep).join("/");
}

function local(path: string): string {
  const absolute = resolve(path);
  const fromRoot = relative(ROOT, absolute);
  return fromRoot.startsWith("..") ? slash(absolute) : slash(fromRoot);
}

export function assertServerRuntimeBoundary(build: ServerRuntimeBuild): void {
  if (build.aliasCount < 1) throw new Error("server runtime build did not apply the battle-names alias");
  if (build.inputs.includes("battle/battle-names.ts")) {
    throw new Error("server runtime build retained the shared UI-aware battle-names module");
  }
  if (!build.inputs.includes("battle/server-battle-names.ts")) {
    throw new Error("server runtime build did not include the pure battle-names replacement");
  }
  if (build.violations.length > 0) {
    throw new Error(`server runtime boundary violation: ${JSON.stringify(build.violations)}`);
  }
  const declaration = new TextDecoder().decode(build.declarationBytes);
  if (DECLARATION_IMPORT.test(declaration)) {
    throw new Error("server runtime declaration contains an import");
  }
  if (DECLARATION_EXPORT_FROM.test(declaration)) {
    throw new Error("server runtime declaration contains an export-from");
  }
  if (DECLARATION_REFERENCE.test(declaration)) {
    throw new Error("server runtime declaration contains a triple-slash reference");
  }
}

export async function bundleServerRuntime(entry = DEFAULT_ENTRY): Promise<ServerRuntimeBuild> {
  let aliasCount = 0;
  const result = await Bun.build({
    entrypoints: [entry],
    format: "esm",
    target: "browser",
    minify: true,
    sourcemap: "none",
    metafile: true,
    naming: "index.mjs",
    plugins: [{
      name: "arena-server-pure-battle-names",
      setup(build) {
        build.onResolve({ filter: /(?:^|\/)battle-names\.ts$/ }, (args) => {
          const resolved = resolve(args.resolveDir, args.path);
          if (resolved !== SHARED_NAMES) return undefined;
          aliasCount++;
          return { path: SERVER_NAMES };
        });
      },
    }],
  });
  if (!result.success) {
    throw new Error(`server runtime build failed: ${result.logs.map(String).join("\n")}`);
  }
  const metafile = result.metafile;
  if (!metafile) throw new Error("server runtime build produced no metafile");
  const output = result.outputs.find((candidate) => candidate.kind === "entry-point");
  if (!output) throw new Error("server runtime build produced no entry point");
  const bytes = new Uint8Array(await output.arrayBuffer());
  const inputs = Object.keys(metafile.inputs).map(local).sort();
  const violations: ServerRuntimeBoundaryViolation[] = [];
  for (const [input, metadata] of Object.entries(metafile.inputs)) {
    const path = local(input);
    const padded = `/${path}`;
    if (/(^|\/)ui\//.test(path)) violations.push({ code: "UI_INPUT", path });
    if (padded.includes("/assets/") || padded.includes("/dist/") ||
        ASSET_EXTENSIONS.has(extname(path).toLowerCase())) {
      violations.push({ code: "ASSET_INPUT", path });
    }
    for (const imported of metadata.imports) {
      if (imported.path.startsWith("node:")) {
        violations.push({ code: "NODE_HOST", path: imported.path, importer: path });
      } else if (imported.path === "bun" || imported.path.startsWith("bun:")) {
        violations.push({ code: "BUN_HOST", path: imported.path, importer: path });
      }
    }
  }
  const source = new TextDecoder().decode(bytes);
  if (/(?:^|[;}])\s*import(?:\s|\()/.test(source) || /\brequire\s*\(/.test(source)) {
    violations.push({ code: "UNBUNDLED_IMPORT", path: output.path });
  }
  return {
    bytes,
    declarationBytes: new TextEncoder().encode(SERVER_RUNTIME_DECLARATION),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metafile,
    inputs,
    aliasCount,
    violations,
  };
}

if (import.meta.main) {
  const built = await bundleServerRuntime();
  assertServerRuntimeBoundary(built);
  await Bun.write(OUTPUT, built.bytes);
  await Bun.write(DECLARATION_OUTPUT, built.declarationBytes);
  console.log(`server runtime: ${built.bytes.byteLength} bytes sha256=${built.sha256}`);
}

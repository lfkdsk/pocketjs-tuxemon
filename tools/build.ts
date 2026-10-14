// Build the generated G6 project against the PocketJS pinned by RPG Kit.

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { minifyRuntimeBundle } from "./runtime-bundle.ts";

const root = resolve(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });

const generated = Bun.spawn({
  cmd: [process.execPath, join(root, "gen-assets.ts")],
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
if (await generated.exited !== 0) process.exit(1);

const buildTs = join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs", "tools", "build.ts");
const build = Bun.spawn({
  cmd: [process.execPath, buildTs, join(root, "main.tsx"), `--project-root=${root}`, `--outdir=${join(root, "dist")}`],
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
const exitCode = await build.exited;
if (exitCode === 0) {
  // The entrypoint build derives its output name from main.tsx. Targeted
  // desktop/web/PSP builds use their manifest's pocket-tuxemon name instead.
  const bundle = await minifyRuntimeBundle(join(root, "dist", "main.js"));
  console.log(`runtime bundle: ${bundle.before} -> ${bundle.after} bytes`);
  copyFileSync(
    join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
    join(root, "dist", "AUDIO-ATTRIBUTIONS.md"),
  );
}
process.exit(exitCode);

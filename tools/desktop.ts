// Build and launch Pocket Tuxemon in PocketJS's portable desktop host.

import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { desktopHostFeatures } from "../vendor/pocket-rpgkit/tools/lib/desktop.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/manifest/resolve.ts";

const root = resolve(import.meta.dir, "..");
const pocketjs = join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs");
const target = process.platform === "darwin" ? "macos-app" : "linux-app";
const argv = process.argv.slice(2);
const buildOnly = argv.includes("--build-only");
// --lang zh (or --lang=zh) selects the Chinese content: it is staged as
// data.fs lang.json (the bundle reads it at boot) and stripped from the
// passthrough so the host's flag parser never sees it.
let lang: string | undefined;
const passthrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--build-only" || arg === "--") continue;
  if (arg === "--lang") { lang = argv[++i]; continue; }
  if (arg.startsWith("--lang=")) { lang = arg.slice("--lang=".length); continue; }
  passthrough.push(arg);
}
if (lang !== undefined && lang !== "zh" && lang !== "zh_CN" && lang !== "en" && lang !== "en_US") {
  throw new Error(`desktop: unsupported --lang '${lang}' (use zh or en)`);
}

await $`bun ${join(root, "gen-assets.ts")}`.cwd(root);
const manifest = await Bun.file(join(root, "pocket.json")).json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `desktop: pocket.json did not resolve against ${target}: ` +
      resolution.diagnostics.map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`).join("; "),
  );
}
const plan = resolution.plan;
const outdir = join(root, "dist", target);
mkdirSync(outdir, { recursive: true });
const dataRoot = join(root, "dist", "runtime-data");
const mapData = join(dataRoot, plan.app.id, "data", "maps");
rmSync(mapData, { recursive: true, force: true });
mkdirSync(resolve(mapData, ".."), { recursive: true });
cpSync(join(root, "dist", "maps"), mapData, { recursive: true });
// GP1: the sharded battle-runtime tables (monsters/techniques/items/
// statuses) are read the same way as maps — readFileSync from data.fs on
// desktop, since fsHost() selects that path over the pak.
const battleData = join(dataRoot, plan.app.id, "data", "battle");
rmSync(battleData, { recursive: true, force: true });
mkdirSync(resolve(battleData, ".."), { recursive: true });
cpSync(join(root, "dist", "battle"), battleData, { recursive: true });
// GP1 fix 1: the sharded animated-tile table (dist/animated/<mapId>.json)
// and per-NPC sprite table (dist/npc-src/<npcId>.json) are read the same
// way — readFileSync from data.fs on desktop.
const animatedData = join(dataRoot, plan.app.id, "data", "animated");
rmSync(animatedData, { recursive: true, force: true });
mkdirSync(resolve(animatedData, ".."), { recursive: true });
cpSync(join(root, "dist", "animated"), animatedData, { recursive: true });
const npcSrcData = join(dataRoot, plan.app.id, "data", "npc-src");
rmSync(npcSrcData, { recursive: true, force: true });
mkdirSync(resolve(npcSrcData, ".."), { recursive: true });
cpSync(join(root, "dist", "npc-src"), npcSrcData, { recursive: true });
// GP1 fix 1: the sharded terrain-stream ground/upper chunk-ref tables
// (dist/terrain-stream/{ground,upper}/<mapId>.json) are read the same way.
const terrainStreamData = join(dataRoot, plan.app.id, "data", "terrain-stream");
rmSync(terrainStreamData, { recursive: true, force: true });
mkdirSync(resolve(terrainStreamData, ".."), { recursive: true });
cpSync(join(root, "dist", "terrain-stream"), terrainStreamData, { recursive: true });
// zh_CN content: the map and battle shards the Chinese build reads, staged
// alongside the English ones so the in-game language switcher works.
const mapsZhData = join(dataRoot, plan.app.id, "data", "maps-zh");
rmSync(mapsZhData, { recursive: true, force: true });
mkdirSync(resolve(mapsZhData, ".."), { recursive: true });
cpSync(join(root, "dist", "maps-zh"), mapsZhData, { recursive: true });
const battleZhData = join(dataRoot, plan.app.id, "data", "battle-zh");
rmSync(battleZhData, { recursive: true, force: true });
mkdirSync(resolve(battleZhData, ".."), { recursive: true });
cpSync(join(root, "dist", "battle-zh"), battleZhData, { recursive: true });
// --lang stages the boot language the bundle reads from data.fs.
if (lang !== undefined) {
  const normalized = lang === "zh" ? "zh_CN" : lang === "en" ? "en_US" : lang;
  writeFileSync(join(dataRoot, plan.app.id, "data", "lang.json"), JSON.stringify({ lang: normalized }) + "\n");
}
const planPath = join(root, ".pocket", target, `${plan.app.output}.plan.json`);
mkdirSync(resolve(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
await $`bun ${join(pocketjs, "tools", "build.ts")} --plan=${planPath} --project-root=${root} --outdir=${outdir}`.cwd(root);
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(outdir, "AUDIO-ATTRIBUTIONS.md"),
);
await $`cargo build --release ${desktopHostFeatures()}`.cwd(join(pocketjs, "hosts", "desktop"));

const bin = join(pocketjs, "hosts", "desktop", "target", "release", "pocket-desktop-host");
if (buildOnly) {
  console.log(`desktop: built ${plan.app.output} for ${target} + release host (${bin})`);
  process.exit(0);
}

const flags = [
  "--app", plan.app.output,
  "--app-id", plan.app.id,
  "--title", plan.app.title,
  "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density", String(plan.viewport.rasterDensity),
  ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
  ...(plan.companions.length > 0 ? ["--companions", plan.companions.join(",")] : []),
  "--js", join(outdir, `${plan.app.output}.js`),
  "--pak", join(outdir, `${plan.app.output}.pak`),
  "--data-root", dataRoot,
];
await $`${bin} ${flags} ${passthrough}`.env({ ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" });

// Build Pocket Tuxemon's static web site and keep the audio credits readable
// beside the downloadable game. The same file also travels inside the pak.

import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { minifyRuntimeBundle } from "./runtime-bundle.ts";

const root = resolve(import.meta.dir, "..");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await run([process.execPath, join(root, "gen-assets.ts")]);
await run([
  process.execPath,
  join(root, "vendor", "pocket-rpgkit", "tools", "web.ts"),
  "--project-root=.",
  "pocket-tuxemon",
]);
const bundle = minifyRuntimeBundle(
  join(root, "dist", "web", "pocket-tuxemon", "pocket-tuxemon.js"),
);
console.log(`runtime bundle: ${bundle.before} -> ${bundle.after} bytes`);
const gameDir = join(root, "dist", "web", "pocket-tuxemon");
await run([
  process.execPath,
  join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs", "tools", "build.ts"),
  join(root, "battle-replay.tsx"),
  "--framework=solid",
  "--density=2",
  `--project-root=${root}`,
  `--outdir=${gameDir}`,
]);
const replayBundle = minifyRuntimeBundle(join(gameDir, "battle-replay.js"));
console.log(`replay bundle: ${replayBundle.before} -> ${replayBundle.after} bytes`);

const replayControls = `
<section class="arena-replay-panel" aria-labelledby="arena-replay-title">
  <h2 id="arena-replay-title">Battle replay</h2>
  <div class="arena-replay-row" role="group" aria-label="Battle replay controls">
    <button type="button" id="arena-replay-play" aria-pressed="false" disabled>Play</button>
    <button type="button" id="arena-replay-step" disabled>Step</button>
    <span id="arena-replay-speed-label">Speed</span>
    <button type="button" id="arena-replay-speed-1" data-arena-replay-speed aria-pressed="true">1×</button>
    <button type="button" id="arena-replay-speed-2" data-arena-replay-speed aria-pressed="false">2×</button>
    <button type="button" id="arena-replay-speed-4" data-arena-replay-speed aria-pressed="false">4×</button>
    <output id="arena-replay-counter">Turn 0 / 0</output>
  </div>
  <p id="arena-replay-status" role="status" aria-live="polite">Loading battle tape…</p>
  <p id="arena-replay-help">Reads versioned JSON tapes only.</p>
</section>`;
const replayStyles = `<style>
.arena-replay-panel{max-width:60rem;margin:1rem auto;padding:1rem;border:1px solid var(--line,#5f7180);border-radius:.75rem;background:var(--panel,#17232d)}
.arena-replay-panel h2{margin-top:0}.arena-replay-row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.arena-replay-row button{min-width:3rem}.arena-replay-row output{margin-left:auto;font-variant-numeric:tabular-nums}
.arena-replay-panel p{margin:.65rem 0 0}.arena-replay-entry{text-align:center}
</style>`;

const playerPath = join(gameDir, "index.html");
const playerHtml = await Bun.file(playerPath).text();
const configPattern = /(<script type="application\/json" id="pocket-game">)(.*?)(<\/script>)/s;
const configMatch = playerHtml.match(configPattern);
if (!configMatch) throw new Error("web: generated player page has no pocket-game config");
const replayConfig = JSON.parse(configMatch[2]!) as Record<string, unknown>;
replayConfig.app = "battle-replay";
replayConfig.bundle = "battle-replay.js";
replayConfig.pak = "battle-replay.pak";
replayConfig.autosaveStorageKey = "pocket-rpgkit:battle-replay:unused:v1";
const replayHtml = playerHtml
  .replace("</head>", `${replayStyles}\n</head>`)
  .replace('<section class="info">', `${replayControls}\n<section class="info">`)
  .replace(configPattern, `$1${JSON.stringify(replayConfig).replace(/</g, "\\u003c")}$3`);
await Bun.write(join(gameDir, "replay.html"), replayHtml);
await Bun.write(
  playerPath,
  playerHtml.replace(
    '<section class="info">',
    '<p class="arena-replay-entry"><a href="replay.html">Battle replay / 对战回放</a></p>\n<section class="info">',
  ),
);
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(gameDir, "AUDIO-ATTRIBUTIONS.md"),
);

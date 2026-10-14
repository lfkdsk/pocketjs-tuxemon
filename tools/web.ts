// Build Pocket Tuxemon's static web site and keep the audio credits readable
// beside the downloadable game. The same file also travels inside the pak.

import { copyFileSync, readFileSync } from "node:fs";
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
const bundle = await minifyRuntimeBundle(
  join(root, "dist", "web", "pocket-tuxemon", "pocket-tuxemon.js"),
);
console.log(`runtime bundle: ${bundle.before} -> ${bundle.after} bytes`);
const gameDir = join(root, "dist", "web", "pocket-tuxemon");
const ordinaryBundlePath = join(gameDir, "pocket-tuxemon.js");
const ordinaryPakPath = join(gameDir, "pocket-tuxemon.pak");
// This is the completed ordinary build before either optional replay entry is
// compiled. Keep its bytes so the same Web job proves entry-graph isolation.
const ordinaryBundleBytes = readFileSync(ordinaryBundlePath);
const ordinaryPakBytes = readFileSync(ordinaryPakPath);
await run([
  process.execPath,
  join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs", "tools", "build.ts"),
  join(root, "battle-replay.tsx"),
  "--framework=solid",
  "--density=2",
  `--project-root=${root}`,
  `--outdir=${gameDir}`,
]);
const replayBundle = await minifyRuntimeBundle(join(gameDir, "battle-replay.js"));
console.log(`replay bundle: ${replayBundle.before} -> ${replayBundle.after} bytes`);
await run([
  process.execPath,
  join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs", "tools", "build.ts"),
  join(root, "expedition-replay.tsx"),
  "--framework=solid",
  "--density=2",
  `--project-root=${root}`,
  `--outdir=${gameDir}`,
]);
const expeditionReplayBundle = await minifyRuntimeBundle(join(gameDir, "expedition-replay.js"));
console.log(`expedition replay bundle: ${expeditionReplayBundle.before} -> ${expeditionReplayBundle.after} bytes`);

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
const expeditionReplayControls = `
<section class="expedition-replay-panel" aria-labelledby="expedition-replay-title">
  <h2 id="expedition-replay-title">Expedition replay</h2>
  <div class="expedition-replay-row" role="group" aria-label="Expedition replay controls">
    <button type="button" id="expedition-replay-play" aria-pressed="false" disabled>Play</button>
    <button type="button" id="expedition-replay-step" disabled>Step</button>
    <span id="expedition-replay-speed-label">Speed</span>
    <button type="button" id="expedition-replay-speed-1" data-expedition-replay-speed aria-pressed="true">1×</button>
    <button type="button" id="expedition-replay-speed-2" data-expedition-replay-speed aria-pressed="false">2×</button>
    <button type="button" id="expedition-replay-speed-4" data-expedition-replay-speed aria-pressed="false">4×</button>
    <output id="expedition-replay-counter">Frame 0 / 0</output>
  </div>
  <div class="expedition-replay-timeline-row">
    <label id="expedition-replay-timeline-label" for="expedition-replay-timeline">Timeline</label>
    <input type="range" id="expedition-replay-timeline" min="0" max="0" value="0" step="1" disabled>
  </div>
  <p id="expedition-replay-status" role="status" aria-live="polite">Loading expedition journal…</p>
  <p id="expedition-replay-help">Reads public, seedless versioned JSON journals only.</p>
</section>`;
const expeditionReplayStyles = `<style>
.expedition-replay-panel{max-width:60rem;margin:1rem auto;padding:1rem;border:1px solid var(--line,#5f7180);border-radius:.75rem;background:var(--panel,#17232d)}
.expedition-replay-panel h2{margin-top:0}.expedition-replay-row,.expedition-replay-timeline-row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.expedition-replay-row button{min-width:3rem}.expedition-replay-row output{margin-left:auto;font-variant-numeric:tabular-nums}
.expedition-replay-timeline-row{margin-top:.75rem}.expedition-replay-timeline-row input{flex:1;min-width:12rem}
.expedition-replay-panel p{margin:.65rem 0 0}.arena-replay-entry{text-align:center}
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
const expeditionReplayConfig = { ...replayConfig };
expeditionReplayConfig.app = "expedition-replay";
expeditionReplayConfig.bundle = "expedition-replay.js";
expeditionReplayConfig.pak = "expedition-replay.pak";
expeditionReplayConfig.autosaveStorageKey = "pocket-rpgkit:expedition-replay:unused:v1";
const expeditionReplayHtml = playerHtml
  .replace("</head>", `${expeditionReplayStyles}\n</head>`)
  .replace('<section class="info">', `${expeditionReplayControls}\n<section class="info">`)
  .replace(configPattern, `$1${JSON.stringify(expeditionReplayConfig).replace(/</g, "\\u003c")}$3`);
await Bun.write(join(gameDir, "expedition-replay.html"), expeditionReplayHtml);
await Bun.write(
  playerPath,
  playerHtml.replace(
    '<section class="info">',
    '<p class="arena-replay-entry"><a href="replay.html">Battle replay / 对战回放</a> · <a href="expedition-replay.html">Expedition replay / 远征回放</a></p>\n<section class="info">',
  ),
);
if (!ordinaryBundleBytes.equals(readFileSync(ordinaryBundlePath))) {
  throw new Error("web: replay entries changed the ordinary game JavaScript bundle");
}
if (!ordinaryPakBytes.equals(readFileSync(ordinaryPakPath))) {
  throw new Error("web: replay entries changed the ordinary game asset pak");
}
console.log(
  `ordinary replay isolation: ${ordinaryBundleBytes.byteLength} JS bytes and ` +
  `${ordinaryPakBytes.byteLength} pak bytes unchanged`,
);
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(gameDir, "AUDIO-ATTRIBUTIONS.md"),
);

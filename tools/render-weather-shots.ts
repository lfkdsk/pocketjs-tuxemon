// Render weather particle screenshots for visual inspection, including the
// production layer-order cases: rain at night, rain behind a dialog, and
// rain behind a cross-map fade at 480x272 and 960x544.
//
// Usage: bun tools/render-weather-shots.ts
// Writes docs/screenshots/weather/*.png and a manifest with per-shot pixel stats.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import {
  fadeOpacity,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "docs/screenshots/weather");
const MANIFEST = join(OUT, "manifest.json");

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("weather shots: missing dist/main.{js,pak}; run `bun run build`");
}

const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as {
  masks: number[];
  checkpoints: { name: string; frame: number; map: string; position: [number, number] }[];
};
const checkpoint = (name: string) => {
  const found = journey.checkpoints.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`weather shots: G6 journey has no ${name} checkpoint`);
  return found;
};
const INDOOR = checkpoint("bedroom");
const OUTDOOR = checkpoint("paper-town");
const DIALOG = { frame: 1610, map: "spyder_paper_town", position: [24, 13] as [number, number] };
const TRANSFER_FADE = { frame: 1381, map: "spyder_paper_town", position: [10, 7] as [number, number] };
const TRANSFER_BLACK = { frame: 1377, map: "spyder_paper_town", position: [10, 7] as [number, number] };

const WEATHERS = ["rain", "snow", "sunny", "thunderstorm", "foggy"] as const;
const NIGHT_WEATHERS = ["sunny", "rain", "snow", "foggy"] as const;
const VIEWPORTS = [
  { name: "480x272", width: 480, height: 272 },
  { name: "960x544", width: 960, height: 544 },
] as const;
/** 22:00 sits inside the night stage (dim 0.45). */
const NIGHT_CIVIL_TIME = { ...FIXED_INITIAL_CIVIL_TIME, hour: 22, minute: 0 } as const;

interface ShotStats {
  file: string;
  sha256: string;
  meanLuminance: number;
  blueBias: number;
  /** Fraction of pixels whose blue channel leads by >40 (particle streaks). */
  blueStreak: number;
  /** Fraction of bright near-white pixels (snow/flakes/veils). */
  brightWhite: number;
}

function stats(rgba: Uint8Array, file: string, pngSha256: string): ShotStats {
  let luminance = 0;
  let blueBias = 0;
  let blueStreak = 0;
  let brightWhite = 0;
  const pixels = rgba.length / 4;
  for (let index = 0; index < rgba.length; index += 4) {
    const r = rgba[index]!;
    const g = rgba[index + 1]!;
    const b = rgba[index + 2]!;
    luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    blueBias += b - (r + g) / 2;
    if (b - r > 40 && b - g > 20 && b > 150) blueStreak++;
    if (r > 200 && g > 200 && b > 200) brightWhite++;
  }
  return {
    file,
    sha256: pngSha256,
    meanLuminance: Math.round(luminance / pixels * 1000) / 1000,
    blueBias: Math.round(blueBias / pixels * 1000) / 1000,
    blueStreak: Math.round(blueStreak / pixels * 10000) / 10000,
    brightWhite: Math.round(brightWhite / pixels * 10000) / 10000,
  };
}

async function capture(
  weather: string,
  location: { frame: number; map: string; position: [number, number] },
  viewport: { width: number; height: number },
  civilTime: { year: number; month: number; day: number; hour: number; minute: number } = FIXED_INITIAL_CIVIL_TIME,
): Promise<{ rgba: Uint8Array; state: SessionState }> {
  const world = await bootWorld(
    BUNDLE,
    60,
    {
      __pocketTuxemonInitialCivilTime: civilTime,
      __pocketTuxemonInitialWeather: { slug: weather },
    },
    undefined,
    { width: viewport.width, height: viewport.height },
  );
  for (let frame = 0; frame <= location.frame; frame++) {
    world.frame(journey.masks[frame]!);
    world.tick();
  }
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  if (!state || state.mapId !== location.map) {
    throw new Error(`weather shots: diverged at f${location.frame}: ${state?.mapId} != ${location.map}`);
  }
  return { rgba: world.render().slice(), state };
}

const shots: ShotStats[] = [];
mkdirSync(OUT, { recursive: true });

function writeShot(rgba: Uint8Array, file: string, mapId: string): void {
  const png = encodePNG(rgba, file.endsWith("960x544.png") ? 960 : 480, file.endsWith("960x544.png") ? 544 : 272);
  writeFileSync(join(OUT, file), png);
  const shot = stats(rgba, file, createHash("sha256").update(png).digest("hex"));
  shots.push(shot);
  console.log(`${file} map=${mapId} lum=${shot.meanLuminance} blue=${shot.blueBias} streak=${shot.blueStreak} white=${shot.brightWhite}`);
}

for (const viewport of VIEWPORTS) {
  for (const [locationName, location] of [["indoor", INDOOR], ["outdoor", OUTDOOR]] as const) {
    for (const weather of WEATHERS) {
      const { rgba, state } = await capture(weather, location, viewport);
      const file = `${weather}-${locationName}-${viewport.name}.png`;
      writeShot(rgba, file, state.mapId);
    }
  }
}

// Night outdoor variants show the real daylight tint composited above the
// particles at both supported logical resolutions.
for (const viewport of VIEWPORTS) {
  for (const weather of NIGHT_WEATHERS) {
    const { rgba, state } = await capture(weather, OUTDOOR, viewport, NIGHT_CIVIL_TIME);
    writeShot(rgba, `${weather}-outdoor-night-${viewport.name}.png`, state.mapId);
  }
}

// Layer sentinels from the real G6 mainline. Sunny counterparts make the
// semantic tests independent of the map pixels beneath the presentation.
for (const viewport of VIEWPORTS) {
  for (const weather of ["sunny", "rain"] as const) {
    const dialog = await capture(weather, DIALOG, viewport);
    if (dialog.state.interp.modal?.kind !== "text") {
      throw new Error(`weather shots: expected text dialog at f${DIALOG.frame}`);
    }
    writeShot(dialog.rgba, `${weather}-dialog-${viewport.name}.png`, dialog.state.mapId);

    const fade = await capture(weather, TRANSFER_FADE, viewport);
    const opacity = fadeOpacity(fade.state.fade);
    if (Math.abs(opacity - 5 / 9) > 1e-9) {
      throw new Error(`weather shots: expected 5/9 transfer fade at f${TRANSFER_FADE.frame}, got ${opacity}`);
    }
    writeShot(fade.rgba, `${weather}-transfer-fade-${viewport.name}.png`, fade.state.mapId);

    const black = await capture(weather, TRANSFER_BLACK, viewport);
    if (fadeOpacity(black.state.fade) !== 1) {
      throw new Error(`weather shots: expected opaque transfer fade at f${TRANSFER_BLACK.frame}`);
    }
    writeShot(black.rgba, `${weather}-transfer-black-${viewport.name}.png`, black.state.mapId);
  }
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
  format: "pocket-tuxemon/wx1-shots/v1",
  civil: FIXED_INITIAL_CIVIL_TIME,
  nightCivil: NIGHT_CIVIL_TIME,
  checkpoints: {
    indoor: INDOOR.name,
    outdoor: OUTDOOR.name,
    dialogFrame: DIALOG.frame,
    transferFadeFrame: TRANSFER_FADE.frame,
    transferBlackFrame: TRANSFER_BLACK.frame,
  },
  shots,
}, null, 1) + "\n");
console.log(`wrote ${shots.length} shots to ${OUT}`);

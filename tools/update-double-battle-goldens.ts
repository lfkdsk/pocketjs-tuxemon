// Regenerate the reviewed bilingual real-map double-battle screenshots.
// --inspection-out writes nearest-neighbour 3x copies outside the repository
// for manual review without bloating the committed golden set.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  captureDoubleBattle,
  doubleBattleGoldenFile,
  DOUBLE_BATTLE_CASES,
  DOUBLE_BATTLE_LANGS,
  DOUBLE_BATTLE_VIEWPORTS,
} from "./double-battle-visual-fixture.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(ROOT, "tests/goldens");
const flag = process.argv.indexOf("--inspection-out");
const argument = flag >= 0 ? process.argv[flag + 1] : undefined;
if (flag >= 0 && (!argument || argument.startsWith("--"))) {
  throw new Error("--inspection-out requires a directory");
}
const inspection = argument
  ? (isAbsolute(argument) ? argument : resolve(process.cwd(), argument))
  : null;

function nearestThreeX(source: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * 3 * height * 3 * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 4;
    for (let oy = 0; oy < 3; oy++) for (let ox = 0; ox < 3; ox++) {
      const to = ((y * 3 + oy) * width * 3 + x * 3 + ox) * 4;
      output.set(source.subarray(from, from + 4), to);
    }
  }
  return output;
}

mkdirSync(OUTPUT, { recursive: true });
if (inspection) mkdirSync(inspection, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const lang of DOUBLE_BATTLE_LANGS) {
  for (const visualCase of DOUBLE_BATTLE_CASES) {
    for (const viewport of DOUBLE_BATTLE_VIEWPORTS) {
      const capture = await captureDoubleBattle(lang, visualCase, viewport);
      const file = doubleBattleGoldenFile(lang, visualCase, viewport);
      const png = encodePNG(capture.rgba, capture.width, capture.height);
      writeFileSync(join(OUTPUT, file), png);
      frames.push({
        lang,
        case: visualCase,
        width: capture.width,
        height: capture.height,
        file,
        map: capture.map,
        opponent: capture.state.battle.opponent,
        player: capture.player,
        enemy: capture.state.battle.parties[1].map(({ slug, level }) => ({ slug, level })),
        rgbaFnv1a: fnv1a(capture.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
      });
      console.log(`${lang} ${visualCase} ${capture.width}x${capture.height}: rgba=${fnv1a(capture.rgba)} -> tests/goldens/${file}`);

      if (inspection) {
        const inspectionFile = file.replace(/\.png$/, ".3x.png");
        const scaled = nearestThreeX(capture.rgba, capture.width, capture.height);
        writeFileSync(
          join(inspection, inspectionFile),
          encodePNG(scaled, capture.width * 3, capture.height * 3),
        );
        console.log(`inspection ${capture.width * 3}x${capture.height * 3} -> ${join(inspection, inspectionFile)}`);
      }
    }
  }
}

writeFileSync(join(ROOT, "data/double-battle-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/double-battle-goldens/v1",
  frames,
}, null, 2) + "\n");

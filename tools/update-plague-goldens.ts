// Regenerate inspected bilingual Spyder Bite narration screenshots. Passing
// --inspection-out writes nearest-neighbour 3x copies outside the repository
// for manual review without bloating the committed golden set.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  capturePlague,
  plagueGoldenFile,
  PLAGUE_VISUAL_CASES,
  PLAGUE_VISUAL_LANGS,
  PLAGUE_VISUAL_VIEWPORTS,
} from "./plague-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
const inspectionFlag = process.argv.indexOf("--inspection-out");
const inspectionArgument = inspectionFlag >= 0 ? process.argv[inspectionFlag + 1] : undefined;
if (inspectionFlag >= 0 && (!inspectionArgument || inspectionArgument.startsWith("--"))) {
  throw new Error("--inspection-out requires a directory");
}
const inspectionOut = inspectionArgument
  ? (isAbsolute(inspectionArgument) ? inspectionArgument : resolve(process.cwd(), inspectionArgument))
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

mkdirSync(out, { recursive: true });
if (inspectionOut) mkdirSync(inspectionOut, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const lang of PLAGUE_VISUAL_LANGS) {
  for (const viewport of PLAGUE_VISUAL_VIEWPORTS) {
    const capture = await capturePlague(lang, viewport);
    for (const visualCase of PLAGUE_VISUAL_CASES) {
      const frame = capture.cases[visualCase];
      const file = plagueGoldenFile(lang, visualCase, viewport);
      const png = encodePNG(frame.rgba, capture.width, capture.height);
      writeFileSync(join(out, file), png);
      frames.push({
        lang,
        case: visualCase,
        width: capture.width,
        height: capture.height,
        file,
        seed: capture.seed,
        eventIndex: capture.eventIndex,
        eventTicks: frame.state.eventTicks,
        rgbaFnv1a: fnv1a(frame.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
      });
      console.log(`${lang} ${visualCase} ${capture.width}x${capture.height}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);

      if (inspectionOut) {
        const inspectionFile = file.replace(/\.png$/, ".3x.png");
        const scaled = nearestThreeX(frame.rgba, capture.width, capture.height);
        writeFileSync(
          join(inspectionOut, inspectionFile),
          encodePNG(scaled, capture.width * 3, capture.height * 3),
        );
        console.log(`inspection ${capture.width * 3}x${capture.height * 3} -> ${join(inspectionOut, inspectionFile)}`);
      }
    }
  }
}

writeFileSync(join(root, "data/plague-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/plague-goldens/v1",
  frames,
}, null, 2) + "\n");

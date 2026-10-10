// Regenerate inspected Eclipse Park encounter and settlement screenshots.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  capturePark,
  parkGoldenFile,
  PARK_VISUAL_CASES,
  PARK_VISUAL_LANGS,
  PARK_VISUAL_VIEWPORTS,
} from "./park-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const lang of PARK_VISUAL_LANGS) {
  for (const viewport of PARK_VISUAL_VIEWPORTS) {
    const capture = await capturePark(lang, viewport);
    for (const visualCase of PARK_VISUAL_CASES) {
      const frame = capture.cases[visualCase];
      const file = parkGoldenFile(lang, visualCase, viewport);
      const png = encodePNG(frame.rgba, capture.width, capture.height);
      writeFileSync(join(out, file), png);
      frames.push({
        lang,
        case: visualCase,
        width: capture.width,
        height: capture.height,
        file,
        rgbaFnv1a: fnv1a(frame.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
      });
      console.log(`${lang} ${visualCase} ${capture.width}x${capture.height}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);
    }
  }
}

writeFileSync(join(root, "data/park-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/park-goldens/v1",
  frames,
}, null, 2) + "\n");

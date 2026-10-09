// Regenerate the inspected production Dojo menu/report screenshots.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  captureDojo,
  dojoGoldenFile,
  DOJO_VISUAL_CASES,
  DOJO_VISUAL_LANGS,
  DOJO_VISUAL_VIEWPORTS,
} from "./dojo-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const lang of DOJO_VISUAL_LANGS) {
  for (const visualCase of DOJO_VISUAL_CASES) {
    for (const viewport of DOJO_VISUAL_VIEWPORTS) {
      const capture = await captureDojo(lang, visualCase, viewport);
      const file = dojoGoldenFile(lang, visualCase, viewport);
      const png = encodePNG(capture.rgba, capture.width, capture.height);
      writeFileSync(join(out, file), png);
      frames.push({
        lang,
        case: visualCase,
        width: capture.width,
        height: capture.height,
        file,
        rgbaFnv1a: fnv1a(capture.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
      });
      console.log(`${lang} ${visualCase} ${capture.width}x${capture.height}: rgba=${fnv1a(capture.rgba)} -> tests/goldens/${file}`);
    }
  }
}

writeFileSync(join(root, "data/dojo-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/dojo-goldens/v1",
  frames,
}, null, 2) + "\n");

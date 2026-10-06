// Regenerate the Tuxepedia overlay screenshots (both viewports, both
// languages, populated/unknown/caught-filter cases).
//
//   bun run build && bun tools/update-tuxepedia-goldens.ts

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import {
  captureTuxepedia,
  TUXEPEDIA_CASES,
  TUXEPEDIA_VIEWPORTS,
  type TuxepediaCase,
} from "./tuxepedia-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const LANGS = ["en_US", "zh_CN"] as const;
const frames: Array<Record<string, unknown>> = [];
for (const lang of LANGS) {
  for (const viewport of TUXEPEDIA_VIEWPORTS) {
    const capture = await captureTuxepedia(viewport, lang);
    const viewportKey = `${viewport.width}x${viewport.height}`;
    for (const visualCase of TUXEPEDIA_CASES) {
      const frame = capture.cases[visualCase as TuxepediaCase];
      const file = `tuxepedia-${visualCase}-${lang}-${viewportKey}.png`;
      const png = encodePNG(frame.rgba, viewport.width, viewport.height);
      writeFileSync(join(out, file), png);
      frames.push({
        case: visualCase,
        lang,
        ...viewport,
        file,
        rgbaFnv1a: fnv1a(frame.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
        cursor: frame.cursor,
        filter: frame.filter,
        counts: frame.counts,
      });
      console.log(`${visualCase} ${lang} ${viewportKey}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);
    }
    // Touch probe (one per viewport/lang; same expectations).
    console.log(`touch ${lang} ${viewportKey}: tap=${capture.touch.tapWorked} swipe=${capture.touch.swipeWorked}`);
  }
}

writeFileSync(join(root, "data/tuxepedia-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/tuxepedia-goldens/v1",
  frames,
}, null, 2) + "\n");
console.log(`wrote data/tuxepedia-goldens.json (${frames.length} frames)`);

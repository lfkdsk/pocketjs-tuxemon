// Regenerate title Battle and NuPhone production-bundle screenshots.
//
//   bun run build && bun run build:wasm
//   bun tools/update-feature-modes-goldens.ts

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import {
  captureFeatureModes,
  FEATURE_MODES_CASES,
  FEATURE_MODES_VIEWPORTS,
} from "./feature-modes-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const languages = ["en_US", "zh_CN"] as const;
const frames: Array<Record<string, unknown>> = [];
for (const lang of languages) {
  for (const viewport of FEATURE_MODES_VIEWPORTS) {
    const capture = await captureFeatureModes(viewport, lang);
    const viewportKey = `${viewport.width}x${viewport.height}`;
    for (const visualCase of FEATURE_MODES_CASES) {
      const frame = capture.cases[visualCase];
      const file = `feature-${visualCase}-${lang}-${viewportKey}.png`;
      const png = encodePNG(frame.rgba, viewport.width, viewport.height);
      writeFileSync(join(out, file), png);
      frames.push({
        case: visualCase,
        lang,
        ...viewport,
        file,
        rgbaFnv1a: fnv1a(frame.rgba),
        pngSha256: createHash("sha256").update(png).digest("hex"),
      });
      console.log(`${visualCase} ${lang} ${viewportKey}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);
    }
    console.log(`touch ${lang} ${viewportKey}: ${JSON.stringify(capture.touch)}`);
  }
}

writeFileSync(join(root, "data/feature-modes-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/feature-modes-goldens/v1",
  frames,
}, null, 2) + "\n");
console.log(`wrote data/feature-modes-goldens.json (${frames.length} frames)`);

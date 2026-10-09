// Regenerate the inspected production radio tuner/broadcast screenshots.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  captureRadio,
  radioGoldenFile,
  RADIO_VISUAL_CASES,
  RADIO_VISUAL_VIEWPORTS,
} from "./radio-visual-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const viewport of RADIO_VISUAL_VIEWPORTS) {
  const capture = await captureRadio(viewport);
  for (const visualCase of RADIO_VISUAL_CASES) {
    const frame = capture.cases[visualCase];
    const file = radioGoldenFile(visualCase, viewport);
    const png = encodePNG(frame.rgba, capture.width, capture.height);
    writeFileSync(join(out, file), png);
    frames.push({
      case: visualCase,
      width: capture.width,
      height: capture.height,
      file,
      rgbaFnv1a: fnv1a(frame.rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
    });
    console.log(`${visualCase} ${capture.width}x${capture.height}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);
  }
  if (!capture.touch.playWorked || !capture.touch.nextWorked || !capture.touch.returnWorked) {
    throw new Error(`radio touch probe failed at ${capture.width}x${capture.height}: ${JSON.stringify(capture.touch)}`);
  }
}

writeFileSync(join(root, "data/radio-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/radio-goldens/v1",
  frames,
}, null, 2) + "\n");

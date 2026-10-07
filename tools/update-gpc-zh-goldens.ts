// Regenerate the production-rendered zh_CN PC scene screenshots (locker
// list, quantity picker, bag, monster box, party, full/empty prompts).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { captureGpcZh, gpcZhGoldenFile, GPC_ZH_CASES, GPC_ZH_VIEWPORTS } from "./gpc-locker-zh-fixture.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "tests/goldens");
mkdirSync(out, { recursive: true });

const frames: Array<Record<string, unknown>> = [];
for (const viewport of GPC_ZH_VIEWPORTS) {
  const capture = await captureGpcZh(viewport);
  for (const visualCase of GPC_ZH_CASES) {
    const frame = capture.cases[visualCase];
    const file = gpcZhGoldenFile(visualCase, viewport);
    const png = encodePNG(frame.rgba, viewport.width, viewport.height);
    writeFileSync(join(out, file), png);
    frames.push({
      case: visualCase,
      ...viewport,
      file,
      rgbaFnv1a: fnv1a(frame.rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
    });
    console.log(`${visualCase} ${viewport.width}x${viewport.height}: rgba=${fnv1a(frame.rgba)} -> tests/goldens/${file}`);
  }
}

writeFileSync(join(root, "data/gpc-locker-zh-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/gpc-locker-zh-goldens/v1",
  frames,
}, null, 2) + "\n");

// Regenerate the five shipped-Latin-locale acceptance screenshots.
//
//   bun run build && bun run build:wasm
//   bun tools/update-locale-goldens.ts
//
// Pass --inspect-dir=<path> to also write one nearest-neighbour 3x contact
// sheet per language and viewport. Those sheets are for human review; the
// byte-stable source-resolution frames below are the committed test oracle.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Lang } from "../ui/language.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import {
  captureLocaleAcceptance,
  LOCALE_ACCEPTANCE_CASES,
  FEATURE_MODES_VIEWPORTS,
  type FeatureModesFrame,
} from "./feature-modes-visual-fixture.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "tests/goldens");
const LANGS = ["de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR"] as const satisfies readonly Lang[];
const inspectDir = process.argv.find((arg) => arg.startsWith("--inspect-dir="))?.slice("--inspect-dir=".length);

mkdirSync(OUT, { recursive: true });
if (inspectDir) mkdirSync(inspectDir, { recursive: true });

function contactSheet3x(
  frames: readonly FeatureModesFrame[],
  width: number,
  height: number,
): Uint8Array {
  const scale = 3;
  const outWidth = width * scale;
  const outHeight = height * scale * frames.length;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const source = frames[frameIndex]!.rgba;
    const top = frameIndex * height * scale;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sourceOffset = (y * width + x) * 4;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const targetOffset = (((top + y * scale + dy) * outWidth) + x * scale + dx) * 4;
            out.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
          }
        }
      }
    }
  }
  return encodePNG(out, outWidth, outHeight);
}

const frames: Array<Record<string, unknown>> = [];
const captures: Array<Record<string, unknown>> = [];
for (const lang of LANGS) {
  for (const viewport of FEATURE_MODES_VIEWPORTS) {
    const capture = await captureLocaleAcceptance(viewport, lang);
    const viewportKey = `${viewport.width}x${viewport.height}`;
    captures.push({
      lang,
      ...viewport,
      dialogLines: capture.dialogLines,
      battleMenu: capture.battleMenu,
    });
    for (const visualCase of LOCALE_ACCEPTANCE_CASES) {
      const frame = capture.cases[visualCase];
      const file = `locale-${visualCase}-${lang}-${viewportKey}.png`;
      const png = encodePNG(frame.rgba, viewport.width, viewport.height);
      writeFileSync(join(OUT, file), png);
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
    if (inspectDir) {
      const file = `locale-${lang}-${viewportKey}.3x.png`;
      const ordered = LOCALE_ACCEPTANCE_CASES.map((visualCase) => capture.cases[visualCase]);
      writeFileSync(join(inspectDir, file), contactSheet3x(ordered, viewport.width, viewport.height));
      console.log(`inspect ${lang} ${viewportKey}: ${join(inspectDir, file)}`);
    }
  }
}

writeFileSync(join(ROOT, "data/locale-visual-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/locale-visual-goldens/v1",
  caseOrder: LOCALE_ACCEPTANCE_CASES,
  captures,
  frames,
}, null, 2) + "\n");
console.log(`wrote data/locale-visual-goldens.json (${frames.length} frames)`);

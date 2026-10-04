// Render representative dialogs whose template tokens the game's resolver
// expands, at both committed viewports, for the 3x visual review.
//
//   bun run build && bun tools/render-dialog-tokens.ts [--out=<dir>] [slug-filter]
//
// Every shot boots the PRODUCTION bundle (dist/main — main.tsx's GameView
// mount with its textTokens prop), loads a save planted next to the REAL
// imported event, and triggers that event with REAL input. The kit expands
// the dialog's tokens through GameView's textTokens wiring and
// expandTextTokens exactly as in the live game; the tool never injects
// expanded text. The expanded text is read back from the live session and
// recorded in manifest.json so the visual test can assert on it. Screenshots
// land in dist/dialog-tokens/ by default; --out overrides the directory.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { BUNDLE, ROOT, bundleIsBuilt, driveDialog } from "./dialog-token-drive.ts";
import { DIALOG_SHOTS } from "./dialog-token-shots.ts";

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="));
const OUT = resolve(outArg?.slice(6) ?? join(ROOT, "dist/dialog-tokens"));
const only = args.find((a) => !a.startsWith("--out="));
const VIEWPORTS = [
  { name: "480x272", width: 480, height: 272 },
  { name: "960x544", width: 960, height: 544 },
] as const;

if (!bundleIsBuilt()) {
  console.error(`render-dialog-tokens: missing ${BUNDLE}.js — run \`bun run build\` first.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const manifest: Record<string, string> = {};
for (const viewport of VIEWPORTS) {
  for (const shot of DIALOG_SHOTS) {
    if (only && !shot.slug.includes(only)) continue;
    const { text, rgba, width, height } = await driveDialog(shot, viewport);
    const file = `${shot.slug}.${viewport.name}.png`;
    writeFileSync(join(OUT, file), encodePNG(rgba, width, height));
    manifest[`${shot.slug}.${viewport.name}`] = text;
    console.log(`${file}  "${text}"`);
  }
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${OUT} (${existsSync(OUT) ? "ok" : "missing"})`);

// The production dialog paginator, shared by the live GameView and every
// headless tool that records or replays the mainline tape. The GameView
// builds its paginator with no speaker portraits (main.tsx passes no
// `faces`), so a headless session that does not pass this paginator sees a
// different page count for a long corner/side dialog than the built game:
// the tape's confirms then run out mid-box and the replay stalls. Keep this
// identical to GameView's createDialogPaginator call (480 px design width,
// the theme rim, the baked 12 px Inter measurer).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDialogPaginator } from "../vendor/pocket-rpgkit/src/ui/dialog-pages.ts";
import type { TextPaginator } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { createFontMeasure } from "../vendor/pocket-rpgkit/tools/lib/font-measure.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";

/** Build the dialog paginator the production GameView uses, reading the
 *  baked font metrics from `root` (the game repository root). */
export function productionPaginator(root: string): TextPaginator {
  const fonts = JSON.parse(readFileSync(join(root, "fonts.json"), "utf8")) as {
    fallback?: string[];
    characterFiles?: string[];
  };
  const charset = new Set<number>();
  for (const file of fonts.characterFiles ?? []) {
    for (const ch of readFileSync(join(root, file), "utf8")) charset.add(ch.codePointAt(0)!);
  }
  const measure = createFontMeasure({
    px: 12,
    fallbacks: (fonts.fallback ?? []).map((file) => join(root, file)),
    charset,
  });
  return createDialogPaginator({ rim: !!TUXEMON_UI_THEME.rim }, measure);
}

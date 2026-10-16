// Pure measured-text contract shared by the Bag presentation and its tests.

import { breakText, type Measure } from "../vendor/pocket-rpgkit/src/engine/text-break.ts";

export const BAG_DETAIL_TEXT_WIDTH = 154;

/** Wrap imported descriptions by measured glyph advance. Latin words break
 * at spaces; a single overlong word falls back to scalar boundaries. */
export function bagDetailLines(text: string, measure: Measure): string[] {
  return breakText(text, BAG_DETAIL_TEXT_WIDTH, measure).map((row) => row.text);
}

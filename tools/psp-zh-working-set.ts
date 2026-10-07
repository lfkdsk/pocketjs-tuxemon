// Collect the CJK working set of the zh smoke tape: every modal text/choice
// line displayed while replaying data/zh-smoke-journey.json through the zh
// session. Prints the unique CJK char count and the set, for the PSP font
// residency measurement. No side effects.
//
//   bun tools/psp-zh-working-set.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSession, startSession, stepSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { readShardedProject } from "./generated-project.ts";
import { TUXEMON_BATTLE_RULES_ZH, TUXEMON_EXTENSIONS_ZH, TUXEMON_SCENES_ZH, TUXEMON_TEXT_TOKENS_ZH } from "../battle/game-zh.ts";

export interface ZhWorkingSet {
  frames: number;
  texts: number;
  choices: number;
  /** Every unique character displayed in a text or choices modal. */
  chars: Set<string>;
  /** The subset of `chars` that are CJK ideographs (U+4E00..U+9FFF). */
  cjk: string[];
}

/** Replay the zh smoke tape through the zh session and collect every modal
 *  text/choice character. This is the realistic on-demand working set for the
 *  opening; the full game's working set is larger but bounded by dialogue. */
export function collectZhWorkingSet(root: string): ZhWorkingSet {
  const sharded = readShardedProject(root, "zh_CN");
  const project = sharded.project;
  const sess = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1", {
    maps: sharded.repository,
    extensions: TUXEMON_EXTENSIONS_ZH,
    battle: TUXEMON_BATTLE_RULES_ZH,
    scenes: TUXEMON_SCENES_ZH,
    textTokens: TUXEMON_TEXT_TOKENS_ZH,
  }));
  let st = startSession(project, sess);

  const tape = JSON.parse(readFileSync(resolve(root, "data/zh-smoke-journey.json"), "utf8")) as { masks: number[] };
  const chars = new Set<string>();
  let previous = 0;
  let texts = 0, choices = 0;
  for (let frame = 1; frame < tape.masks.length; frame++) {
    const mask = tape.masks[frame]!;
    const pressed = mask & ~previous;
    st = stepSession(sess, st, {
      buttons: mask,
      confirmEdge: !!(pressed & 0x2000),
      cancelEdge: !!(pressed & 0x4000),
      upEdge: !!(pressed & 0x10),
      downEdge: !!(pressed & 0x40),
      leftEdge: !!(pressed & 0x80),
      rightEdge: !!(pressed & 0x20),
    });
    previous = mask;
    const m = st.interp.modal;
    if (m?.kind === "text") { for (const l of m.lines) for (const ch of l) chars.add(ch); texts++; }
    else if (m?.kind === "choices") { for (const o of m.options) for (const ch of o) chars.add(ch); for (const ch of m.prompt) chars.add(ch); choices++; }
  }
  const cjk = [...chars].filter((ch) => { const cp = ch.codePointAt(0)!; return cp >= 0x4e00 && cp <= 0x9fff; });
  return { frames: tape.masks.length, texts, choices, chars, cjk };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { frames, texts, choices, chars, cjk } = collectZhWorkingSet(root);
  console.log(`frames=${frames} text-modals=${texts} choice-modals=${choices}`);
  console.log(`unique chars displayed: ${chars.size}, of which CJK ideographs: ${cjk.length}`);
  console.log(`CJK set: ${cjk.join("")}`);
}

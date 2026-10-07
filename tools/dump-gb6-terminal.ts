// Replay the GB6 tape and dump the terminal state fields affected by the
// cathedral billing change (gold, bills, party HP, party_lost_hp).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTuxemonSessionOptions, TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";
import {
  createSession,
  startSession,
  stepSession,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { readInlineProject } from "./generated-project.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { Gb6JourneyResult } from "./gb6-journey.ts";

const ROOT = resolve(import.meta.dir, "..");
const tapePath = process.argv[2] ?? join(ROOT, "data/gb6-mainline-journey.json");
const journey = JSON.parse(readFileSync(tapePath, "utf8")) as Gb6JourneyResult;

const project = readInlineProject(ROOT);
const worldTraversal = journeyWorldTraversal(journey, "GB6 terminal dump");
const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal));
let state = startSession(project, session);
let previous = 0;
const input = (mask: number, prev: number) => {
  const pressed = mask & ~prev;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
};
for (let frame = 0; frame < journey.masks.length; frame++) {
  const mask = journey.masks[frame]!;
  state = stepSession(session, state, input(mask, previous));
  previous = mask;
}

const ext = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB);
const dump = {
  gold: state.sw.gold,
  bills: ext.bills,
  party: ext.party.map((m) => ({ slug: m.slug, level: m.level, hp: m.currentHp, maxHp: m.base.hp })),
  party_lost_hp: state.sw.variables["v.party_lost_hp"],
  billcathedral: state.sw.variables["v.billcathedral"],
};
console.log(JSON.stringify(dump, null, 2));
console.log("FULL_STATE_BEGIN");
console.log(canonicalJson(state));
console.log("FULL_STATE_END");

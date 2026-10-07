// Deterministic input-only continuation: frozen GB6 + J1 terminal ->
// Greenwash Aardant -> Candy Hospital cure story gate.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { mainlineSessionOptions } from "./mainline-session.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  type SaveSnapshot,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  Driver,
  journeyWorldTraversal,
  recordingWorldTraversal,
  type Gb6BattleCheckpoint,
  type Gb6JourneyResult,
  type Gb6MapCheckpoint,
  type Gb6PartyRow,
} from "./gb6-journey.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import { readInlineProject } from "./generated-project.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(process.env.J2_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const GB6_PATH = resolve(process.env.J2_GB6_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const J1_PATH = resolve(process.env.J2_BASE_JOURNEY ?? join(ROOT, "data/j1-captainreturns-journey.json"));
const BTN_CONFIRM = 0x2000;

export interface J2BaseCheckpoint {
  format: string;
  worldTraversal: WorldTraversalMode;
  frames: number;
  tapeSha256: string;
  terminalStateSha256: string;
  terminalSnapshotSha256: string;
  heldMask: number;
  timelineFrame: number;
  map: string;
  position: [number, number];
}

export interface J2JourneyResult {
  format: "pocket-tuxemon/j2-hospitalcure/v1";
  worldTraversal: "seamless-v1";
  hz: 60;
  frames: number;
  combinedFrames: number;
  durationSeconds: number;
  base: J2BaseCheckpoint;
  map: string;
  position: [number, number];
  masks: number[];
  maps: Gb6MapCheckpoint[];
  battles: Gb6BattleCheckpoint[];
  story: {
    captainReturns: number;
    dojoMagician: number;
    dojoThriMonster: number;
    nimrodTruWon: boolean;
    seenTimber: number;
    scoopLandrace: number;
    seenCandy: number;
    lootenWon: boolean;
    aardant: number;
    passwordColor: "Blue";
    passwordNumber: "10";
    passcodeColorReset: number;
    passcodeNumberReset: number;
    screenDown: number;
    hospitalCure: number;
  };
  party: Gb6PartyRow[];
  initialStateSha256: string;
  terminalStateSha256: string;
  tapeSha256: string;
  combinedTapeSha256: string;
}

export interface J2BaseState {
  checkpoint: J2BaseCheckpoint;
  snapshot: SaveSnapshot;
  state: SessionState;
  masks: number[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & BTN_CONFIRM),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & BTN_BITS.UP),
    downEdge: Boolean(pressed & BTN_BITS.DOWN),
    leftEdge: Boolean(pressed & BTN_BITS.LEFT),
    rightEdge: Boolean(pressed & BTN_BITS.RIGHT),
  };
}

function numeric(state: SessionState, id: string): number {
  const value = state.sw.variables[id];
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error(`J2 journey: ${id} is not numeric`);
  return value;
}

/** Fold the complete frozen ancestry and cross the production save/restore
 * boundary. The checked-in J2 segment stores only its parent identity. */
export function buildJ2BaseState(): J2BaseState {
  const project = readInlineProject(ROOT);
  const gb6 = JSON.parse(readFileSync(GB6_PATH, "utf8")) as Gb6JourneyResult;
  const j1 = JSON.parse(readFileSync(J1_PATH, "utf8")) as J1JourneyResult;
  if (gb6.format !== "pocket-tuxemon/gb6-mainline/v1" || gb6.hz !== 60) {
    throw new Error("J2 journey: unsupported GB6 ancestor tape");
  }
  if (j1.format !== "pocket-tuxemon/j1-captainreturns/v1" || j1.hz !== 60) {
    throw new Error("J2 journey: unsupported J1 base tape");
  }
  if (gb6.frames !== gb6.masks.length || sha256(JSON.stringify(gb6.masks)) !== gb6.tapeSha256) {
    throw new Error("J2 journey: GB6 ancestor metadata changed");
  }
  if (j1.frames !== j1.masks.length || sha256(JSON.stringify(j1.masks)) !== j1.tapeSha256) {
    throw new Error("J2 journey: J1 base metadata changed");
  }
  const worldTraversal = journeyWorldTraversal(gb6, "J2 journey GB6 ancestor tape");
  const j1Traversal = journeyWorldTraversal(j1, "J2 journey J1 base tape");
  const j1BaseTraversal = journeyWorldTraversal(j1.base, "J2 journey J1 parent checkpoint");
  if (j1Traversal !== worldTraversal || j1BaseTraversal !== worldTraversal) {
    throw new Error(
      `J2 journey: ancestry traversal mismatch (${worldTraversal}, ${j1BaseTraversal}, ${j1Traversal})`,
    );
  }
  const masks = [...gb6.masks, ...j1.masks];
  if (j1.combinedFrames !== masks.length || sha256(JSON.stringify(masks)) !== j1.combinedTapeSha256) {
    throw new Error("J2 journey: J1 combined ancestry changed");
  }
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  let state = startSession(project, session);
  let previous = 0;
  for (let frame = 0; frame < masks.length; frame++) {
    const mask = masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    if (frame + 1 === gb6.frames && sha256(canonicalJson(state)) !== gb6.terminalStateSha256) {
      throw new Error("J2 journey: GB6 ancestor boundary changed");
    }
  }
  const terminalStateSha256 = sha256(canonicalJson(state));
  if (terminalStateSha256 !== j1.terminalStateSha256) {
    throw new Error(`J2 journey: J1 base state changed: ${terminalStateSha256}`);
  }
  const snapshot = createSessionSnapshot(session, state, previous);
  const checkpoint: J2BaseCheckpoint = {
    format: j1.format,
    worldTraversal,
    frames: masks.length,
    tapeSha256: j1.combinedTapeSha256,
    terminalStateSha256,
    terminalSnapshotSha256: sha256(canonicalJson(snapshot)),
    heldMask: previous,
    timelineFrame: state.frame,
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
  };
  return { checkpoint, snapshot, state, masks };
}

function enterFromEdge(driver: Driver, x: number, y: number, direction: number, map: string): void {
  const fromX = x + (direction === BTN_BITS.LEFT ? 1 : direction === BTN_BITS.RIGHT ? -1 : 0);
  const fromY = y + (direction === BTN_BITS.UP ? 1 : direction === BTN_BITS.DOWN ? -1 : 0);
  driver.goTo(fromX, fromY);
  const sourceMap = driver.state.mapId;
  for (let attempt = 0; attempt < 3 && driver.state.mapId === sourceMap; attempt++) {
    driver.pulse(direction);
    driver.settle();
  }
  driver.expect(`entered ${map}`, driver.state.mapId === map);
}

function healAtCenter(driver: Driver, map: string): void {
  driver.healAtCenter();
  driver.expect(`${map} nurse restored the party`,
    driver.extensionParty().every((monster) => monster.hp === monster.maxHp));
}

export function runJ2Journey(): J2JourneyResult {
  const project = readInlineProject(ROOT);
  const base = buildJ2BaseState();
  const worldTraversal = recordingWorldTraversal(project, "J2 journey");
  if (base.checkpoint.worldTraversal !== worldTraversal) {
    throw new Error(
      `J2 journey: base traversal ${base.checkpoint.worldTraversal} does not match project ${worldTraversal}`,
    );
  }
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  const initial = restoreSessionSnapshot(session, base.snapshot);
  initial.frame = base.checkpoint.timelineFrame;
  const initialStateSha256 = sha256(canonicalJson(initial));
  const driver = new Driver(session, 60, initial, base.snapshot.held);
  driver.settle();
  driver.expect("started at the frozen Captain Returns terminal",
    driver.state.mapId === "spyder_mansion" && driver.state.move.tx === 1 && driver.state.move.ty === 13 &&
    numeric(driver.state, "v.captainreturns") !== 0);

  // The Mansion magician provides the pass that opens Flower City's Dojo.
  enterFromEdge(driver, 1, 1, BTN_BITS.UP, "spyder_mansion_top");
  driver.interactNpc("npc_spyder_top_lenny");
  driver.expect("Mansion magician granted the Dojo Pass",
    numeric(driver.state, "v.dojomagician") !== 0 && (driver.state.sw.items.dojo_pass ?? 0) >= 1);

  // Return through Route A to Flower City, heal, then take the connected
  // overland route through Route 5, Timber Town, the tunnel, and Route 6.
  enterFromEdge(driver, 1, 17, BTN_BITS.DOWN, "spyder_mansion");
  enterFromEdge(driver, 9, 17, BTN_BITS.DOWN, "spyder_routea");
  enterFromEdge(driver, 7, 39, BTN_BITS.DOWN, "spyder_flower_city");
  driver.goTo(16, 15);
  driver.settle();
  driver.expect("entered Flower Center", driver.state.mapId === "spyder_flower_center");
  healAtCenter(driver, "Flower Center");
  driver.goTo(6, 9);
  driver.goTo(6, 10);
  driver.settle();
  driver.expect("left Flower Center", driver.state.mapId === "spyder_flower_city");

  // Complete the Dojo evaluation. Every specialist heals the party after a
  // win; the final choice grants the creature that authorizes Nimrod entry.
  enterFromEdge(driver, 34, 17, BTN_BITS.UP, "spyder_dojo1");
  enterFromEdge(driver, 12, 5, BTN_BITS.RIGHT, "spyder_dojo2");
  driver.fightNpc("spyder_dojo_toph");
  driver.fightNpc("spyder_dojo_sokka");
  driver.fightNpc("spyder_dojo_kataro");
  driver.fightNpc("spyder_dojo_yangchen");
  driver.fightNpc("spyder_dojo_iroh");
  // The five victories only make Wan eligible. Tuxemon starts his approach
  // when the player steps on the central mat, which sets wanintro before his
  // guarded talk page can launch the final evaluation battle.
  driver.goTo(10, 9);
  driver.settle();
  driver.expect("Dojo master introduction completed", numeric(driver.state, "v.wanintro") !== 0);
  driver.fightNpc("spyder_dojo_wan");
  enterFromEdge(driver, 14, 9, BTN_BITS.RIGHT, "spyder_dojo3");
  driver.fightNpc("spyder_dojo_ares");
  driver.fightNpc("spyder_dojo_orion");
  driver.fightNpc("spyder_dojo_hermes");
  driver.fightNpc("spyder_dojo_hephastus");
  driver.fightNpc("spyder_dojo_saturn");
  driver.goTo(10, 9);
  driver.settle();
  driver.expect("Dojo elder introduction completed", numeric(driver.state, "v.tuintro") !== 0);
  driver.fightNpc("spyder_dojo_tu");
  enterFromEdge(driver, 14, 9, BTN_BITS.RIGHT, "spyder_dojo4");
  driver.fightNpc("spyder_dojo_thri", "npc_spyder_dojo_thri", ["Strength"]);
  driver.expect("Dojo master granted the Nimrod credential", numeric(driver.state, "v.dojothrimonster") !== 0);
  const billieWins = driver.winCount("spyder_billie");
  enterFromEdge(driver, 9, 9, BTN_BITS.LEFT, "spyder_dojo3");
  driver.expectWin("spyder_billie", billieWins + 1);
  enterFromEdge(driver, 9, 9, BTN_BITS.LEFT, "spyder_dojo2");
  enterFromEdge(driver, 9, 9, BTN_BITS.LEFT, "spyder_dojo1");
  enterFromEdge(driver, 11, 11, BTN_BITS.DOWN, "spyder_flower_city");

  // Nimrod is the bridge between Flower's central and western districts.
  // Crossing its three floors and defeating Tru removes the west-road signs.
  driver.goTo(19, 9);
  driver.settle();
  driver.expect("entered Nimrod east lobby", driver.state.mapId === "spyder_nimrod_bottom");
  // The two-row lift is itself a playerTouch transfer area. Approach its
  // reachable lower row so the route finder never needs to cross a transfer
  // cell on the way to the selected trigger cell.
  enterFromEdge(driver, 16, 18, BTN_BITS.UP, "spyder_nimrod_middle");
  enterFromEdge(driver, 0, 18, BTN_BITS.UP, "spyder_nimrod_top");
  driver.goTo(3, 5);
  driver.settle();
  driver.expect("crossed Nimrod top to the west middle floor", driver.state.mapId === "spyder_nimrod_middle");
  driver.goTo(5, 15);
  driver.settle();
  driver.expect("descended to Nimrod west lobby", driver.state.mapId === "spyder_nimrod_bottom");
  driver.fightNpc("spyder_nimrod_tru");
  driver.expect("Nimrod evaluation was completed", driver.winCount("spyder_nimrod_tru") === 1);
  enterFromEdge(driver, 0, 18, BTN_BITS.LEFT, "spyder_flower_city");
  enterFromEdge(driver, 0, 9, BTN_BITS.LEFT, "spyder_route5");
  enterFromEdge(driver, 4, 19, BTN_BITS.DOWN, "spyder_timber_town");
  driver.goTo(4, 1);
  driver.settle();
  driver.expect("Timber Town visit was recorded", numeric(driver.state, "v.seentimber") !== 0);
  driver.goTo(8, 6);
  driver.settle();
  driver.expect("entered Timber Center", driver.state.mapId === "spyder_timber_center");
  healAtCenter(driver, "Timber Center");
  driver.goTo(6, 9);
  driver.goTo(6, 10);
  driver.settle();
  driver.expect("left Timber Center", driver.state.mapId === "spyder_timber_town");

  // Landrace blocks the north end of the tunnel until the player follows
  // him through all four Scoop floors and wins his Sludgehog encounter.
  enterFromEdge(driver, 29, 22, BTN_BITS.UP, "spyder_scoop1");
  enterFromEdge(driver, 19, 2, BTN_BITS.UP, "spyder_scoop2");
  enterFromEdge(driver, 7, 3, BTN_BITS.UP, "spyder_scoop3");
  enterFromEdge(driver, 5, 2, BTN_BITS.UP, "spyder_scoop4");
  const landraceBattleCount = driver.battles.length;
  driver.interactNpc("npc_spyder_scoop_landrace");
  driver.expect("Landrace's Sludgehog encounter was won",
    driver.battles.slice(landraceBattleCount).some((battle) =>
      battle.opponent === "wild:sludgehog" && battle.outcome === "won"));
  driver.expect("Landrace opened the tunnel", numeric(driver.state, "v.scooplandrace") !== 0);
  enterFromEdge(driver, 11, 3, BTN_BITS.RIGHT, "spyder_timber_town");

  enterFromEdge(driver, 14, 39, BTN_BITS.DOWN, "spyder_tunnel");
  enterFromEdge(driver, 12, 2, BTN_BITS.UP, "spyder_tunnel_below");
  // This stair checks DOWN inside its commands rather than in the page
  // condition. Enter from the west, then hold DOWN during the final movement
  // ticks so the first evaluation on (14,25) sees the authored facing.
  driver.goTo(13, 25);
  driver.tick(BTN_BITS.RIGHT);
  for (let frame = 0; frame < 60 && driver.state.mapId === "spyder_tunnel_below"; frame++) {
    driver.tick(BTN_BITS.DOWN);
  }
  driver.tick(0);
  driver.settle();
  driver.expect("returned to the lower tunnel", driver.state.mapId === "spyder_tunnel");
  enterFromEdge(driver, 19, 35, BTN_BITS.RIGHT, "spyder_route6");
  // Gunner seals the only approach to this Route 6 section's Candy exit and
  // steps left after the authored talk-triggered battle. Approach from above
  // so the player does not occupy the first tile of his path to (28,17).
  const gunnerWins = driver.winCount("spyder_route6_gunner");
  driver.goTo(30, 16);
  driver.interact(0);
  driver.expectWin("spyder_route6_gunner", gunnerWins + 1);
  // Blair and Richard are sight-line trainers whose path the old tape crossed
  // incidentally. The wandering Frances NPC reroutes the BFS around their
  // sight lines, so fight both explicitly to keep the gauntlet deterministic.
  // Richard first: the BFS detour around Frances otherwise crosses his sight
  // line on the way to Blair, which would make his fight incidental.
  driver.fightNpc("spyder_route6_richard");
  driver.fightNpc("spyder_route6_blair");
  enterFromEdge(driver, 30, 19, BTN_BITS.DOWN, "spyder_candy_town");
  driver.expect("Candy Town visit was recorded", numeric(driver.state, "v.seencandy") !== 0);

  // Restore after the overland trainer gauntlet, then enter Greenwash and
  // defeat Looten. His post-battle dialogue grants the story-critical item.
  driver.goTo(14, 34);
  driver.settle();
  driver.expect("entered Candy Center", driver.state.mapId === "spyder_candy_center");
  healAtCenter(driver, "Candy Center");
  driver.goTo(6, 9);
  driver.goTo(6, 10);
  driver.settle();
  driver.expect("left Candy Center", driver.state.mapId === "spyder_candy_town");
  // Looten's guard intentionally blocks the main door until after the win.
  // Follow the upstream alternate entrance through the eastern greenhouse.
  enterFromEdge(driver, 30, 21, BTN_BITS.UP, "spyder_greenwash_greenhouse");
  enterFromEdge(driver, 0, 7, BTN_BITS.LEFT, "spyder_greenwash");
  enterFromEdge(driver, 2, 3, BTN_BITS.UP, "spyder_greenwash_level2");
  enterFromEdge(driver, 2, 27, BTN_BITS.DOWN, "spyder_greenwash");
  driver.fightNpc("spyder_greenwash_looten");
  driver.expect("Looten granted Aardant", (driver.state.sw.items.aardant ?? 0) >= 1);
  driver.markMap("aardant-acquired");

  // Return to the hospital's shared ground floor and use the elevator. The
  // imported paginated choices preserve the upstream Blue / 10 password.
  enterFromEdge(driver, 5, 31, BTN_BITS.DOWN, "spyder_candy_town");
  driver.goTo(14, 34);
  driver.settle();
  driver.expect("returned to Candy Center", driver.state.mapId === "spyder_candy_center");
  healAtCenter(driver, "Candy Center");
  driver.goTo(13, 5);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["2° Floor", "Next >", "Blue", "Next >", "10"]);
  driver.expect("Blue / 10 opened Hospital 2", driver.state.mapId === "spyder_candy_hospital2");
  driver.expect("accepted password was reset",
    numeric(driver.state, "v.passcode_color") === 0 && numeric(driver.state, "v.passcode_number") === 0);
  // Let the entry fade finish so the golden captures a clear hospital room.
  for (let i = 0; i < 60; i++) driver.tick();
  driver.markMap("hospital-password");

  // Reach the quarantined laboratory. Aardant fools the scanner; interact
  // with the cure before moving south into the later Billie confrontation.
  enterFromEdge(driver, 17, 1, BTN_BITS.UP, "spyder_candy_hospital3");
  driver.goTo(5, 15);
  driver.settle();
  driver.expect("Aardant shut down the hospital scanner", numeric(driver.state, "v.screendown") !== 0);
  driver.goTo(5, 7);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle();
  driver.expect("hospital cure was recovered", numeric(driver.state, "v.hospitalcure") !== 0);
  driver.expect("Billie confrontation has not started", numeric(driver.state, "v.hospitalbillie") === 0);
  driver.markMap("hospital-cure");

  const story = {
    captainReturns: numeric(driver.state, "v.captainreturns"),
    dojoMagician: numeric(driver.state, "v.dojomagician"),
    dojoThriMonster: numeric(driver.state, "v.dojothrimonster"),
    nimrodTruWon: driver.state.sw.switches["bo.spyder_nimrod_tru.won"] === true,
    seenTimber: numeric(driver.state, "v.seentimber"),
    scoopLandrace: numeric(driver.state, "v.scooplandrace"),
    seenCandy: numeric(driver.state, "v.seencandy"),
    lootenWon: driver.state.sw.switches["bo.spyder_greenwash_looten.won"] === true,
    aardant: driver.state.sw.items.aardant ?? 0,
    passwordColor: "Blue" as const,
    passwordNumber: "10" as const,
    passcodeColorReset: numeric(driver.state, "v.passcode_color"),
    passcodeNumberReset: numeric(driver.state, "v.passcode_number"),
    screenDown: numeric(driver.state, "v.screendown"),
    hospitalCure: numeric(driver.state, "v.hospitalcure"),
  };
  const stateJson = canonicalJson(driver.state);
  const maps = driver.maps.map((checkpoint, index) => index === 0
    ? { ...checkpoint, frame: -1 }
    : checkpoint);
  return {
    format: "pocket-tuxemon/j2-hospitalcure/v1",
    worldTraversal,
    hz: 60,
    frames: driver.masks.length,
    combinedFrames: base.checkpoint.frames + driver.masks.length,
    durationSeconds: Number((driver.masks.length / 60).toFixed(3)),
    base: base.checkpoint,
    map: driver.state.mapId,
    position: [driver.state.move.tx, driver.state.move.ty],
    masks: driver.masks,
    maps,
    battles: driver.battles,
    story,
    party: driver.extensionParty(),
    initialStateSha256,
    terminalStateSha256: sha256(stateJson),
    tapeSha256: sha256(JSON.stringify(driver.masks)),
    combinedTapeSha256: sha256(JSON.stringify([...base.masks, ...driver.masks])),
  };
}

if (import.meta.main) {
  const result = runJ2Journey();
  const output = process.env.J2_JOURNEY_OUT ?? join(ROOT, "dist", "j2-hospitalcure-journey.json");
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`J2 JOURNEY PASS frames=${result.frames} battles=${result.battles.length} ` +
    `end=${result.map}@${result.position.join(",")} state=${result.terminalStateSha256}`);
}

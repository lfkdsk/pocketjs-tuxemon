// Deterministic input-only continuation: frozen GB6 Route 3 terminal ->
// Wayfarer guestbook -> Bazaar Mansion captainreturns story gate.

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
import { readInlineProject } from "./generated-project.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(process.env.J1_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const BASE_PATH = resolve(process.env.J1_BASE_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const BTN_CONFIRM = 0x2000;

export interface J1BaseCheckpoint {
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

export interface J1JourneyResult {
  format: "pocket-tuxemon/j1-captainreturns/v1";
  worldTraversal: "seamless-v1";
  hz: 60;
  frames: number;
  combinedFrames: number;
  durationSeconds: number;
  base: J1BaseCheckpoint;
  map: string;
  position: [number, number];
  masks: number[];
  maps: Gb6MapCheckpoint[];
  battles: Gb6BattleCheckpoint[];
  story: {
    enforcersResponseDone: number;
    route4Billie: number;
    routeABillie: number;
    foundCaptain: number;
    captainReturns: number;
  };
  party: Gb6PartyRow[];
  initialStateSha256: string;
  terminalStateSha256: string;
  tapeSha256: string;
  combinedTapeSha256: string;
}

export interface J1BaseState {
  checkpoint: J1BaseCheckpoint;
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
    confirmEdge: Boolean(pressed & 0x2000),
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
  if (typeof value !== "number") throw new Error(`J1 journey: ${id} is not numeric`);
  return value;
}

/** Fold and freeze the preceding tape, then cross the real save/restore
 * boundary used by standalone continuation replay. The snapshot is kept out
 * of the checked-in segment: only its digest and predecessor identity are
 * metadata. */
export function buildJ1BaseState(): J1BaseState {
  const project = readInlineProject(ROOT);
  const base = JSON.parse(readFileSync(BASE_PATH, "utf8")) as Gb6JourneyResult;
  if (base.format !== "pocket-tuxemon/gb6-mainline/v1" || base.hz !== 60) {
    throw new Error("J1 journey: unsupported GB6 base tape");
  }
  if (base.frames !== base.masks.length || sha256(JSON.stringify(base.masks)) !== base.tapeSha256) {
    throw new Error("J1 journey: GB6 base tape metadata changed");
  }
  const worldTraversal = journeyWorldTraversal(base, "J1 journey GB6 base tape");
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  let state = startSession(project, session);
  let previous = 0;
  for (const mask of base.masks) {
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  const terminalStateSha256 = sha256(canonicalJson(state));
  if (terminalStateSha256 !== base.terminalStateSha256) {
    throw new Error(`J1 journey: GB6 base state changed: ${terminalStateSha256}`);
  }
  const snapshot = createSessionSnapshot(session, state, previous);
  const checkpoint: J1BaseCheckpoint = {
    format: base.format,
    worldTraversal,
    frames: base.frames,
    tapeSha256: base.tapeSha256,
    terminalStateSha256,
    terminalSnapshotSha256: sha256(canonicalJson(snapshot)),
    heldMask: previous,
    timelineFrame: state.frame,
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
  };
  return { checkpoint, snapshot, state, masks: base.masks };
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

export function runJ1Journey(): J1JourneyResult {
  const project = readInlineProject(ROOT);
  const base = buildJ1BaseState();
  const worldTraversal = recordingWorldTraversal(project, "J1 journey");
  if (base.checkpoint.worldTraversal !== worldTraversal) {
    throw new Error(
      `J1 journey: GB6 base traversal ${base.checkpoint.worldTraversal} does not match project ${worldTraversal}`,
    );
  }
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  const initial = restoreSessionSnapshot(session, base.snapshot);
  // SaveSnapshot intentionally omits the presentation-only top-level frame.
  // A continuation knows its parent timeline, so seed that derived counter
  // from parent metadata and preserve byte identity with frame-zero replay.
  initial.frame = base.checkpoint.timelineFrame;
  const initialStateSha256 = sha256(canonicalJson(initial));
  const driver = new Driver(session, 60, initial, base.snapshot.held);
  driver.settle();
  driver.expect("started at the frozen Route 3 terminal", driver.state.mapId === "spyder_route3" &&
    driver.state.move.tx === 4 && driver.state.move.ty === 6);

  // Return to the inn and read the guestbook note. Choosing Yes plays the
  // Enforcer flashback in Nimrod Room and returns with the `done` story value.
  driver.goTo(4, 4);
  driver.settle();
  driver.expect("entered the Wayfarer Inn south room", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(9, 6);
  driver.pulse(BTN_BITS.RIGHT);
  driver.pulse(BTN_CONFIRM);
  driver.settle(["Yes"]);
  driver.expect("guestbook flashback returned to Wayfarer Inn", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.expect("guestbook flashback completed", numeric(driver.state, "v.enforcers_response") !== 0);
  driver.markMap("wayfarer-guestbook");

  // Cross the upper floor and leave beside QQQ, then take Route 3's west
  // boundary into Route 4.
  driver.goTo(4, 2);
  driver.settle();
  driver.expect("climbed to Wayfarer upper floor", driver.state.mapId === "spyder_wayfarer_inn2");
  driver.goTo(10, 3);
  driver.settle();
  driver.expect("crossed to Wayfarer north room", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(11, 1);
  driver.settle();
  driver.expect("returned to Route 3 north end", driver.state.mapId === "spyder_route3");
  enterFromEdge(driver, 0, 3, BTN_BITS.LEFT, "spyder_route4");

  // The Route 4 nurse is directly beside the east entrance. No shopping or
  // grinding is needed: the inherited L32 lead is already above this leg.
  driver.interactNpc("npc_spyder_route4_nurse", ["Yes"]);
  driver.expect("Route 4 nurse restored the party",
    driver.extensionParty().every((monster) => monster.hp === monster.maxHp));
  driver.fightTouch("spyder_billie", 2, 6);
  driver.markMap("route-4-billie");
  enterFromEdge(driver, 0, 4, BTN_BITS.LEFT, "spyder_flower_city");

  // Flower City is only the faithful connector here; head north into Route A.
  enterFromEdge(driver, 27, 0, BTN_BITS.UP, "spyder_routea");
  driver.interactNpc("npc_spyder_routea_nurse", ["Yes"]);
  driver.expect("Route A nurse restored the party",
    driver.extensionParty().every((monster) => monster.hp === monster.maxHp));
  driver.fightTouch("spyder_billie", 16, 18);
  driver.markMap("route-a-billie");
  enterFromEdge(driver, 7, 12, BTN_BITS.UP, "spyder_mansion");

  // Heal inside the mansion, descend from the east staircase, find Captain
  // Flick, then return by the west staircase to reach the return trigger.
  driver.interactNpc("npc_spyder_mansion_nurse", ["Yes"]);
  driver.expect("Mansion nurse restored the party",
    driver.extensionParty().every((monster) => monster.hp === monster.maxHp));
  // The two drinking buddies deliberately seal the west half before the
  // rescue. Enter by the east basement stair; the west stair is the return
  // path that places the player on the far side for Captain Returns.
  driver.goTo(15, 3);
  driver.pulse(BTN_BITS.UP);
  driver.settle();
  driver.expect("descended into Mansion basement", driver.state.mapId === "spyder_mansion_basement");
  driver.interactNpc("npc_spyder_basement_flick");
  driver.expect("found Captain Flick", numeric(driver.state, "v.foundcaptain") !== 0);
  driver.markMap("captain-found");
  driver.goTo(6, 19);
  driver.settle();
  driver.expect("returned to Mansion main room", driver.state.mapId === "spyder_mansion");
  driver.goTo(1, 13);
  driver.settle();
  driver.expect("Captain returned", numeric(driver.state, "v.captainreturns") !== 0);
  driver.expect("Captain return scene released controls", !driver.state.interp.inputLocked &&
    driver.state.interp.main === null && driver.state.scene === null);
  driver.expect("Captain return scene removed its temporary actors", [
    "npc_spyder_mansion_drinkingbuddya",
    "npc_spyder_mansion_drinkingbuddyb",
    "npc_spyder_mansion_rolo",
  ].every((id) => numeric(driver.state, `local.${id.replace(/^npc_/, "npc.")}`) === 0 &&
    driver.state.chars.chars[id]?.blocks !== true));
  driver.markMap("captainreturns");

  const story = {
    enforcersResponseDone: numeric(driver.state, "v.enforcers_response"),
    route4Billie: numeric(driver.state, "v.route4billie"),
    routeABillie: numeric(driver.state, "v.routeabillie"),
    foundCaptain: numeric(driver.state, "v.foundcaptain"),
    captainReturns: numeric(driver.state, "v.captainreturns"),
  };
  const stateJson = canonicalJson(driver.state);
  const maps = driver.maps.map((checkpoint, index) => index === 0
    ? { ...checkpoint, frame: -1 }
    : checkpoint);
  return {
    format: "pocket-tuxemon/j1-captainreturns/v1",
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
  const result = runJ1Journey();
  const output = process.env.J1_JOURNEY_OUT ?? join(ROOT, "dist", "j1-captainreturns-journey.json");
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`J1 JOURNEY PASS frames=${result.frames} battles=${result.battles.length} ` +
    `end=${result.map}@${result.position.join(",")} state=${result.terminalStateSha256}`);
}

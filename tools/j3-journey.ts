// Deterministic input-only continuation: frozen GB6 + J1 + J2 terminal ->
// Omnichannel screen breach -> Radio Tower broadcast.

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
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  Driver,
  journeyWorldTraversal,
  recordingWorldTraversal,
  type Gb6BattleCheckpoint,
  type Gb6MapCheckpoint,
  type Gb6PartyRow,
} from "./gb6-journey.ts";
import { buildJ2BaseState, type J2JourneyResult } from "./j2-journey.ts";
import { readInlineProject } from "./generated-project.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(process.env.J3_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const J2_PATH = resolve(process.env.J3_BASE_JOURNEY ?? join(ROOT, "data/j2-hospitalcure-journey.json"));
const BTN_CONFIRM = 0x2000;

export interface J3BaseCheckpoint {
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

export interface J3JourneyResult {
  format: "pocket-tuxemon/j3-omnichannelradioannounce/v1";
  worldTraversal: "seamless-v1";
  hz: 60;
  frames: number;
  combinedFrames: number;
  durationSeconds: number;
  base: J3BaseCheckpoint;
  map: string;
  position: [number, number];
  masks: number[];
  maps: Gb6MapCheckpoint[];
  battles: Gb6BattleCheckpoint[];
  story: {
    hospitalCure: number;
    hospitalBillie: number;
    nurseSpyder: number;
    spyderPass: number;
    omnichannelReadyWall: number;
    omnichannel1Wall: number;
    omnichannel1CollisionRemoved: number;
    beaverbrookWon: boolean;
    kernelQuest: number;
    omnichannelRadioAnnounce: number;
  };
  party: Gb6PartyRow[];
  initialStateSha256: string;
  terminalStateSha256: string;
  tapeSha256: string;
  combinedTapeSha256: string;
}

export interface J3BaseState {
  checkpoint: J3BaseCheckpoint;
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
  if (typeof value !== "number") throw new Error(`J3 journey: ${id} is not numeric`);
  return value;
}

/** Rebuild the frozen J2 terminal, then cross the production save/restore
 * boundary. The checked-in J3 segment stores only this parent identity. */
export function buildJ3BaseState(): J3BaseState {
  const project = readInlineProject(ROOT);
  const parent = buildJ2BaseState();
  const j2 = JSON.parse(readFileSync(J2_PATH, "utf8")) as J2JourneyResult;
  if (j2.format !== "pocket-tuxemon/j2-hospitalcure/v1" || j2.hz !== 60) {
    throw new Error("J3 journey: unsupported J2 base tape");
  }
  if (j2.frames !== j2.masks.length || sha256(JSON.stringify(j2.masks)) !== j2.tapeSha256) {
    throw new Error("J3 journey: J2 base metadata changed");
  }
  const worldTraversal = journeyWorldTraversal(j2, "J3 journey J2 base tape");
  const j2BaseTraversal = journeyWorldTraversal(j2.base, "J3 journey J2 parent checkpoint");
  if (worldTraversal !== parent.checkpoint.worldTraversal || j2BaseTraversal !== worldTraversal) {
    throw new Error(
      `J3 journey: ancestry traversal mismatch (${parent.checkpoint.worldTraversal}, ${j2BaseTraversal}, ${worldTraversal})`,
    );
  }
  if (canonicalJson({ ...j2.base, worldTraversal: j2BaseTraversal }) !== canonicalJson(parent.checkpoint)) {
    throw new Error("J3 journey: J2 parent checkpoint changed");
  }
  const masks = [...parent.masks, ...j2.masks];
  if (j2.combinedFrames !== masks.length || sha256(JSON.stringify(masks)) !== j2.combinedTapeSha256) {
    throw new Error("J3 journey: J2 combined ancestry changed");
  }
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  let state = restoreSessionSnapshot(session, parent.snapshot);
  state.frame = parent.checkpoint.timelineFrame;
  if (sha256(canonicalJson(state)) !== j2.initialStateSha256) {
    throw new Error("J3 journey: restored J2 initial state changed");
  }
  let previous = parent.snapshot.held;
  for (const mask of j2.masks) {
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  const terminalStateSha256 = sha256(canonicalJson(state));
  if (terminalStateSha256 !== j2.terminalStateSha256) {
    throw new Error(`J3 journey: J2 base state changed: ${terminalStateSha256}`);
  }
  const snapshot = createSessionSnapshot(session, state, previous);
  const checkpoint: J3BaseCheckpoint = {
    format: j2.format,
    worldTraversal,
    frames: masks.length,
    tapeSha256: j2.combinedTapeSha256,
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

function healAtCenter(driver: Driver, name: string): void {
  driver.healAtCenter();
  driver.expect(`${name} nurse restored the party`,
    driver.extensionParty().every((monster) => monster.hp === monster.maxHp));
}

export function runJ3Journey(): J3JourneyResult {
  const project = readInlineProject(ROOT);
  const base = buildJ3BaseState();
  const worldTraversal = recordingWorldTraversal(project, "J3 journey");
  if (base.checkpoint.worldTraversal !== worldTraversal) {
    throw new Error(
      `J3 journey: base traversal ${base.checkpoint.worldTraversal} does not match project ${worldTraversal}`,
    );
  }
  const session = createSession(project, 60, mainlineSessionOptions(project, worldTraversal));
  const initial = restoreSessionSnapshot(session, base.snapshot);
  initial.frame = base.checkpoint.timelineFrame;
  const initialStateSha256 = sha256(canonicalJson(initial));
  const driver = new Driver(session, 60, initial, base.snapshot.held);
  driver.settle();
  driver.expect("started at the frozen hospital-cure terminal",
    driver.state.mapId === "spyder_candy_hospital3" &&
    driver.state.move.tx === 5 && driver.state.move.ty === 7 &&
    numeric(driver.state, "v.hospitalcure") === 1 &&
    numeric(driver.state, "v.hospitalbillie") === 0);

  // Leaving the cure room triggers the authored Billie confrontation. This
  // is part of the story chain even though the next named gate is at HQ.
  const billieWins = driver.winCount("spyder_billie");
  enterFromEdge(driver, 5, 18, BTN_BITS.DOWN, "spyder_candy_hospital2");
  driver.expectWin("spyder_billie", billieWins + 1);
  driver.expect("Billie accepted the cure", numeric(driver.state, "v.hospitalbillie") === 1);

  // Take Hospital 2's east lift back to the shared Candy Center and heal
  // after the confrontation. Candy Port's unlocked riverboat is the authored
  // connection back to Paper Town; Route C itself is a water route.
  driver.goTo(11, 15);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Ground Floor"]);
  driver.expect("Hospital lift returned to Candy Center", driver.state.mapId === "spyder_candy_center");
  healAtCenter(driver, "Candy Center");
  driver.goTo(6, 9);
  enterFromEdge(driver, 6, 10, BTN_BITS.DOWN, "spyder_candy_town");
  enterFromEdge(driver, 11, 39, BTN_BITS.DOWN, "spyder_candy_port");
  driver.interactNpc("npc_spyder_captain", ["Paper Town"]);
  driver.expect("riverboat returned to Paper Town", driver.state.mapId === "spyder_paper_town");
  enterFromEdge(driver, 14, 0, BTN_BITS.UP, "spyder_route1");
  enterFromEdge(driver, 22, 0, BTN_BITS.UP, "spyder_cotton_town");
  // Cotton's cathedral gives the party a deterministic full-health boundary
  // before the Omnichannel gauntlet.
  enterFromEdge(driver, 20, 26, BTN_BITS.UP, "spyder_healing_center");
  healAtCenter(driver, "Cotton Cathedral");
  driver.goTo(6, 9);
  enterFromEdge(driver, 6, 10, BTN_BITS.DOWN, "spyder_cotton_town");
  enterFromEdge(driver, 17, 9, BTN_BITS.UP, "spyder_omnichannel1");

  // The cure disables the first-floor expulsion page. Crossing row 10 still
  // launches the L40 Enforcer fight, then William is cleared explicitly.
  const enforcerWins = driver.winCount("spyder_omnichannel_enforcer");
  driver.goTo(2, 10);
  driver.settle();
  driver.expectWin("spyder_omnichannel_enforcer", enforcerWins + 1);
  driver.fightNpc("spyder_omnichannel_william");

  // Clear every authored floor-2 trainer. The PC at the southwest corner
  // lowers the remote screen and arms the first-floor wall switch.
  enterFromEdge(driver, 2, 9, BTN_BITS.UP, "spyder_omnichannel2");
  driver.fightTouch("spyder_omnichannel_schwartz", 8, 12);
  driver.fightTouch("spyder_omnichannel_bettger", 7, 11);
  driver.fightTouch("spyder_omnichannel_tohei", 5, 16);
  // Tohei ends south of the player and blocks the narrow lower doorway, so
  // operate the PC from its south side before leaving the floor.
  driver.goTo(1, 18);
  driver.interact(2);
  driver.expect("Omnichannel PC armed the wall switch",
    numeric(driver.state, "v.omnichannel-ready-wall") === 1);

  // Return to floor 1 and activate the screen from its east-side console.
  // The importer represents remove_collision with a local variable-backed
  // page on all four cells of the original 2x2 collision rectangle.
  enterFromEdge(driver, 1, 13, BTN_BITS.DOWN, "spyder_omnichannel1");
  driver.goTo(9, 19);
  driver.interact(2);
  driver.expect("Omnichannel floor-1 wall was disabled",
    numeric(driver.state, "v.omnichannel1wall") === 1 &&
    numeric(driver.state, "local.collision.spyder_omnichannel1.screen") === 1 &&
    [1, 2, 3, 4].every((index) =>
      driver.state.chars.chars[`collision_screen_${index}`]?.blocks === false));
  const omnichannel1CollisionRemoved =
    numeric(driver.state, "local.collision.spyder_omnichannel1.screen");
  // The removed 2x2 collision opens the sealed southwest room. Danita's
  // one-shot dialogue there grants the non-consumable Radio Tower pass.
  driver.interactNpc("npc_spyder_omnichannel_danita");
  driver.expect("Omnichannel nurse granted the Spyder Pass",
    numeric(driver.state, "v.nurse_spyder") === 1 && (driver.state.sw.items.spyder_pass ?? 0) === 1);
  driver.markMap("omnichannel-wall");

  // Re-entry clears defeated floor-2 bodies from the one-tile corridors.
  // Clear the two remaining trainers, then all three floor-3 trainers before
  // taking the secured fourth-floor lift. Wall activation also enables the
  // upstream random encounter table, so encountered robos are real battles.
  enterFromEdge(driver, 2, 9, BTN_BITS.UP, "spyder_omnichannel2");
  driver.fightTouch("spyder_omnichannel_crane", 8, 6);
  driver.fightTouch("spyder_omnichannel_dempsey", 6, 2);
  enterFromEdge(driver, 2, 9, BTN_BITS.UP, "spyder_omnichannel3");
  driver.fightTouch("spyder_omnichannel_strauss", 6, 5);
  driver.fightTouch("spyder_omnichannel_carnegie", 10, 12);
  driver.fightTouch("spyder_omnichannel_byrne", 9, 20);
  enterFromEdge(driver, 2, 9, BTN_BITS.UP, "spyder_omnichannel4");
  driver.expect("Spyder Pass is still present", (driver.state.sw.items.spyder_pass ?? 0) === 1);
  enterFromEdge(driver, 10, 1, BTN_BITS.UP, "spyder_radiotower");
  driver.markMap("radio-tower-entry");

  // Crossing row 16 starts the L55 Beaverbrook battle and its complete
  // Billie/Dante scene. Only input masks drive the battle autoplay.
  const beaverbrookWins = driver.winCount("spyder_omnichannel_beaverbrook");
  driver.goTo(9, 15);
  driver.settle();
  driver.expectWin("spyder_omnichannel_beaverbrook", beaverbrookWins + 1);
  driver.expect("Beaverbrook scene set kernelquest=yes",
    driver.state.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true &&
    numeric(driver.state, "v.kernelquest") === 2);
  driver.markMap("beaverbrook-defeated");

  // The broadcast trigger deliberately checks only the row and its own
  // one-shot flag. Walking north through row 5 records through the exact
  // frame where omnichannelradioannounce becomes yes.
  driver.goTo(9, 5);
  driver.settle();
  driver.expect("Radio FUD broadcast exposed Omnichannel",
    numeric(driver.state, "v.omnichannelradioannounce") === 1);
  driver.markMap("radio-broadcast");

  const story = {
    hospitalCure: numeric(driver.state, "v.hospitalcure"),
    hospitalBillie: numeric(driver.state, "v.hospitalbillie"),
    nurseSpyder: numeric(driver.state, "v.nurse_spyder"),
    spyderPass: driver.state.sw.items.spyder_pass ?? 0,
    omnichannelReadyWall: numeric(driver.state, "v.omnichannel-ready-wall"),
    omnichannel1Wall: numeric(driver.state, "v.omnichannel1wall"),
    omnichannel1CollisionRemoved,
    beaverbrookWon: driver.state.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true,
    kernelQuest: numeric(driver.state, "v.kernelquest"),
    omnichannelRadioAnnounce: numeric(driver.state, "v.omnichannelradioannounce"),
  };
  const stateJson = canonicalJson(driver.state);
  const maps = driver.maps.map((checkpoint, index) => index === 0
    ? { ...checkpoint, frame: -1 }
    : checkpoint);
  return {
    format: "pocket-tuxemon/j3-omnichannelradioannounce/v1",
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
  const result = runJ3Journey();
  const output = process.env.J3_JOURNEY_OUT ?? join(ROOT, "dist", "j3-omnichannelradioannounce-journey.json");
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`J3 JOURNEY PASS frames=${result.frames} battles=${result.battles.length} ` +
    `end=${result.map}@${result.position.join(",")} state=${result.terminalStateSha256}`);
}

// Deterministic input-only continuation: frozen GB6 + J1 + J2 + J3 terminal ->
// Cotton network outage -> Route E/B -> Data Center Kernel epilogue.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
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
import { buildJ3BaseState, type J3JourneyResult } from "./j3-journey.ts";
import { readInlineProject } from "./generated-project.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(process.env.J4_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const J3_PATH = resolve(
  process.env.J4_BASE_JOURNEY ?? join(ROOT, "data/j3-omnichannelradioannounce-journey.json"),
);
const BTN_CONFIRM = 0x2000;

export interface J4BaseCheckpoint {
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

export interface J4StoryState {
  kernelQuest: number;
  omnichannelRadioAnnounce: number;
  bumpIntoMom: number;
  kernelQuestBegin: number;
  timberMom: number;
  routeBBillie: number;
  dataScreen1: number;
  dataScreen2: number;
  dataScreen3: number;
  dataScreen4: number;
  dataScreen5: number;
  dataScreen6: number;
  dataScreen7: number;
  dataCenterBillie: number;
  spyderPass: number;
  surfboard: number;
  swimming: number;
  goldPass: number;
}

export interface J4StoryCheckpoint extends J4StoryState {
  name: string;
  frame: number;
  map: string;
  position: [number, number];
  battleCount: number;
}

export interface J4JourneyResult {
  format: "pocket-tuxemon/j4-kernelquestdone/v1";
  worldTraversal: "seamless-v1";
  hz: 60;
  frames: number;
  combinedFrames: number;
  durationSeconds: number;
  base: J4BaseCheckpoint;
  map: string;
  position: [number, number];
  masks: number[];
  maps: Gb6MapCheckpoint[];
  battles: Gb6BattleCheckpoint[];
  steps: J4StoryCheckpoint[];
  story: J4StoryState & {
    beaverbrookWon: boolean;
    kernelWon: boolean;
  };
  party: Gb6PartyRow[];
  initialStateSha256: string;
  terminalStateSha256: string;
  tapeSha256: string;
  combinedTapeSha256: string;
}

export interface J4BaseState {
  checkpoint: J4BaseCheckpoint;
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
  if (typeof value !== "number") throw new Error(`J4 journey: ${id} is not numeric`);
  return value;
}

/** Rebuild the frozen J3 terminal, then cross the production save/restore
 * boundary. The checked-in J4 segment stores only this parent identity. */
export function buildJ4BaseState(): J4BaseState {
  const project = readInlineProject(ROOT);
  const parent = buildJ3BaseState();
  const j3 = JSON.parse(readFileSync(J3_PATH, "utf8")) as J3JourneyResult;
  if (j3.format !== "pocket-tuxemon/j3-omnichannelradioannounce/v1" || j3.hz !== 60) {
    throw new Error("J4 journey: unsupported J3 base tape");
  }
  if (j3.frames !== j3.masks.length || sha256(JSON.stringify(j3.masks)) !== j3.tapeSha256) {
    throw new Error("J4 journey: J3 base metadata changed");
  }
  const worldTraversal = journeyWorldTraversal(j3, "J4 journey J3 base tape");
  const j3BaseTraversal = journeyWorldTraversal(j3.base, "J4 journey J3 parent checkpoint");
  if (worldTraversal !== parent.checkpoint.worldTraversal || j3BaseTraversal !== worldTraversal) {
    throw new Error(
      `J4 journey: ancestry traversal mismatch (${parent.checkpoint.worldTraversal}, ${j3BaseTraversal}, ${worldTraversal})`,
    );
  }
  if (canonicalJson({ ...j3.base, worldTraversal: j3BaseTraversal }) !== canonicalJson(parent.checkpoint)) {
    throw new Error("J4 journey: J3 parent checkpoint changed");
  }
  const masks = [...parent.masks, ...j3.masks];
  if (j3.combinedFrames !== masks.length || sha256(JSON.stringify(masks)) !== j3.combinedTapeSha256) {
    throw new Error("J4 journey: J3 combined ancestry changed");
  }
  const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal));
  let state = restoreSessionSnapshot(session, parent.snapshot);
  state.frame = parent.checkpoint.timelineFrame;
  if (sha256(canonicalJson(state)) !== j3.initialStateSha256) {
    throw new Error("J4 journey: restored J3 initial state changed");
  }
  let previous = parent.snapshot.held;
  for (const mask of j3.masks) {
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  const terminalStateSha256 = sha256(canonicalJson(state));
  if (terminalStateSha256 !== j3.terminalStateSha256) {
    throw new Error(`J4 journey: J3 base state changed: ${terminalStateSha256}`);
  }
  const snapshot = createSessionSnapshot(session, state, previous);
  const checkpoint: J4BaseCheckpoint = {
    format: j3.format,
    worldTraversal,
    frames: masks.length,
    tapeSha256: j3.combinedTapeSha256,
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

function walkStraight(driver: Driver, direction: number, count: number, label: string): void {
  const dx = direction === BTN_BITS.LEFT ? -1 : direction === BTN_BITS.RIGHT ? 1 : 0;
  const dy = direction === BTN_BITS.UP ? -1 : direction === BTN_BITS.DOWN ? 1 : 0;
  for (let step = 0; step < count; step++) {
    const map = driver.state.mapId;
    const x = driver.state.move.tx;
    const y = driver.state.move.ty;
    driver.pulse(direction);
    driver.settle();
    driver.expect(`${label} step ${step + 1}/${count}`,
      driver.state.mapId === map && driver.state.move.tx === x + dx && driver.state.move.ty === y + dy);
  }
}

function stateFields(state: SessionState): J4StoryState {
  return {
    kernelQuest: numeric(state, "v.kernelquest"),
    omnichannelRadioAnnounce: numeric(state, "v.omnichannelradioannounce"),
    bumpIntoMom: numeric(state, "v.bumpintomom"),
    kernelQuestBegin: numeric(state, "v.kernelquestbegin"),
    timberMom: numeric(state, "v.timbermom"),
    routeBBillie: numeric(state, "v.routebbillie"),
    dataScreen1: numeric(state, "v.datascreen1"),
    dataScreen2: numeric(state, "v.datascreen2"),
    dataScreen3: numeric(state, "v.datascreen3"),
    dataScreen4: numeric(state, "v.datascreen4"),
    dataScreen5: numeric(state, "v.datascreen5"),
    dataScreen6: numeric(state, "v.datascreen6"),
    dataScreen7: numeric(state, "v.datascreen7"),
    dataCenterBillie: numeric(state, "v.datacenterbillie"),
    spyderPass: state.sw.items.spyder_pass ?? 0,
    surfboard: state.sw.items.surfboard ?? 0,
    swimming: numeric(state, "v.swimming"),
    goldPass: state.sw.items.gold_pass ?? 0,
  };
}

function markStory(driver: Driver, steps: J4StoryCheckpoint[], name: string): void {
  driver.markMap(name);
  steps.push({
    name,
    frame: Math.max(0, driver.masks.length - 1),
    map: driver.state.mapId,
    position: [driver.state.move.tx, driver.state.move.ty],
    battleCount: driver.battles.length,
    ...stateFields(driver.state),
  });
}

export function runJ4Journey(): J4JourneyResult {
  const project = readInlineProject(ROOT);
  const base = buildJ4BaseState();
  const worldTraversal = recordingWorldTraversal(project, "J4 journey");
  if (base.checkpoint.worldTraversal !== worldTraversal) {
    throw new Error(
      `J4 journey: base traversal ${base.checkpoint.worldTraversal} does not match project ${worldTraversal}`,
    );
  }
  const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal));
  const initial = restoreSessionSnapshot(session, base.snapshot);
  initial.frame = base.checkpoint.timelineFrame;
  const initialStateSha256 = sha256(canonicalJson(initial));
  const driver = new Driver(session, 60, initial, base.snapshot.held);
  const steps: J4StoryCheckpoint[] = [];
  driver.settle();
  driver.expect("started at the frozen Radio Tower broadcast terminal",
    driver.state.mapId === "spyder_radiotower" &&
    driver.state.move.tx === 9 && driver.state.move.ty === 5 &&
    numeric(driver.state, "v.kernelquest") === 2 &&
    numeric(driver.state, "v.omnichannelradioannounce") === 1);
  steps.push({
    name: "radio-broadcast",
    frame: -1,
    map: driver.state.mapId,
    position: [driver.state.move.tx, driver.state.move.ty],
    battleCount: 0,
    ...stateFields(driver.state),
  });

  // Retrace the authored Radio Tower and Omnichannel stairs. Cotton
  // Cathedral's new outage witnesses exist only after kernelquest=yes.
  enterFromEdge(driver, 2, 18, BTN_BITS.DOWN, "spyder_omnichannel4");
  enterFromEdge(driver, 1, 13, BTN_BITS.DOWN, "spyder_omnichannel3");
  enterFromEdge(driver, 1, 13, BTN_BITS.DOWN, "spyder_omnichannel2");
  enterFromEdge(driver, 1, 13, BTN_BITS.DOWN, "spyder_omnichannel1");
  enterFromEdge(driver, 1, 13, BTN_BITS.DOWN, "spyder_cotton_town");
  enterFromEdge(driver, 20, 26, BTN_BITS.UP, "spyder_healing_center");
  driver.healAtCenter();
  driver.interactNpc("npc_spyder_cottoncenter_ada");
  driver.expect("Ada reported the authored network outage",
    numeric(driver.state, "v.bumpintomom") === 1 && numeric(driver.state, "v.kernelquest") === 2);
  markStory(driver, steps, "network-outage");

  // Leaving through the Cathedral door lands on the exact Cotton Town tile
  // that runs Mom and the hacker's data-center briefing. The reducer does
  // not synthesize a second playerTouch edge for a transfer landing, so take
  // one ordinary step south and walk back onto the authored trigger tile.
  driver.goTo(6, 9);
  enterFromEdge(driver, 6, 10, BTN_BITS.DOWN, "spyder_cotton_town");
  driver.goTo(20, 28);
  driver.goTo(20, 27);
  driver.settle();
  driver.expect("Cotton briefing started the Kernel quest",
    numeric(driver.state, "v.kernelquestbegin") === 1);
  markStory(driver, steps, "kernel-briefing");

  // The hospital cure made Mom appear in Candy Town with the Surfboard, but
  // J3 followed the broadcast immediately and did not collect it. Use the
  // previously unlocked riverboat to Candy Port, receive the authored item,
  // then take the same riverboat to Timber. The southeast Route E gate is
  // deliberately separated by one water tile.
  // Route E changes Calliope's blocking speech into her quest battle, then
  // Route B leads north to the GoodChat data center.
  enterFromEdge(driver, 22, 39, BTN_BITS.DOWN, "spyder_route1");
  enterFromEdge(driver, 14, 19, BTN_BITS.DOWN, "spyder_paper_town");
  driver.interactNpc("npc_spyder_captain", ["Next >", "Candy Port"]);
  driver.expect("riverboat reached Candy Port", driver.state.mapId === "spyder_candy_port");
  enterFromEdge(driver, 37, 0, BTN_BITS.UP, "spyder_candy_town");
  driver.interactNpc("npc_spyder_papertown_mom");
  driver.expect("Mom granted the post-cure Surfboard",
    numeric(driver.state, "v.timbermom") === 1 && (driver.state.sw.items.surfboard ?? 0) === 1);
  markStory(driver, steps, "surfboard-collected");
  enterFromEdge(driver, 37, 39, BTN_BITS.DOWN, "spyder_candy_port");
  driver.interactNpc("npc_spyder_captain", ["Next >", "Timber Town"]);
  driver.expect("riverboat reached Timber Town", driver.state.mapId === "spyder_timber_town");
  driver.expect("Surfboard remains present", (driver.state.sw.items.surfboard ?? 0) === 1);
  driver.goTo(32, 38);
  driver.interact(3);
  driver.expect("Surf choice entered Timber water",
    driver.state.move.tx === 33 && driver.state.move.ty === 38 &&
    numeric(driver.state, "v.swimming") === 2);
  driver.pulse(BTN_BITS.DOWN);
  driver.settle();
  driver.expect("entered spyder_routee", driver.state.mapId === "spyder_routee");
  // Driver.goTo intentionally plans against authored static terrain. Surf's
  // visit-local passage overrides are exercised here as ordinary held-pad
  // input: down the east channel, west along the cross-channel, then ashore
  // at (6,10), exactly following Route E's surfable label.
  walkStraight(driver, BTN_BITS.DOWN, 8, "Route E swim south");
  walkStraight(driver, BTN_BITS.LEFT, 7, "Route E swim west");
  walkStraight(driver, BTN_BITS.DOWN, 2, "Route E landing");
  driver.expect("Route E landing ended Surf",
    driver.state.move.tx === 6 && driver.state.move.ty === 10 &&
    numeric(driver.state, "v.swimming") === 1);
  enterFromEdge(driver, 19, 16, BTN_BITS.RIGHT, "spyder_routeb");
  markStory(driver, steps, "route-b-entry");
  enterFromEdge(driver, 6, 3, BTN_BITS.UP, "spyder_datacenter");
  driver.expect("Route B Billie scene completed", numeric(driver.state, "v.routebbillie") === 1);
  markStory(driver, steps, "datacenter-entry");

  // Answer the seven upstream terminals correctly. Each answer opens one
  // blocking screen; a wrong answer would add a visible Blasdoor battle.
  driver.goTo(11, 19);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Jemuar"]);
  driver.expect("heaviest answer opened data screen 1",
    numeric(driver.state, "v.heaviest") === 2 && numeric(driver.state, "v.datascreen1") === 1);

  driver.goTo(17, 19);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Baobaraffe"]);
  driver.expect("binary 193 answer opened data screen 2",
    numeric(driver.state, "v.binary193") === 1 && numeric(driver.state, "v.datascreen2") === 1);
  markStory(driver, steps, "datacenter-lower-screens");

  driver.goTo(7, 14);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Snarlon"]);
  driver.expect("tallest answer opened data screen 3",
    numeric(driver.state, "v.tallest") === 3 && numeric(driver.state, "v.datascreen3") === 1);

  driver.goTo(14, 14);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Ignibus"]);
  driver.expect("smallest answer opened data screen 4",
    numeric(driver.state, "v.smallest") === 1 && numeric(driver.state, "v.datascreen4") === 1);
  markStory(driver, steps, "datacenter-middle-screens");

  driver.goTo(4, 9);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Snokari"]);
  driver.expect("lightest answer opened data screen 5",
    numeric(driver.state, "v.lightest") === 2 && numeric(driver.state, "v.datascreen5") === 1);
  driver.fightTouch("spyder_datacenter_lagrange", 2, 4);

  driver.goTo(11, 9);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Shammer"]);
  driver.expect("binary 144 answer opened data screen 6",
    numeric(driver.state, "v.binary144") === 3 && numeric(driver.state, "v.datascreen6") === 1);

  driver.goTo(17, 9);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle(["Shybulb"]);
  driver.expect("binary 77 answer opened data screen 7",
    numeric(driver.state, "v.binary77") === 3 && numeric(driver.state, "v.datascreen7") === 1);
  driver.fightTouch("spyder_datacenter_bayliss", 14, 4);
  markStory(driver, steps, "datacenter-upper-screens");

  const kernelBattles = driver.battles.length;
  driver.goTo(7, 4);
  driver.pulse(BTN_BITS.UP | BTN_CONFIRM);
  driver.settle();
  driver.expect("Kernel battle was won",
    driver.battles.slice(kernelBattles).some((battle) =>
      battle.opponent === "wild:kernel" && battle.outcome === "won"));
  driver.expect("Kernel epilogue completed",
    numeric(driver.state, "v.kernelquest") === 1 &&
    numeric(driver.state, "v.datacenterbillie") === 1);
  driver.expect("minimum mainline left the optional Gold Pass chest closed",
    (driver.state.sw.items.gold_pass ?? 0) === 0);
  markStory(driver, steps, "kernel-defeated");

  const story = {
    ...stateFields(driver.state),
    beaverbrookWon: driver.state.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true,
    kernelWon: driver.battles.some((battle) =>
      battle.opponent === "wild:kernel" && battle.outcome === "won"),
  };
  const stateJson = canonicalJson(driver.state);
  const maps = driver.maps.map((checkpoint, index) => index === 0
    ? { ...checkpoint, frame: -1 }
    : checkpoint);
  return {
    format: "pocket-tuxemon/j4-kernelquestdone/v1",
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
    steps,
    story,
    party: driver.extensionParty(),
    initialStateSha256,
    terminalStateSha256: sha256(stateJson),
    tapeSha256: sha256(JSON.stringify(driver.masks)),
    combinedTapeSha256: sha256(JSON.stringify([...base.masks, ...driver.masks])),
  };
}

if (import.meta.main) {
  const result = runJ4Journey();
  const output = process.env.J4_JOURNEY_OUT ?? join(ROOT, "dist", "j4-kernelquestdone-journey.json");
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`J4 JOURNEY PASS frames=${result.frames} battles=${result.battles.length} ` +
    `end=${result.map}@${result.position.join(",")} state=${result.terminalStateSha256}`);
}

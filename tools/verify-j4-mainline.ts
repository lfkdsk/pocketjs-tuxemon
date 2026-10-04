// Verify the frozen post-radio J4 continuation from its production J3
// save boundary, twice, and from frame zero through the complete ancestry.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { tuxemonExtensionState } from "../battle/extension.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_BATTLE_DB,
  TUXEMON_BATTLE_RULES,
  TUXEMON_EXTENSIONS,
  TUXEMON_SCENES,
} from "../battle/game.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import {
  canonicalJson,
  canSave,
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  journeyWorldTraversal,
  type Gb6BattleCheckpoint,
  type Gb6JourneyResult,
  type Gb6PartyRow,
} from "./gb6-journey.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import type { J2JourneyResult } from "./j2-journey.ts";
import type { J3JourneyResult } from "./j3-journey.ts";
import {
  buildJ4BaseState,
  type J4JourneyResult,
  type J4StoryCheckpoint,
  type J4StoryState,
} from "./j4-journey.ts";
import { readInlineProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const GB6_PATH = resolve(process.env.J4_GB6_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const J1_PATH = resolve(process.env.J4_J1_JOURNEY ?? join(ROOT, "data/j1-captainreturns-journey.json"));
const J2_PATH = resolve(process.env.J4_J2_JOURNEY ?? join(ROOT, "data/j2-hospitalcure-journey.json"));
const J3_PATH = resolve(process.env.J4_BASE_JOURNEY ?? join(ROOT, "data/j3-omnichannelradioannounce-journey.json"));
const JOURNEY_PATH = resolve(
  process.env.J4_JOURNEY ?? join(ROOT, "data/j4-kernelquestdone-journey.json"),
);
const MODE = process.env.J4_VERIFY_MODE ?? "ci";
const BTN_LTRIGGER = 0x0100;
const GAME_OPTIONS = {
  extensions: TUXEMON_EXTENSIONS,
  battle: TUXEMON_BATTLE_RULES,
  scenes: TUXEMON_SCENES,
} as const;
const SAVE_ANCHOR = "datacenter-entry";
const REWIND_ANCHOR = "kernel-defeated";
const REWIND_OPPONENT = "wild:kernel";
const REQUIRED_STEPS = [
  "radio-broadcast",
  "network-outage",
  "kernel-briefing",
  "surfboard-collected",
  "route-b-entry",
  "datacenter-entry",
  "datacenter-lower-screens",
  "datacenter-middle-screens",
  "datacenter-upper-screens",
  "kernel-defeated",
] as const;
const REQUIRED_OPPONENTS: Readonly<Record<string, number>> = {
  "wild:cataspike": 1,
  spyder_routee_calliope: 1,
  spyder_routee_aiolos: 1,
  spyder_routeb_electra: 1,
  spyder_routeb_cytherea: 1,
  spyder_routeb_nephthys: 1,
  spyder_routeb_sedna: 1,
  spyder_routeb_calypso: 1,
  spyder_datacenter_fermi: 1,
  spyder_datacenter_onnes: 1,
  spyder_datacenter_lagrange: 1,
  spyder_datacenter_bayliss: 1,
  spyder_datacenter_chomsky: 1,
  "wild:kernel": 1,
};

interface AncestorBoundary {
  label: string;
  frame: number;
  stateSha256: string;
}

interface SavedPoint {
  nextFrame: number;
  localFrame: number;
  timelineFrame: number;
  envelope: string;
}

interface ReplayResult {
  state: SessionState;
  battles: Gb6BattleCheckpoint[];
  steps: J4StoryCheckpoint[];
  save: SavedPoint | null;
  rewindTargetState: string | null;
  elapsedMs: number;
}

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error("J4 mainline: " + label);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
}

function numeric(state: SessionState, id: string): number {
  const value = state.sw.variables[id];
  if (value === undefined) return 0;
  expect(id + " is not numeric", typeof value === "number");
  return value;
}

function partyRows(party: readonly SpawnedMonsterSnapshot[]): Gb6PartyRow[] {
  return party.map((monster) => ({
    slug: monster.slug,
    level: monster.level,
    hp: monster.currentHp ?? monster.base.hp,
    maxHp: monster.base.hp,
  }));
}

function battlePartyRows(state: ReturnType<typeof tuxemonRuntimeBattleState>): Gb6PartyRow[] {
  return state.battle.parties[0].map((monster) => ({
    slug: monster.slug,
    level: monster.level,
    hp: monster.currentHp,
    maxHp: monster.base.hp,
  }));
}

function storyState(state: SessionState): J4StoryState {
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

function checkMasks(
  label: string,
  tape: { hz: number; frames: number; masks: number[]; tapeSha256: string },
): void {
  expect(label + " is not authored at 60 Hz", tape.hz === 60);
  expect(label + " frame count differs from masks", tape.frames === tape.masks.length);
  expect(label + " tape hash changed", sha256(JSON.stringify(tape.masks)) === tape.tapeSha256);
}

function staticChecks(
  gb6: Gb6JourneyResult,
  j1: J1JourneyResult,
  j2: J2JourneyResult,
  j3: J3JourneyResult,
  journey: J4JourneyResult,
): number[] {
  checkMasks("GB6 ancestor", gb6);
  checkMasks("J1 ancestor", j1);
  checkMasks("J2 ancestor", j2);
  checkMasks("J3 ancestor", j3);
  checkMasks("J4 tape", journey);
  expect("wrong J4 format", journey.format === "pocket-tuxemon/j4-kernelquestdone/v1");

  const throughJ1 = [...gb6.masks, ...j1.masks];
  const throughJ2 = [...throughJ1, ...j2.masks];
  const throughJ3 = [...throughJ2, ...j3.masks];
  expect("J1 ancestry changed", j1.base.frames === gb6.frames &&
    j1.base.tapeSha256 === gb6.tapeSha256 &&
    j1.combinedFrames === throughJ1.length &&
    j1.combinedTapeSha256 === sha256(JSON.stringify(throughJ1)));
  expect("J2 ancestry changed", j2.base.frames === throughJ1.length &&
    j2.base.tapeSha256 === j1.combinedTapeSha256 &&
    j2.combinedFrames === throughJ2.length &&
    j2.combinedTapeSha256 === sha256(JSON.stringify(throughJ2)));
  expect("J3 ancestry changed", j3.base.frames === throughJ2.length &&
    j3.base.tapeSha256 === j2.combinedTapeSha256 &&
    j3.combinedFrames === throughJ3.length &&
    j3.combinedTapeSha256 === sha256(JSON.stringify(throughJ3)));
  expect("J4 parent traversal identity changed",
    journeyWorldTraversal(journey.base, "J4 parent checkpoint") ===
      journeyWorldTraversal(j3, "J4 J3 ancestor tape"));
  expect("J4 traversal identity differs from its ancestry",
    journeyWorldTraversal(journey, "J4 tape") ===
      journeyWorldTraversal(j3, "J4 J3 ancestor tape"));
  expect("J4 parent identity changed", journey.base.format === j3.format &&
    journey.base.frames === throughJ3.length &&
    journey.base.tapeSha256 === j3.combinedTapeSha256 &&
    journey.base.terminalStateSha256 === j3.terminalStateSha256 &&
    journey.base.timelineFrame === throughJ3.length &&
    journey.base.map === j3.map &&
    canonicalJson(journey.base.position) === canonicalJson(j3.position));
  expect("J4 duration differs from frame count",
    journey.durationSeconds === Number((journey.frames / journey.hz).toFixed(3)));
  expect("J4 step sequence changed",
    canonicalJson(journey.steps.map((step) => step.name)) === canonicalJson(REQUIRED_STEPS));
  expect("J4 first step is not the J3 pre-input boundary",
    journey.steps[0]?.frame === -1 && journey.steps[0].map === journey.base.map &&
    canonicalJson(journey.steps[0].position) === canonicalJson(journey.base.position));
  const combined = [...throughJ3, ...journey.masks];
  expect("J4 combined frame count changed", journey.combinedFrames === combined.length);
  expect("J4 combined tape hash changed",
    journey.combinedTapeSha256 === sha256(JSON.stringify(combined)));
  expect("missing " + SAVE_ANCHOR + " save checkpoint",
    journey.steps.some((step) => step.name === SAVE_ANCHOR));
  expect("missing " + REWIND_ANCHOR + " rewind checkpoint",
    journey.steps.some((step) => step.name === REWIND_ANCHOR));
  expect("missing unique Kernel rewind battle",
    journey.battles.filter((battle) => battle.opponent === REWIND_OPPONENT).length === 1);
  return combined;
}

function checkpoint(
  expected: J4StoryCheckpoint,
  state: SessionState,
  battleCount: number,
): J4StoryCheckpoint {
  return {
    name: expected.name,
    frame: expected.frame,
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
    battleCount,
    ...storyState(state),
  };
}

function replay(
  session: Session,
  initial: SessionState,
  masks: readonly number[],
  previousMask: number,
  journey: J4JourneyResult,
  segmentOffset: number,
  boundaries: readonly AncestorBoundary[] = [],
  captureSave = false,
): ReplayResult {
  let state = initial;
  let previous = previousMask;
  let active: Omit<Gb6BattleCheckpoint, "endFrame" | "turns" | "outcome" | "after"> | null = null;
  const battles: Gb6BattleCheckpoint[] = [];
  const steps: J4StoryCheckpoint[] = [];
  const first = journey.steps[0]!;
  const capturePreInputCheckpoint = (): void => {
    const observed = checkpoint(first, state, 0);
    expect("pre-input story checkpoint changed",
      canonicalJson(observed) === canonicalJson(first));
    steps.push(observed);
  };
  if (segmentOffset === 0) capturePreInputCheckpoint();
  const storyAt = new Map(journey.steps.filter((step) => step.frame >= 0)
    .map((step) => [step.frame, step]));
  const mapsAt = new Map<number, typeof journey.maps>();
  for (const mark of journey.maps) {
    if (mark.frame < 0) continue;
    const rows = mapsAt.get(mark.frame) ?? [];
    rows.push(mark);
    mapsAt.set(mark.frame, rows);
  }
  const boundaryAt = new Map(boundaries.map((boundary) => [boundary.frame, boundary]));
  const saveStart = journey.steps.find((step) => step.name === "datacenter-entry")!.frame;
  let save: SavedPoint | null = null;
  const rewindBattle = journey.battles.find((battle) => battle.opponent === REWIND_OPPONENT);
  expect("missing unique Kernel rewind battle",
    rewindBattle !== undefined && journey.battles.filter((battle) => battle.opponent === REWIND_OPPONENT).length === 1);
  let rewindTargetState: string | null = null;
  const started = performance.now();

  for (let frame = 0; frame < masks.length; frame++) {
    if (segmentOffset > 0 && frame === segmentOffset) capturePreInputCheckpoint();
    const localFrame = frame - segmentOffset;
    if (captureSave && localFrame === rewindBattle.startFrame) {
      rewindTargetState = canonicalJson(state);
    }
    const before = state.scene;
    const mask = masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;

    const boundary = boundaryAt.get(frame + 1);
    if (boundary) {
      expect("merged replay changed the frozen " + boundary.label + " boundary",
        digest(state) === boundary.stateSha256);
    }
    if (localFrame >= 0 && before?.kind !== "battle" && state.scene?.kind === "battle") {
      const battle = tuxemonRuntimeBattleState(state.scene.state);
      active = {
        opponent: battle.battle.opponent,
        kind: battle.battle.kind,
        startFrame: localFrame,
        before: battlePartyRows(battle),
        enemy: battle.battle.parties[1].map((monster) => ({ slug: monster.slug, level: monster.level })),
      };
    }
    if (localFrame >= 0 && before?.kind === "battle" && state.scene?.kind !== "battle") {
      expect("battle exit had no entry at J4 frame " + localFrame, active !== null);
      const battle = tuxemonRuntimeBattleState(before.state);
      battles.push({
        ...active,
        endFrame: localFrame + 1,
        turns: battle.battle.turn,
        outcome: battle.battle.result?.outcome ?? "missing",
        after: partyRows(tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party),
      });
      active = null;
    }

    for (const mark of mapsAt.get(localFrame) ?? []) {
      expect("map checkpoint " + mark.name + " changed at J4 frame " + localFrame,
        state.mapId === mark.map && state.move.tx === mark.position[0] && state.move.ty === mark.position[1]);
    }
    const expectedStep = storyAt.get(localFrame);
    if (expectedStep) {
      const observed = checkpoint(expectedStep, state, battles.length);
      expect("story checkpoint " + expectedStep.name + " changed",
        canonicalJson(observed) === canonicalJson(expectedStep));
      steps.push(observed);
    }
    if (captureSave && !save && localFrame >= saveStart &&
      canSave(state.move, state.interp, state.scene)) {
      save = {
        nextFrame: frame + 1,
        localFrame,
        timelineFrame: state.frame,
        envelope: encodeEnvelope(createSessionSnapshot(session, state, mask)),
      };
    }
  }
  expect("tape ended inside Battle Processing", active === null);
  return { state, battles, steps, save, rewindTargetState, elapsedMs: performance.now() - started };
}

function counts(rows: readonly Gb6BattleCheckpoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.opponent] = (out[row.opponent] ?? 0) + 1;
  return out;
}

function validateBattles(label: string, replayed: ReplayResult, journey: J4JourneyResult): void {
  expect(label + " battle trace changed",
    canonicalJson(replayed.battles) === canonicalJson(journey.battles));
  expect(label + " battle count changed", replayed.battles.length === 14);
  expect(label + " trainer count changed",
    replayed.battles.filter((battle) => battle.kind === "trainer").length === 12);
  expect(label + " wild count changed",
    replayed.battles.filter((battle) => battle.kind === "wild").length === 2);
  expect(label + " battle outcome changed",
    replayed.battles.every((battle) => battle.outcome === "won"));
  expect(label + " opponent list changed",
    canonicalJson(counts(replayed.battles)) === canonicalJson(REQUIRED_OPPONENTS));
  expect(label + " contains a wrong-answer Blasdoor battle",
    replayed.battles.every((battle) => battle.opponent !== "wild:blasdoor"));
}

function validateTerminal(label: string, replayed: ReplayResult, journey: J4JourneyResult): void {
  const state = replayed.state;
  expect(label + " endpoint changed", state.mapId === journey.map &&
    state.move.tx === journey.position[0] && state.move.ty === journey.position[1]);
  expect(label + " terminal state hash changed", digest(state) === journey.terminalStateSha256);
  expect(label + " story trace changed",
    canonicalJson(replayed.steps) === canonicalJson(journey.steps));
  expect(label + " story summary changed",
    canonicalJson(storyState(state)) === canonicalJson((({ beaverbrookWon: _b, kernelWon: _k, ...story }) => story)(journey.story)));
  expect(label + " Beaverbrook win missing",
    state.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true);
  expect(label + " Kernel battle missing",
    replayed.battles.filter((battle) => battle.opponent === "wild:kernel" && battle.outcome === "won").length === 1);
  expect(label + " party changed", canonicalJson(partyRows(
    tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party,
  )) === canonicalJson(journey.party));
  expect(label + " answer variables changed",
    numeric(state, "v.heaviest") === 2 && numeric(state, "v.binary193") === 1 &&
    numeric(state, "v.tallest") === 3 && numeric(state, "v.smallest") === 1 &&
    numeric(state, "v.lightest") === 2 && numeric(state, "v.binary144") === 3 &&
    numeric(state, "v.binary77") === 3);
  expect(label + " data screens did not all open",
    [1, 2, 3, 4, 5, 6, 7].every((index) => numeric(state, `v.datascreen${index}`) === 1));
  expect(label + " Kernel/Billie epilogue changed",
    numeric(state, "v.kernelquest") === 1 && numeric(state, "v.datacenterbillie") === 1);
  expect(label + " Surfboard or Gold Pass state changed",
    state.sw.items.surfboard === 1 && (state.sw.items.gold_pass ?? 0) === 0 &&
    numeric(state, "v.swimming") === 1 && state.sw.playerAppearance?.sprite !== "swimmer");
}

function replaySegmentPair(journey: J4JourneyResult): [ReplayResult, ReplayResult] {
  const base = buildJ4BaseState();
  expect("rebuilt base checkpoint changed", canonicalJson(base.checkpoint) === canonicalJson({
    ...journey.base,
    worldTraversal: journeyWorldTraversal(journey.base, "J4 parent checkpoint"),
  }));
  expect("base snapshot hash changed", digest(base.snapshot) === journey.base.terminalSnapshotSha256);
  const run = (): ReplayResult => {
    const project = readInlineProject(ROOT);
    const session = createSession(
      project,
      60,
      createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS),
    );
    const initial = restoreSessionSnapshot(session, base.snapshot);
    initial.frame = journey.base.timelineFrame;
    expect("restored J3 state changed", digest(initial) === journey.initialStateSha256);
    return replay(session, initial, journey.masks, base.snapshot.held, journey, 0);
  };
  const first = run();
  const second = run();
  expect("two J3-save replays produced different terminal states",
    canonicalJson(first.state) === canonicalJson(second.state));
  expect("two J3-save replays produced different battle traces",
    canonicalJson(first.battles) === canonicalJson(second.battles));
  expect("two J3-save replays produced different story traces",
    canonicalJson(first.steps) === canonicalJson(second.steps));
  return [first, second];
}

function replayMerged(
  combined: readonly number[],
  journey: J4JourneyResult,
  boundaries: readonly AncestorBoundary[],
  captureSave = false,
): ReplayResult {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  return replay(
    session,
    startSession(project, session),
    combined,
    0,
    journey,
    journey.base.frames,
    boundaries,
    captureSave,
  );
}

function replayFromSave(combined: readonly number[], point: SavedPoint): SessionState {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  const decoded = decodeEnvelopeText(point.envelope);
  let state = restoreSessionSnapshot(session, decoded);
  state.frame = point.timelineFrame;
  let previous = decoded.held;
  for (let frame = point.nextFrame; frame < combined.length; frame++) {
    const mask = combined[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  return state;
}

function verifyRewind(
  combined: readonly number[],
  journey: J4JourneyResult,
  expectedState: string,
): Record<string, number | boolean | string> {
  const matches = journey.battles.filter((battle) => battle.opponent === REWIND_OPPONENT);
  expect("expected exactly one Kernel battle", matches.length === 1);
  const battle = matches[0]!;
  const anchor = journey.steps.find((step) => step.name === REWIND_ANCHOR);
  expect("missing rewind anchor", anchor !== undefined);
  const target = journey.base.frames + battle.startFrame;
  const from = journey.base.frames + anchor.frame + 1;
  expect("rewind anchor does not follow Kernel", from > target && from <= combined.length);
  const project = readInlineProject(ROOT);
  const controller = new AttractController(project, [], {
    hz: 60,
    attractEnabled: false,
    rewindSeconds: (from - target) / 60,
    ...createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS),
  });
  controller.startPlay();
  for (let frame = 0; frame < from; frame++) controller.step(combined[frame]!);
  expect("rewind origin changed", controller.length === from);
  const started = performance.now();
  const result = controller.step(BTN_LTRIGGER);
  const refoldMs = performance.now() - started;
  expect("L did not report a rewind", result.status.rewound);
  expect("L landed at the wrong frame", controller.length === target);
  expect("L rewind state differs from the original merged prefix",
    canonicalJson(controller.state) === expectedState);
  const stats = controller.keyframeStats();
  expect("L rewind did not use a retained keyframe", stats.lastRefoldStart > 0);
  expect("L rewind refold exceeded one keyframe interval", stats.lastRefoldFrames <= stats.intervalFrames);
  for (let frame = target; frame < combined.length; frame++) controller.step(combined[frame]!);
  expect("post-rewind suffix changed terminal state",
    digest(controller.state) === journey.terminalStateSha256);
  return {
    opponent: battle.opponent,
    anchor: REWIND_ANCHOR,
    target,
    from,
    restored: true,
    keyframeStart: stats.lastRefoldStart,
    refoldFrames: stats.lastRefoldFrames,
    intervalFrames: stats.intervalFrames,
    refoldMs: Number(refoldMs.toFixed(3)),
  };
}

function verifyRate(
  boundaries: readonly AncestorBoundary[],
  journey: J4JourneyResult,
  combined: readonly number[],
  hz: number,
): Record<string, number | string> {
  const project = readInlineProject(ROOT);
  const options = createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS);
  const controller = new AttractController(project, combined, { hz, ...options });
  const referenceSession = createSession(project, 60, options);
  let reference = startSession(project, referenceSession);
  let referenceFrame = 0;
  let previous = 0;
  let comparisons = 0;
  let lastCompared = -1;
  let hostFrames = 0;
  const boundaryAt = new Map(boundaries.map((boundary) => [boundary.frame, boundary]));
  const checked = new Set<number>();
  controller.startAttract();
  const started = performance.now();
  for (; hostFrames < combined.length * 10; hostFrames++) {
    const result = controller.step(0);
    const target = result.status.demoFrame;
    while (referenceFrame < target) {
      const mask = combined[referenceFrame]!;
      reference = stepSession(referenceSession, reference, input(mask, previous));
      previous = mask;
      referenceFrame++;
      const boundary = boundaryAt.get(referenceFrame);
      if (boundary) {
        expect(`${hz} Hz changed the ${boundary.label} boundary`, digest(reference) === boundary.stateSha256);
        checked.add(boundary.frame);
      }
    }
    if (target !== lastCompared) {
      expect(`${hz} Hz diverged at source frame ${target}`,
        Bun.deepEquals(result.state, reference, true));
      comparisons++;
      lastCompared = target;
    }
    if (target === combined.length) break;
  }
  expect(`${hz} Hz attract did not finish`, controller.status().demoFrame === combined.length);
  expect(`${hz} Hz skipped an ancestor boundary`, checked.size === boundaries.length);
  expect(`${hz} Hz terminal changed`, digest(controller.state) === journey.terminalStateSha256);
  return {
    hz,
    hostFrames: hostFrames + 1,
    sourceFrames: referenceFrame,
    comparisons,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    terminalStateSha256: digest(controller.state),
  };
}

expect("unsupported verification mode", [
  "ci",
  "segment",
  "stateful",
  "full",
  "rate-60",
  "rate-30",
  "rate-20",
].includes(MODE));

const gb6 = JSON.parse(readFileSync(GB6_PATH, "utf8")) as Gb6JourneyResult;
const j1 = JSON.parse(readFileSync(J1_PATH, "utf8")) as J1JourneyResult;
const j2 = JSON.parse(readFileSync(J2_PATH, "utf8")) as J2JourneyResult;
const j3 = JSON.parse(readFileSync(J3_PATH, "utf8")) as J3JourneyResult;
const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as J4JourneyResult;
const worldTraversal = journeyWorldTraversal(journey, "J4 tape");
const combined = staticChecks(gb6, j1, j2, j3, journey);
const boundaries: AncestorBoundary[] = [
  { label: "GB6", frame: gb6.frames, stateSha256: gb6.terminalStateSha256 },
  { label: "J1", frame: j1.combinedFrames, stateSha256: j1.terminalStateSha256 },
  { label: "J2", frame: j2.combinedFrames, stateSha256: j2.terminalStateSha256 },
  { label: "J3", frame: j3.combinedFrames, stateSha256: j3.terminalStateSha256 },
];
const report: Record<string, unknown> = {
  mode: MODE,
  parentFrames: journey.base.frames,
  segmentFrames: journey.frames,
  combinedFrames: combined.length,
  terminalStateSha256: journey.terminalStateSha256,
};

if (MODE === "ci" || MODE === "segment" || MODE === "full") {
  const [first, second] = replaySegmentPair(journey);
  validateBattles("segment run 1", first, journey);
  validateBattles("segment run 2", second, journey);
  validateTerminal("segment run 1", first, journey);
  validateTerminal("segment run 2", second, journey);
  report.segmentRunsMs = [Number(first.elapsedMs.toFixed(1)), Number(second.elapsedMs.toFixed(1))];
}

if (MODE === "ci" || MODE === "stateful" || MODE === "full") {
  const merged = replayMerged(combined, journey, boundaries, MODE !== "ci");
  validateBattles("frame-zero", merged, journey);
  validateTerminal("frame-zero", merged, journey);
  report.frameZeroMs = Number(merged.elapsedMs.toFixed(1));
  if (MODE !== "ci") {
    expect("no safe save point after Data Center entry", merged.save !== null);
    expect("missing J4 rewind target state", merged.rewindTargetState !== null);
    const restored = replayFromSave(combined, merged.save);
    expect("save/load suffix changed terminal state", digest(restored) === journey.terminalStateSha256);
    report.save = {
      nextFrame: merged.save.nextFrame,
      localFrame: merged.save.localFrame,
      restored: true,
      terminalStateSha256: digest(restored),
    };
    report.rewind = verifyRewind(combined, journey, merged.rewindTargetState);
  }
}

const rate = /^rate-(60|30|20)$/.exec(MODE);
if (rate) report.rates = [verifyRate(boundaries, journey, combined, Number(rate[1]))];
if (MODE === "full") report.rates = [60, 30, 20].map((hz) =>
  verifyRate(boundaries, journey, combined, hz));

console.log("J4 MAINLINE PASS " + JSON.stringify(report));

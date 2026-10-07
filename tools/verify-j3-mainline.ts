// Verify the frozen J3 continuation both from its J2 terminal snapshot and
// from frame zero with GB6, J1, J2, and J3 concatenated in memory.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { tuxemonExtensionState } from "../battle/extension.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_BATTLE_RULES,
  TUXEMON_EXTENSIONS,
  TUXEMON_SCENES,
} from "../battle/game.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";
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
import type { Gb6BattleCheckpoint, Gb6JourneyResult, Gb6PartyRow } from "./gb6-journey.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import type { J2JourneyResult } from "./j2-journey.ts";
import { buildJ3BaseState, type J3JourneyResult } from "./j3-journey.ts";
import { readInlineProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const GB6_PATH = resolve(process.env.J3_GB6_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const J1_PATH = resolve(process.env.J3_J1_JOURNEY ?? join(ROOT, "data/j1-captainreturns-journey.json"));
const J2_PATH = resolve(process.env.J3_BASE_JOURNEY ?? join(ROOT, "data/j2-hospitalcure-journey.json"));
const JOURNEY_PATH = resolve(
  process.env.J3_JOURNEY ?? join(ROOT, "data/j3-omnichannelradioannounce-journey.json"),
);
const MODE = process.env.J3_VERIFY_MODE ?? "ci";
const BTN_LTRIGGER = 0x0100;
const GAME_OPTIONS = {
  extensions: TUXEMON_EXTENSIONS,
  battle: TUXEMON_BATTLE_RULES,
  scenes: TUXEMON_SCENES,
} as const;
const SAVE_ANCHOR = "omnichannel-wall";
const REWIND_ANCHOR = "beaverbrook-defeated";
const REWIND_OPPONENT = "spyder_omnichannel_beaverbrook";
const REQUIRED_STORY: J3JourneyResult["story"] = {
  hospitalCure: 1,
  hospitalBillie: 1,
  nurseSpyder: 1,
  spyderPass: 1,
  omnichannelReadyWall: 1,
  omnichannel1Wall: 1,
  omnichannel1CollisionRemoved: 1,
  beaverbrookWon: true,
  kernelQuest: 2,
  omnichannelRadioAnnounce: 1,
};
const REQUIRED_TRAINERS: Readonly<Record<string, number>> = {
  spyder_billie: 1,
  spyder_hospital1_rakez: 1,
  spyder_omnichannel_enforcer: 1,
  spyder_omnichannel_william: 1,
  spyder_omnichannel_schwartz: 1,
  spyder_omnichannel_bettger: 1,
  spyder_omnichannel_tohei: 1,
  spyder_omnichannel_crane: 1,
  spyder_omnichannel_dempsey: 1,
  spyder_omnichannel_strauss: 1,
  spyder_omnichannel_carnegie: 1,
  spyder_omnichannel_byrne: 1,
  spyder_omnichannel_beaverbrook: 1,
};

interface SavedPoint {
  nextFrame: number;
  localFrame: number;
  timelineFrame: number;
  envelope: string;
}

interface AncestorBoundary {
  label: string;
  frame: number;
  stateSha256: string;
}

interface ReplayResult {
  state: SessionState;
  battles: Gb6BattleCheckpoint[];
  save: SavedPoint | null;
  rewindTargetState: string | null;
  elapsedMs: number;
}

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error("J3 mainline: " + label);
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
  journey: J3JourneyResult,
): number[] {
  expect("wrong GB6 ancestor format", gb6.format === "pocket-tuxemon/gb6-mainline/v1");
  checkMasks("GB6 ancestor", gb6);

  expect("wrong J1 ancestor format", j1.format === "pocket-tuxemon/j1-captainreturns/v1");
  checkMasks("J1 ancestor", j1);
  expect("J1 parent frame count changed", j1.base.frames === gb6.frames);
  expect("J1 parent tape hash changed", j1.base.tapeSha256 === gb6.tapeSha256);
  expect("J1 parent state hash changed", j1.base.terminalStateSha256 === gb6.terminalStateSha256);
  expect("J1 parent traversal identity changed",
    journeyWorldTraversal(j1.base, "J3 J1 parent checkpoint") ===
      journeyWorldTraversal(gb6, "J3 GB6 ancestor tape"));
  expect("J1 traversal identity differs from GB6",
    journeyWorldTraversal(j1, "J3 J1 ancestor tape") ===
      journeyWorldTraversal(gb6, "J3 GB6 ancestor tape"));
  const throughJ1 = [...gb6.masks, ...j1.masks];
  expect("J1 combined frame count changed", j1.combinedFrames === throughJ1.length);
  expect("J1 combined tape hash changed", sha256(JSON.stringify(throughJ1)) === j1.combinedTapeSha256);

  expect("wrong J2 ancestor format", j2.format === "pocket-tuxemon/j2-hospitalcure/v1");
  checkMasks("J2 ancestor", j2);
  expect("J2 parent format changed", j2.base.format === j1.format);
  expect("J2 parent frame count changed", j2.base.frames === throughJ1.length);
  expect("J2 parent tape hash changed", j2.base.tapeSha256 === j1.combinedTapeSha256);
  expect("J2 parent state hash changed", j2.base.terminalStateSha256 === j1.terminalStateSha256);
  expect("J2 parent traversal identity changed",
    journeyWorldTraversal(j2.base, "J3 J2 parent checkpoint") ===
      journeyWorldTraversal(j1, "J3 J1 ancestor tape"));
  expect("J2 traversal identity differs from its ancestry",
    journeyWorldTraversal(j2, "J3 J2 ancestor tape") ===
      journeyWorldTraversal(j1, "J3 J1 ancestor tape"));
  const throughJ2 = [...throughJ1, ...j2.masks];
  expect("J2 combined frame count changed", j2.combinedFrames === throughJ2.length);
  expect("J2 combined tape hash changed", sha256(JSON.stringify(throughJ2)) === j2.combinedTapeSha256);

  expect("wrong J3 format", journey.format === "pocket-tuxemon/j3-omnichannelradioannounce/v1");
  checkMasks("J3 tape", journey);
  expect("J3 duration differs from frame count",
    journey.durationSeconds === Number((journey.frames / journey.hz).toFixed(3)));
  expect("J3 parent format changed", journey.base.format === j2.format);
  expect("J3 parent frame count changed", journey.base.frames === throughJ2.length);
  expect("J3 parent tape hash changed", journey.base.tapeSha256 === j2.combinedTapeSha256);
  expect("J3 parent state hash changed", journey.base.terminalStateSha256 === j2.terminalStateSha256);
  expect("J3 parent traversal identity changed",
    journeyWorldTraversal(journey.base, "J3 parent checkpoint") ===
      journeyWorldTraversal(j2, "J3 J2 ancestor tape"));
  expect("J3 traversal identity differs from its ancestry",
    journeyWorldTraversal(journey, "J3 tape") === journeyWorldTraversal(j2, "J3 J2 ancestor tape"));
  expect("J3 parent timeline changed", journey.base.timelineFrame === throughJ2.length);
  expect("J3 parent held mask changed",
    journey.base.heldMask === (j2.masks.at(-1) ?? j1.masks.at(-1) ?? gb6.masks.at(-1) ?? 0));
  expect("J3 parent endpoint changed",
    journey.base.map === j2.map &&
    journey.base.position[0] === j2.position[0] &&
    journey.base.position[1] === j2.position[1]);
  expect("J3 story checkpoint changed", canonicalJson(journey.story) === canonicalJson(REQUIRED_STORY));

  const combined = [...throughJ2, ...journey.masks];
  expect("J3 combined frame count changed", journey.combinedFrames === combined.length);
  expect("J3 combined tape hash changed",
    sha256(JSON.stringify(combined)) === journey.combinedTapeSha256);
  expect("J3 start checkpoint must describe the pre-input boundary",
    journey.maps[0]?.name === "start" &&
    journey.maps[0]?.frame === -1 &&
    journey.maps[0]?.map === journey.base.map &&
    journey.maps[0]?.position[0] === journey.base.position[0] &&
    journey.maps[0]?.position[1] === journey.base.position[1]);
  expect("missing " + SAVE_ANCHOR + " save checkpoint",
    journey.maps.some((mark) => mark.name === SAVE_ANCHOR));
  expect("missing " + REWIND_ANCHOR + " rewind checkpoint",
    journey.maps.some((mark) => mark.name === REWIND_ANCHOR));
  expect("missing unique Beaverbrook rewind battle",
    journey.battles.filter((battle) => battle.opponent === REWIND_OPPONENT).length === 1);
  return combined;
}

function validateTerminal(label: string, state: SessionState, journey: J3JourneyResult): void {
  expect(label + " endpoint changed",
    state.mapId === journey.map &&
    state.move.tx === journey.position[0] &&
    state.move.ty === journey.position[1]);
  expect(label + " state hash changed", digest(state) === journey.terminalStateSha256);
  expect(label + " hospital cure missing", numeric(state, "v.hospitalcure") === 1);
  expect(label + " hospital Billie scene missing", numeric(state, "v.hospitalbillie") === 1);
  expect(label + " Omnichannel PC flag missing", numeric(state, "v.omnichannel-ready-wall") === 1);
  expect(label + " Omnichannel wall flag missing", numeric(state, "v.omnichannel1wall") === 1);
  expect(label + " nurse flag missing", numeric(state, "v.nurse_spyder") === 1);
  expect(label + " Spyder Pass missing", (state.sw.items.spyder_pass ?? 0) === 1);
  expect(label + " Beaverbrook win missing",
    state.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true);
  expect(label + " kernelquest missing", numeric(state, "v.kernelquest") === 2);
  expect(label + " radio announcement missing", numeric(state, "v.omnichannelradioannounce") === 1);
  expect(label + " party changed", canonicalJson(partyRows(
    tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party,
  )) === canonicalJson(journey.party));
}

function findRewindBattle(journey: J3JourneyResult): Gb6BattleCheckpoint {
  const matches = journey.battles.filter((battle) => battle.opponent === REWIND_OPPONENT);
  expect("expected exactly one Beaverbrook battle", matches.length === 1);
  return matches[0]!;
}

function replay(
  session: Session,
  initial: SessionState,
  masks: readonly number[],
  previousMask: number,
  journey: J3JourneyResult,
  segmentOffset: number,
  ancestorBoundaries: readonly AncestorBoundary[] = [],
  captureStateful = false,
): ReplayResult {
  let state = initial;
  let previous = previousMask;
  let active: Omit<Gb6BattleCheckpoint, "endFrame" | "turns" | "outcome" | "after"> | null = null;
  const battles: Gb6BattleCheckpoint[] = [];
  const marks = new Map<number, typeof journey.maps>();
  for (const mark of journey.maps) {
    if (mark.frame < 0) continue;
    const rows = marks.get(mark.frame) ?? [];
    rows.push(mark);
    marks.set(mark.frame, rows);
  }
  const boundaryAt = new Map(ancestorBoundaries.map((boundary) => [boundary.frame, boundary]));
  const rewindBattle = findRewindBattle(journey);
  const saveAnchorIndex = journey.maps.findIndex((mark) => mark.name === SAVE_ANCHOR);
  expect("missing save anchor", saveAnchorIndex >= 0);
  const saveAnchor = journey.maps[saveAnchorIndex]!;
  const saveWindowEnd = journey.maps.slice(saveAnchorIndex + 1)
    .find((mark) => mark.frame > saveAnchor.frame)?.frame ?? journey.frames;
  let save: SavedPoint | null = null;
  let rewindTargetState: string | null = null;
  const started = performance.now();

  for (let frame = 0; frame < masks.length; frame++) {
    const localFrame = frame - segmentOffset;
    if (captureStateful && localFrame === rewindBattle.startFrame) {
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
        enemy: battle.battle.parties[1].map((monster) => ({
          slug: monster.slug,
          level: monster.level,
        })),
      };
    }
    if (localFrame >= 0 && before?.kind === "battle" && state.scene?.kind !== "battle") {
      expect("battle exit had no entry at J3 frame " + localFrame, active !== null);
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

    for (const mark of marks.get(localFrame) ?? []) {
      expect("map checkpoint " + mark.name + " diverged at J3 frame " + localFrame,
        state.mapId === mark.map &&
        state.move.tx === mark.position[0] &&
        state.move.ty === mark.position[1]);
      if (mark.name === "omnichannel-wall") {
        expect("wall checkpoint lost the collision-removal state",
          numeric(state, "v.omnichannel1wall") === 1 &&
          numeric(state, "local.collision.spyder_omnichannel1.screen") === 1 &&
          [1, 2, 3, 4].every((index) =>
            state.chars.chars["collision_screen_" + index]?.blocks === false));
      }
    }

    if (captureStateful && !save &&
      localFrame >= saveAnchor.frame && localFrame < saveWindowEnd &&
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
  return { state, battles, save, rewindTargetState, elapsedMs: performance.now() - started };
}

function counts(rows: readonly Gb6BattleCheckpoint[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) result[row.opponent] = (result[row.opponent] ?? 0) + 1;
  return result;
}

function validateBattles(
  label: string,
  battles: readonly Gb6BattleCheckpoint[],
  journey: J3JourneyResult,
): void {
  expect(label + " battle checkpoints changed",
    canonicalJson(battles) === canonicalJson(journey.battles));
  const trainers = battles.filter((battle) => battle.kind === "trainer");
  const wilds = battles.filter((battle) => battle.kind === "wild");
  expect(label + " trainer count changed", trainers.length === 13);
  expect(label + " unexpected wild battle", wilds.length === 0);
  expect(label + " battle did not win", battles.every((battle) => battle.outcome === "won"));
  expect(label + " trainer roster changed",
    canonicalJson(counts(trainers)) === canonicalJson(REQUIRED_TRAINERS));
}

function replayStandalone(journey: J3JourneyResult): ReplayResult {
  const base = buildJ3BaseState();
  expect("base snapshot hash changed", digest(base.snapshot) === journey.base.terminalSnapshotSha256);
  expect("rebuilt base checkpoint changed", canonicalJson(base.checkpoint) === canonicalJson({
    ...journey.base,
    worldTraversal: journeyWorldTraversal(journey.base, "J3 parent checkpoint"),
  }));
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  const initial = restoreSessionSnapshot(session, base.snapshot);
  initial.frame = journey.base.timelineFrame;
  expect("restored initial state hash changed", digest(initial) === journey.initialStateSha256);
  expect("standalone pre-input checkpoint changed",
    initial.mapId === journey.maps[0]!.map &&
    initial.move.tx === journey.maps[0]!.position[0] &&
    initial.move.ty === journey.maps[0]!.position[1]);
  return replay(session, initial, journey.masks, base.snapshot.held, journey, 0);
}

function replayMerged(
  combined: readonly number[],
  journey: J3JourneyResult,
  boundaries: readonly AncestorBoundary[],
  captureStateful = false,
): ReplayResult {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  return replay(
    session,
    startSession(project, session),
    combined,
    0,
    journey,
    journey.base.frames,
    boundaries,
    captureStateful,
  );
}

function replayFromSave(combined: readonly number[], point: SavedPoint): SessionState {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
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
  journey: J3JourneyResult,
  expectedState: string,
): Record<string, number | boolean | string> {
  const battle = findRewindBattle(journey);
  const anchor = journey.maps.find((mark) => mark.name === REWIND_ANCHOR)!;
  const target = journey.base.frames + battle.startFrame;
  const from = journey.base.frames + anchor.frame + 1;
  expect("rewind anchor does not follow Beaverbrook", from > target && from <= combined.length);
  const project = readInlineProject(ROOT);
  const controller = new AttractController(project, [], {
    hz: 60,
    attractEnabled: false,
    rewindSeconds: (from - target) / 60,
    ...mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
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
  expect("L rewind did not use a retained KR2 keyframe", stats.lastRefoldStart > 0);
  expect("L rewind refold exceeded one KR2 interval", stats.lastRefoldFrames <= stats.intervalFrames);
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
  journey: J3JourneyResult,
  combined: readonly number[],
  hz: number,
): Record<string, number | string> {
  const project = readInlineProject(ROOT);
  const options = mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS);
  const controller = new AttractController(project, combined, { hz, ...options });
  const referenceSession = createSession(project, 60, options);
  let reference = startSession(project, referenceSession);
  let referenceFrame = 0;
  let previous = 0;
  let comparisons = 0;
  let lastCompared = -1;
  let hostFrames = 0;
  const boundaryAt = new Map(boundaries.map((boundary) => [boundary.frame, boundary]));
  const checkedBoundaries = new Set<number>();
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
        expect(String(hz) + " Hz changed the frozen " + boundary.label + " boundary",
          digest(reference) === boundary.stateSha256);
        checkedBoundaries.add(boundary.frame);
      }
    }
    if (target !== lastCompared) {
      expect(String(hz) + " Hz state diverged at source frame " + target,
        Bun.deepEquals(result.state, reference, true));
      lastCompared = target;
      comparisons++;
    }
    if (target === combined.length) break;
  }
  expect(String(hz) + " Hz attract did not finish",
    controller.status().demoFrame === combined.length);
  expect(String(hz) + " Hz skipped an ancestor boundary",
    checkedBoundaries.size === boundaries.length);
  expect(String(hz) + " Hz terminal hash changed",
    digest(controller.state) === journey.terminalStateSha256);
  return {
    hz,
    hostFrames: hostFrames + 1,
    sourceFrames: referenceFrame,
    alignedComparisons: comparisons,
    ancestorBoundaries: checkedBoundaries.size,
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
const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as J3JourneyResult;
const worldTraversal = journeyWorldTraversal(journey, "J3 tape");
const combined = staticChecks(gb6, j1, j2, journey);
const boundaries: AncestorBoundary[] = [
  { label: "GB6", frame: gb6.frames, stateSha256: gb6.terminalStateSha256 },
  { label: "J1", frame: j1.combinedFrames, stateSha256: j1.terminalStateSha256 },
  { label: "J2", frame: j2.combinedFrames, stateSha256: j2.terminalStateSha256 },
];
const report: Record<string, unknown> = {
  mode: MODE,
  gb6Frames: gb6.frames,
  j1SegmentFrames: j1.frames,
  j2SegmentFrames: j2.frames,
  parentFrames: journey.base.frames,
  segmentFrames: journey.frames,
  combinedFrames: combined.length,
  terminalStateSha256: journey.terminalStateSha256,
};

if (MODE === "segment" || MODE === "full") {
  const standalone = replayStandalone(journey);
  validateBattles("standalone", standalone.battles, journey);
  validateTerminal("standalone", standalone.state, journey);
  report.standaloneMs = Number(standalone.elapsedMs.toFixed(1));
}

if (MODE === "ci" || MODE === "stateful" || MODE === "full") {
  const merged = replayMerged(combined, journey, boundaries, MODE !== "ci");
  validateBattles("merged", merged.battles, journey);
  validateTerminal("merged", merged.state, journey);
  report.merged60Ms = Number(merged.elapsedMs.toFixed(1));
  report.battles = {
    total: merged.battles.length,
    trainers: merged.battles.filter((battle) => battle.kind === "trainer").length,
    wild: merged.battles.filter((battle) => battle.kind === "wild").length,
  };
  if (MODE !== "ci") {
    expect("no safe J3 save point after " + SAVE_ANCHOR, merged.save !== null);
    expect("missing J3 rewind target state", merged.rewindTargetState !== null);
    const restored = replayFromSave(combined, merged.save);
    validateTerminal("save/load", restored, journey);
    report.save = {
      anchor: SAVE_ANCHOR,
      frame: merged.save.nextFrame,
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

console.log("J3 MAINLINE PASS " + JSON.stringify(report));

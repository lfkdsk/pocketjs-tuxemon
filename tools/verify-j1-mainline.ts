// Verify the frozen J1 continuation both from its GB6 terminal snapshot and
// from frame zero with the GB6 and J1 masks concatenated in memory.

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
import { buildJ1BaseState, type J1JourneyResult } from "./j1-journey.ts";
import { readInlineProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const BASE_PATH = resolve(process.env.J1_BASE_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const JOURNEY_PATH = resolve(process.env.J1_JOURNEY ?? join(ROOT, "data/j1-captainreturns-journey.json"));
const MODE = process.env.J1_VERIFY_MODE ?? "ci";
const BTN_LTRIGGER = 0x0100;
const GAME_OPTIONS = { extensions: TUXEMON_EXTENSIONS, battle: TUXEMON_BATTLE_RULES, scenes: TUXEMON_SCENES } as const;
const REQUIRED_STORY = {
  enforcersResponseDone: 1,
  route4Billie: 1,
  routeABillie: 1,
  foundCaptain: 1,
  captainReturns: 1,
} as const;
const REQUIRED_TRAINERS: Readonly<Record<string, number>> = {
  spyder_route4_rosamund: 1,
  spyder_route4_marshall: 1,
  spyder_route4_beck: 1,
  spyder_billie: 2,
  spyder_routea_koan: 1,
  spyder_routea_dagger: 1,
  spyder_routea_rosy: 1,
  spyder_mansion_lucy: 1,
  spyder_basement_catholi: 1,
};

interface SavedPoint {
  nextFrame: number;
  timelineFrame: number;
  envelope: string;
}

interface ReplayResult {
  state: SessionState;
  battles: Gb6BattleCheckpoint[];
  save: SavedPoint | null;
  rewindTargetState: string | null;
  elapsedMs: number;
}

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`J1 mainline: ${label}`);
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

function staticChecks(base: Gb6JourneyResult, journey: J1JourneyResult): number[] {
  expect("wrong J1 format", journey.format === "pocket-tuxemon/j1-captainreturns/v1");
  expect("J1 tape is not authored at 60 Hz", journey.hz === 60);
  expect("J1 frame count differs from masks", journey.frames === journey.masks.length);
  expect("J1 tape hash changed", sha256(JSON.stringify(journey.masks)) === journey.tapeSha256);
  expect("J1 base frame count changed", journey.base.frames === base.frames);
  expect("J1 base tape hash changed", journey.base.tapeSha256 === base.tapeSha256);
  expect("J1 base state hash changed", journey.base.terminalStateSha256 === base.terminalStateSha256);
  expect("J1 base traversal identity changed",
    journeyWorldTraversal(journey.base, "J1 parent checkpoint") ===
      journeyWorldTraversal(base, "J1 GB6 base tape"));
  expect("J1 traversal identity differs from its base",
    journeyWorldTraversal(journey, "J1 tape") === journeyWorldTraversal(base, "J1 GB6 base tape"));
  expect("J1 base timeline frame changed", journey.base.timelineFrame === base.frames);
  expect("J1 base endpoint changed", journey.base.map === base.map &&
    journey.base.position[0] === base.position[0] && journey.base.position[1] === base.position[1]);
  expect("J1 story checkpoint changed", canonicalJson(journey.story) === canonicalJson(REQUIRED_STORY));
  const combined = [...base.masks, ...journey.masks];
  expect("combined frame count changed", journey.combinedFrames === combined.length);
  expect("combined tape hash changed", sha256(JSON.stringify(combined)) === journey.combinedTapeSha256);
  expect("J1 start checkpoint must describe the pre-input boundary",
    journey.maps[0]?.name === "start" && journey.maps[0]?.frame === -1);
  return combined;
}

function validateTerminal(label: string, state: SessionState, journey: J1JourneyResult): void {
  expect(`${label} endpoint changed`, state.mapId === journey.map &&
    state.move.tx === journey.position[0] && state.move.ty === journey.position[1]);
  expect(`${label} state hash changed`, digest(state) === journey.terminalStateSha256);
  expect(`${label} enforcers_response != done`, state.sw.variables["v.enforcers_response"] === 1);
  expect(`${label} foundcaptain missing`, state.sw.variables["v.foundcaptain"] === 1);
  expect(`${label} captainreturns missing`, state.sw.variables["v.captainreturns"] === 1);
  expect(`${label} party changed`, canonicalJson(partyRows(
    tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party,
  )) === canonicalJson(journey.party));
}

function replay(
  session: Session,
  initial: SessionState,
  masks: readonly number[],
  previousMask: number,
  journey: J1JourneyResult,
  segmentOffset: number,
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
  const saveBattle = journey.battles.find((battle) => battle.opponent === "spyder_billie" &&
    battle.startFrame > 7_000);
  expect("missing Route A Billie save checkpoint", saveBattle !== undefined);
  const rewindBattle = saveBattle;
  let save: SavedPoint | null = null;
  let rewindTargetState: string | null = null;
  const started = performance.now();
  for (let frame = 0; frame < masks.length; frame++) {
    const localFrame = frame - segmentOffset;
    if (captureStateful && localFrame === rewindBattle.startFrame) rewindTargetState = canonicalJson(state);
    const before = state.scene;
    const mask = masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
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
      expect(`battle exit at J1 f${localFrame} had no entry`, active !== null);
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
      expect(`map checkpoint ${mark.name} diverged at J1 f${localFrame}`,
        state.mapId === mark.map && state.move.tx === mark.position[0] && state.move.ty === mark.position[1]);
    }
    if (captureStateful && !save && localFrame >= saveBattle.endFrame &&
      localFrame <= saveBattle.endFrame + 300 && canSave(state.move, state.interp, state.scene)) {
      save = {
        nextFrame: frame + 1,
        timelineFrame: state.frame,
        envelope: encodeEnvelope(createSessionSnapshot(session, state, mask)),
      };
    }
    if (frame + 1 === segmentOffset) {
      expect("merged replay changed the frozen GB6 boundary", digest(state) === journey.base.terminalStateSha256);
    }
  }
  expect("tape ended inside Battle Processing", active === null);
  return { state, battles, save, rewindTargetState, elapsedMs: performance.now() - started };
}

function validateBattles(label: string, battles: readonly Gb6BattleCheckpoint[], journey: J1JourneyResult): void {
  expect(`${label} battle checkpoints changed`, canonicalJson(battles) === canonicalJson(journey.battles));
  const trainers = battles.filter((battle) => battle.kind === "trainer");
  expect(`${label} trainer count changed`, trainers.length === 10);
  expect(`${label} trainer did not win`, trainers.every((battle) => battle.outcome === "won"));
  const counts: Record<string, number> = {};
  for (const battle of trainers) counts[battle.opponent] = (counts[battle.opponent] ?? 0) + 1;
  expect(`${label} trainer roster changed`, canonicalJson(counts) === canonicalJson(REQUIRED_TRAINERS));
}

function replayStandalone(journey: J1JourneyResult): ReplayResult {
  const base = buildJ1BaseState();
  expect("base snapshot hash changed", digest(base.snapshot) === journey.base.terminalSnapshotSha256);
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  const initial = restoreSessionSnapshot(session, base.snapshot);
  initial.frame = journey.base.timelineFrame;
  expect("restored initial state hash changed", digest(initial) === journey.initialStateSha256);
  expect("standalone pre-input checkpoint changed", initial.mapId === journey.maps[0]!.map &&
    initial.move.tx === journey.maps[0]!.position[0] && initial.move.ty === journey.maps[0]!.position[1]);
  return replay(session, initial, journey.masks, base.snapshot.held, journey, 0);
}

function replayMerged(
  combined: readonly number[],
  journey: J1JourneyResult,
  captureStateful = false,
): ReplayResult {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  return replay(session, startSession(project, session), combined, 0, journey, journey.base.frames, captureStateful);
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
  journey: J1JourneyResult,
  expectedState: string,
): Record<string, number | boolean> {
  const battle = journey.battles.find((row) => row.opponent === "spyder_billie" && row.startFrame > 7_000)!;
  const target = journey.base.frames + battle.startFrame;
  const from = journey.base.frames + battle.endFrame + 60;
  const project = readInlineProject(ROOT);
  const controller = new AttractController(project, [], {
    hz: 60,
    attractEnabled: false,
    rewindSeconds: (from - target) / 60,
    ...mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  });
  controller.startPlay();
  for (let frame = 0; frame < from; frame++) controller.step(combined[frame]!);
  const started = performance.now();
  const result = controller.step(BTN_LTRIGGER);
  const refoldMs = performance.now() - started;
  expect("L did not report a rewind", result.status.rewound);
  expect(`L landed at ${controller.length}, expected ${target}`, controller.length === target);
  expect("L rewind state differs from original merged prefix", canonicalJson(controller.state) === expectedState);
  const stats = controller.keyframeStats();
  expect("L rewind did not use a retained KR2 keyframe", stats.lastRefoldStart > 0);
  expect("L rewind refold exceeded one KR2 interval", stats.lastRefoldFrames <= stats.intervalFrames);
  for (let frame = target; frame < combined.length; frame++) controller.step(combined[frame]!);
  expect("post-rewind suffix changed terminal state", digest(controller.state) === journey.terminalStateSha256);
  return {
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
  base: Gb6JourneyResult,
  journey: J1JourneyResult,
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
    }
    if (target !== lastCompared) {
      expect(`${hz} Hz state diverged at source frame ${target}`,
        canonicalJson(result.state) === canonicalJson(reference));
      if (target === base.frames) expect(`${hz} Hz missed exact GB6 boundary`, digest(reference) === base.terminalStateSha256);
      lastCompared = target;
      comparisons++;
    }
    if (target === combined.length) break;
  }
  expect(`${hz} Hz attract did not finish`, controller.status().demoFrame === combined.length);
  expect(`${hz} Hz terminal hash changed`, digest(controller.state) === journey.terminalStateSha256);
  return {
    hz,
    hostFrames: hostFrames + 1,
    sourceFrames: referenceFrame,
    alignedComparisons: comparisons,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    terminalStateSha256: digest(controller.state),
  };
}

expect("unsupported verification mode", ["ci", "segment", "stateful", "full", "rate-60", "rate-30", "rate-20"].includes(MODE));
const base = JSON.parse(readFileSync(BASE_PATH, "utf8")) as Gb6JourneyResult;
const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as J1JourneyResult;
const worldTraversal = journeyWorldTraversal(journey, "J1 tape");
const combined = staticChecks(base, journey);
const report: Record<string, unknown> = {
  mode: MODE,
  baseFrames: base.frames,
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
  const merged = replayMerged(combined, journey, MODE !== "ci");
  validateBattles("merged", merged.battles, journey);
  validateTerminal("merged", merged.state, journey);
  report.merged60Ms = Number(merged.elapsedMs.toFixed(1));
  report.battles = {
    total: merged.battles.length,
    trainers: merged.battles.filter((battle) => battle.kind === "trainer").length,
    wild: merged.battles.filter((battle) => battle.kind === "wild").length,
  };
  if (MODE !== "ci") {
    expect("no safe J1 save point", merged.save !== null);
    expect("missing J1 rewind target state", merged.rewindTargetState !== null);
    const restored = replayFromSave(combined, merged.save);
    validateTerminal("save/load", restored, journey);
    report.save = { frame: merged.save.nextFrame, restored: true, terminalStateSha256: digest(restored) };
    report.rewind = verifyRewind(combined, journey, merged.rewindTargetState);
  }
}

const rate = /^rate-(60|30|20)$/.exec(MODE);
if (rate) report.rates = [verifyRate(base, journey, combined, Number(rate[1]))];
if (MODE === "full") report.rates = [60, 30, 20].map((hz) => verifyRate(base, journey, combined, hz));

console.log(`J1 MAINLINE PASS ${JSON.stringify(report)}`);

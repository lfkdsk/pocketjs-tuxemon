// Verify the frozen GB6 input tape against the production reducer.  The
// default "ci" mode performs one complete 60 Hz replay.  Set
// GB6_VERIFY_MODE=full for the slower 60/30/20 Hz attract, save/load, and
// mid-journey rewind acceptance checks.

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
  type SaveSnapshot,
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
import type {
  Gb6BattleCheckpoint,
  Gb6JourneyResult,
  Gb6PartyRow,
} from "./gb6-journey.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";
import { readInlineProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const JOURNEY_PATH = resolve(process.env.GB6_JOURNEY ?? join(ROOT, "data/gb6-mainline-journey.json"));
const MODE = process.env.GB6_VERIFY_MODE ?? "ci";
const BTN_LTRIGGER = 0x0100;
const GAME_OPTIONS = {
  immutableState: process.env.GB6_IMMUTABLE === "1",
  extensions: TUXEMON_EXTENSIONS,
  battle: TUXEMON_BATTLE_RULES,
  scenes: TUXEMON_SCENES,
} as const;
const REQUIRED_TRAINERS: Readonly<Record<string, number>> = {
  spyder_billie: 2,
  spyder_confusedperson: 1,
  spyder_route2_graf: 1,
  spyder_route2_marion: 1,
  spyder_route2_roddick: 1,
  spyder_citypark_bobette: 1,
  spyder_citypark_edith: 1,
  spyder_citypark_frances: 1,
  spyder_route3_connor: 1,
  spyder_route3_curie: 1,
  spyder_route3_novak: 1,
  spyder_route3_qqq: 1,
  spyder_route3_roxby: 1,
  spyder_route3_surat: 1,
  spyder_route3_twig: 1,
  spyder_route3_wanda: 1,
  spyder_route3_weaver: 1,
  spyder_route3_zoolander: 1,
};
const REQUIRED_STORY: Readonly<Record<string, number | boolean>> = {
  firstfightend: 1,
  firstfightdue: 1,
  confusedchoice: 2,
  visitedcottoncafe: 1,
  route2billiefought: 1,
  shaftscheme: 1,
  zoolanderWon: true,
};

interface SavedPoint {
  nextFrame: number;
  envelope: string;
}

interface ReplayResult {
  state: SessionState;
  battles: Gb6BattleCheckpoint[];
  beforeSave: SavedPoint | null;
  afterSave: SavedPoint | null;
  rewindTargetState: string | null;
  elapsedMs: number;
}

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`GB6 mainline: ${label}`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function canSnapshot(state: SessionState): boolean {
  return canSave(state.move, state.interp, state.scene);
}

function snapshot(session: Session, state: SessionState, held: number, nextFrame: number): SavedPoint {
  return {
    nextFrame,
    envelope: encodeEnvelope(createSessionSnapshot(session, state, held)),
  };
}

function replayBaseline(journey: Gb6JourneyResult): ReplayResult {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  let state = startSession(project, session);
  let previous = 0;
  let active: Omit<Gb6BattleCheckpoint, "endFrame" | "turns" | "outcome" | "after"> | null = null;
  const battles: Gb6BattleCheckpoint[] = [];
  const saveBattle = journey.battles.find((row) => row.opponent === "spyder_route3_connor");
  const rewindBattle = journey.battles.find((row) => row.opponent === "spyder_route3_novak");
  expect("missing Connor save/load checkpoint", saveBattle !== undefined);
  expect("missing Novak rewind checkpoint", rewindBattle !== undefined);
  let beforeSave: SavedPoint | null = null;
  let afterSave: SavedPoint | null = null;
  let rewindTargetState: string | null = null;
  const mapMarks = new Map<number, typeof journey.maps>();
  for (const mark of journey.maps) {
    const rows = mapMarks.get(mark.frame) ?? [];
    rows.push(mark);
    mapMarks.set(mark.frame, rows);
  }
  const started = performance.now();
  for (let frame = 0; frame < journey.masks.length; frame++) {
    const before = state.scene;
    const mask = journey.masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    if (before?.kind !== "battle" && state.scene?.kind === "battle") {
      const battle = tuxemonRuntimeBattleState(state.scene.state);
      active = {
        opponent: battle.battle.opponent,
        kind: battle.battle.kind,
        startFrame: frame,
        before: battlePartyRows(battle),
        enemy: battle.battle.parties[1].map((monster) => ({ slug: monster.slug, level: monster.level })),
      };
    }
    if (before?.kind === "battle" && state.scene?.kind !== "battle") {
      expect(`battle exit at f${frame} had no matching entry`, active !== null);
      const battle = tuxemonRuntimeBattleState(before.state);
      battles.push({
        ...active,
        endFrame: frame + 1,
        turns: battle.battle.turn,
        outcome: battle.battle.result?.outcome ?? "missing",
        after: partyRows(tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party),
      });
      active = null;
    }
    for (const mark of mapMarks.get(frame) ?? []) {
      expect(
        `map checkpoint ${mark.name} diverged at f${frame}: ${state.mapId}@${state.move.tx},${state.move.ty}`,
        state.mapId === mark.map && state.move.tx === mark.position[0] && state.move.ty === mark.position[1],
      );
    }
    const nextFrame = frame + 1;
    if (nextFrame <= saveBattle.startFrame && nextFrame >= saveBattle.startFrame - 300 && canSnapshot(state)) {
      beforeSave = snapshot(session, state, mask, nextFrame);
    }
    if (!afterSave && nextFrame >= saveBattle.endFrame && nextFrame <= saveBattle.endFrame + 300 && canSnapshot(state)) {
      afterSave = snapshot(session, state, mask, nextFrame);
    }
    if (nextFrame === rewindBattle.startFrame) rewindTargetState = canonicalJson(state);
  }
  expect("tape ended inside a battle", active === null);
  return {
    state,
    battles,
    beforeSave,
    afterSave,
    rewindTargetState,
    elapsedMs: performance.now() - started,
  };
}

function replayFromSave(journey: Gb6JourneyResult, point: SavedPoint): SessionState {
  const project = readInlineProject(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  );
  const decoded = decodeEnvelopeText(point.envelope);
  let state = restoreSessionSnapshot(session, decoded);
  let previous = decoded.held;
  for (let frame = point.nextFrame; frame < journey.masks.length; frame++) {
    const mask = journey.masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  return state;
}

function verifySavedEnding(label: string, journey: Gb6JourneyResult, state: SessionState): void {
  expect(`${label} ended on ${state.mapId}@${state.move.tx},${state.move.ty}`,
    state.mapId === journey.map && state.move.tx === journey.position[0] && state.move.ty === journey.position[1]);
  const extension = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB);
  for (const [opponent, count] of Object.entries(REQUIRED_TRAINERS)) {
    const wins = extension.history.filter((row) =>
      row.fighter === "player" && row.opponent === opponent && row.outcome === "won"
    ).length;
    expect(`${label} ${opponent} history count ${wins} != ${count}`, wins === count);
  }
  expect(`${label} lost the Route 3 story gate`, state.sw.variables["v.shaftscheme"] === 1);
}

function verifyRewind(journey: Gb6JourneyResult, expectedState: string): Record<string, number | boolean> {
  const project = readInlineProject(ROOT);
  const battle = journey.battles.find((row) => row.opponent === "spyder_route3_novak");
  expect("missing Novak rewind battle", battle !== undefined);
  const target = battle.startFrame;
  const from = Math.min(journey.frames, battle.endFrame + 60);
  const controller = new AttractController(project, [], {
    hz: 60,
    attractEnabled: false,
    rewindSeconds: (from - target) / 60,
    ...mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS),
  });
  controller.startPlay();
  for (let frame = 0; frame < from; frame++) controller.step(journey.masks[frame]!);
  const started = performance.now();
  const result = controller.step(BTN_LTRIGGER);
  const refoldMs = performance.now() - started;
  expect("L did not report a rewind", result.status.rewound);
  expect(`L rewind landed at ${controller.length}, expected ${target}`, controller.length === target);
  expect("L rewind did not cross to before the Novak battle", controller.state.scene === null);
  expect("L rewind state differs from the original prefix", canonicalJson(controller.state) === expectedState);
  for (let frame = target; frame < journey.masks.length; frame++) controller.step(journey.masks[frame]!);
  expect("replaying the post-rewind suffix changed the terminal state", digest(controller.state) === journey.terminalStateSha256);
  return {
    target,
    from,
    restored: true,
    refoldMs: Number(refoldMs.toFixed(3)),
    historyFrames: controller.length,
    historyAllocatedBytes: controller.historyAllocatedBytes,
  };
}

function verifyAttractRate(journey: Gb6JourneyResult, hz: number): Record<string, number | string> {
  const project = readInlineProject(ROOT);
  const options = mainlineSessionOptions(project, worldTraversal, GAME_OPTIONS);
  const controller = new AttractController(project, journey.masks, { hz, ...options });
  const referenceSession = createSession(project, 60, options);
  let reference = startSession(project, referenceSession);
  let referenceFrame = 0;
  let previous = 0;
  let comparisons = 0;
  let lastCompared = -1;
  let hostFrames = 0;
  let nextProgress = 25_000;
  controller.startAttract();
  const started = performance.now();
  for (; hostFrames < journey.frames * 10; hostFrames++) {
    const result = controller.step(0);
    const target = result.status.demoFrame;
    while (referenceFrame < target) {
      const mask = journey.masks[referenceFrame]!;
      reference = stepSession(referenceSession, reference, input(mask, previous));
      previous = mask;
      referenceFrame++;
    }
    if (target !== lastCompared) {
      expect(
        `${hz} Hz attract state diverged at source frame ${target}`,
        canonicalJson(result.state) === canonicalJson(reference),
      );
      lastCompared = target;
      comparisons++;
      if (target >= nextProgress) {
        console.log(`GB6 RATE progress hz=${hz} sourceFrame=${target}/${journey.frames}`);
        nextProgress += 25_000;
      }
    }
    if (target === journey.frames) break;
  }
  expect(`${hz} Hz attract did not finish`, controller.status().demoFrame === journey.frames);
  expect(`${hz} Hz attract terminal hash changed`, digest(controller.state) === journey.terminalStateSha256);
  return {
    hz,
    hostFrames: hostFrames + 1,
    sourceFrames: referenceFrame,
    alignedComparisons: comparisons,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    terminalStateSha256: digest(controller.state),
  };
}

const rateMode = /^rate-(60|30|20)$/.exec(MODE);
expect(
  `unsupported mode ${MODE}`,
  MODE === "ci" || MODE === "stateful" || MODE === "full" || rateMode !== null,
);
const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as Gb6JourneyResult;
const worldTraversal = journeyWorldTraversal(journey, "GB6 mainline tape");
expect("wrong journey format", journey.format === "pocket-tuxemon/gb6-mainline/v1");
expect("journey is not authored at 60 Hz", journey.hz === 60);
expect("frame count differs from masks", journey.frames === journey.masks.length);
expect(
  "tape hash changed",
  createHash("sha256").update(JSON.stringify(journey.masks)).digest("hex") === journey.tapeSha256,
);
expect("frozen story checkpoint changed", canonicalJson(journey.story) === canonicalJson(REQUIRED_STORY));

const report: Record<string, unknown> = {
  mode: MODE,
  frames: journey.frames,
  durationSeconds: Number((journey.frames / 60).toFixed(3)),
  frozenBattles: journey.battles.length,
  terminalStateSha256: journey.terminalStateSha256,
};

if (!rateMode) {
  const baseline = replayBaseline(journey);
  console.log(`GB6 BASELINE PASS frames=${journey.frames} elapsedMs=${baseline.elapsedMs.toFixed(1)}`);
  expect("battle checkpoints changed during replay", canonicalJson(baseline.battles) === canonicalJson(journey.battles));
  expect("terminal map/position changed", baseline.state.mapId === journey.map &&
    baseline.state.move.tx === journey.position[0] && baseline.state.move.ty === journey.position[1]);
  const actualTerminalStateSha256 = digest(baseline.state);
  expect(
    `terminal state hash ${actualTerminalStateSha256} != ${journey.terminalStateSha256}`,
    actualTerminalStateSha256 === journey.terminalStateSha256,
  );
  const trainers = baseline.battles.filter((row) => row.kind === "trainer");
  expect("a trainer battle did not report won", trainers.every((row) => row.outcome === "won"));
  expect("the journey did not enter 22 trainer battles", trainers.length === 22);
  const extension = tuxemonExtensionState(baseline.state.ext, TUXEMON_BATTLE_DB);
  for (const [opponent, count] of Object.entries(REQUIRED_TRAINERS)) {
    const history = extension.history.filter((row) =>
      row.fighter === "player" && row.opponent === opponent && row.outcome === "won"
    ).length;
    expect(`${opponent} history count ${history} != ${count}`, history === count);
    expect(`${opponent} did not write bo.<opponent>.won`, baseline.state.sw.switches[`bo.${opponent}.won`] === true);
  }
  Object.assign(report, {
    battles: baseline.battles.length,
    trainers: trainers.length,
    wild: baseline.battles.filter((row) => row.kind === "wild").length,
    end: `${baseline.state.mapId}@${baseline.state.move.tx},${baseline.state.move.ty}`,
    baselineMs: Number(baseline.elapsedMs.toFixed(1)),
  });

  if (MODE === "stateful" || MODE === "full") {
  expect("no safe save point before Connor", baseline.beforeSave !== null);
  expect("no safe save point after Connor", baseline.afterSave !== null);
  const beforeState = replayFromSave(journey, baseline.beforeSave);
  const afterState = replayFromSave(journey, baseline.afterSave);
  verifySavedEnding("pre-battle save/load", journey, beforeState);
  verifySavedEnding("post-battle save/load", journey, afterState);
  expect("missing rewind reference prefix", baseline.rewindTargetState !== null);
  report.saves = {
    beforeFrame: baseline.beforeSave.nextFrame,
    afterFrame: baseline.afterSave.nextFrame,
    beforeTerminalStateSha256: digest(beforeState),
    afterTerminalStateSha256: digest(afterState),
    completed: true,
  };
  report.rewind = verifyRewind(journey, baseline.rewindTargetState);
  console.log(`GB6 STATEFUL PASS ${JSON.stringify({ saves: report.saves, rewind: report.rewind })}`);
  }
  if (MODE === "full") report.rates = [60, 30, 20].map((hz) => verifyAttractRate(journey, hz));
} else {
  report.rates = [verifyAttractRate(journey, Number(rateMode[1]))];
}

console.log(`GB6 MAINLINE PASS ${JSON.stringify(report)}`);

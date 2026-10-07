// Save mid-journey, load, finish the tape: the resumed run must end in the
// same state as one uninterrupted replay. Shared by
// tools/verify-save-resume.ts (whole GB6 mainline, CI) and
// tests/save-resume.test.ts (a short prefix).
//
// Every save goes through the game's own save path (ui/save-game.ts): the
// save-point check, a checksummed envelope with the production session's
// content identity, a slot store or a save code, then decode and restore.
// The resumed state continues with the snapshot's held mask as the previous
// input, exactly as the menu hands it to GameView through the overlay host.
//
// SessionState.frame is the host frame counter (the audio driver reads it to
// notice refolds; the reducer never does). A save carries the interpreter
// clock, not that counter, so a restore derives it from interp.frame. The
// comparison therefore sets it back to the uninterrupted run's value before
// hashing, like verify:chapters and verify:j1:stateful, and separately
// checks that `frame` is the only field that differs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";
import { createTuxemonExtensions, tuxemonExtensionState } from "../battle/extension.ts";
import { DAYLIGHT_STAGE_VARIABLE } from "../battle/daylight.ts";
import { timeWeatherAt, type CivilDateTime, FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { canonicalJson, type SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionOptions,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  browserSaveStore,
  exportSaveCode,
  importSaveCode,
  listSlots,
  loadSlot,
  restoreSave,
  saveBlockReason,
  saveSlot,
  takeSaveSnapshot,
  type SlotStore,
  type StorageLike,
} from "../ui/save-game.ts";
import type { ProjectShell, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readShardedProject } from "./generated-project.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const GB6_PATH = join(ROOT, "data/gb6-mainline-journey.json");

export interface Gb6Tape {
  worldTraversal: WorldTraversalMode;
  masks: number[];
  terminalStateSha256: string;
  /** Recorded battle windows and map arrivals, for picking save points. */
  battles: readonly { opponent: string; kind: string; startFrame: number; endFrame: number }[];
  maps: readonly { name: string; frame: number; map: string }[];
}

export function loadGb6Tape(): Gb6Tape {
  const journey = JSON.parse(readFileSync(GB6_PATH, "utf8")) as Omit<Gb6Tape, "worldTraversal"> & {
    worldTraversal?: unknown;
  };
  return {
    worldTraversal: journeyWorldTraversal(journey, "save/resume GB6 tape"),
    masks: journey.masks,
    terminalStateSha256: journey.terminalStateSha256,
    battles: journey.battles,
    maps: journey.maps,
  };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function input(mask: number, previous: number): SessionInput {
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

/** A save-point picker sees every folded frame of the uninterrupted run and
 * says when to save. It is told the state before and after the frame. */
export interface SavePointRule {
  id: string;
  /** Human description for the report. */
  label: string;
  pick(ctx: PickContext): boolean;
}

export interface PickContext {
  /** Frames folded so far (the save would resume at masks[frame]). */
  frame: number;
  total: number;
  prev: SessionState;
  state: SessionState;
  /** Frame at which the most recent battle scene closed, or -1. */
  lastBattleEnd: number;
  /** Frame at which the map last changed, or -1. */
  lastMapChange: number;
  /** Frame at which the daylight stage variable last changed, or -1. */
  lastDaylightChange: number;
}

export interface SavedPoint {
  id: string;
  label: string;
  frame: number;
  timelineFrame: number;
  map: string;
  position: [number, number];
  clock: string;
  daylightStage: number;
  /** The saved screen layer state (daylight tint and its tween). */
  screen: string;
  stateSha256: string;
  envelopeBytes: number;
  channel: "slot" | "code";
  snapshot: SaveSnapshot;
}

export interface ResumeResult {
  id: string;
  frame: number;
  suffixFrames: number;
  terminalSha256: string;
  /** Hash without the frame fix-up; differs only if `frame` differs. */
  rawTerminalSha256: string;
  onlyFrameDiffers: boolean;
  restoredMatchesLive: boolean;
  /** Paths (two levels deep) where the restored state differs from the live
   * state at the save frame. */
  restoredDiff: string[];
}

export interface RunReport {
  start: CivilDateTime;
  frames: number;
  terminalSha256: string;
  terminalMap: string;
  terminalPosition: [number, number];
  points: Omit<SavedPoint, "snapshot">[];
  resumes: ResumeResult[];
}

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function clockLabel(state: SessionState): string {
  const minute = tuxemonExtensionState(state.ext).clock.minuteOfDay;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function daylightStage(state: SessionState): number {
  const stage = state.sw.variables[DAYLIGHT_STAGE_VARIABLE];
  return typeof stage === "number" ? stage : 0;
}

export interface GameSession {
  project: ProjectShell;
  session: Session;
  options: SessionOptions;
}

/** The production sharded project and game registrations, with the clock
 * starting at `start`. */
export function createGameSession(
  start: CivilDateTime,
  worldTraversal: WorldTraversalMode = "legacy-transfer",
): GameSession {
  const { project, repository } = readShardedProject(ROOT);
  const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB, {
    initialTimeWeather: timeWeatherAt(start),
  });
  const options = mainlineSessionOptions(project, worldTraversal, { maps: repository, extensions });
  return { project, session: createSession(project, 60, options), options };
}

/** Two-level path diff between two states, for failure reports. */
export function stateDiff(a: SessionState, b: SessionState): string[] {
  const out: string[] = [];
  const left = JSON.parse(canonicalJson(a)) as Record<string, unknown>;
  const right = JSON.parse(canonicalJson(b)) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const l = left[key];
    const r = right[key];
    if (canonicalJson(l as never) === canonicalJson(r as never)) continue;
    if (l && r && typeof l === "object" && typeof r === "object" && !Array.isArray(l)) {
      const lo = l as Record<string, unknown>;
      const ro = r as Record<string, unknown>;
      for (const sub of new Set([...Object.keys(lo), ...Object.keys(ro)])) {
        if (canonicalJson(lo[sub] as never) !== canonicalJson(ro[sub] as never)) out.push(`${key}.${sub}`);
      }
    } else {
      out.push(key);
    }
  }
  return out;
}

/** Strip the host frame counter for the "only frame differs" comparison. */
function withoutFrame(state: SessionState): Omit<SessionState, "frame"> {
  const { frame: _frame, ...rest } = state;
  return rest;
}

/**
 * Replay `masks` once without interruption, saving at every rule's first
 * match through the game's save path, then resume each save and replay the
 * rest of the tape. Rules alternate between the slot store and the save code.
 */
export function verifySaveResume(
  masks: readonly number[],
  rules: readonly SavePointRule[],
  start: CivilDateTime = FIXED_INITIAL_CIVIL_TIME,
  worldTraversal: WorldTraversalMode = "legacy-transfer",
): RunReport {
  const { project, session } = createGameSession(start, worldTraversal);
  const storage = memoryStorage();
  const slots: SlotStore = { channel: "browser", store: browserSaveStore(storage) };
  const points: SavedPoint[] = [];
  const liveAt = new Map<number, SessionState>();
  const liveNext = new Map<number, SessionState>();
  const pending = new Set(rules.map((rule) => rule.id));

  let state = startSession(project, session);
  let previous = 0;
  let lastBattleEnd = -1;
  let lastMapChange = -1;
  let lastDaylightChange = -1;
  for (let frame = 0; frame < masks.length; frame++) {
    const mask = masks[frame]!;
    const prev = state;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    const folded = frame + 1;
    if (liveAt.has(frame) && !liveNext.has(frame)) liveNext.set(frame, state);
    if (prev.scene !== null && state.scene === null) lastBattleEnd = folded;
    if (prev.mapId !== state.mapId) lastMapChange = folded;
    // Stage 0 is "not set yet": the boot-time write is not a change of day.
    if (daylightStage(prev) !== 0 && daylightStage(prev) !== daylightStage(state)) lastDaylightChange = folded;
    if (pending.size === 0 || saveBlockReason(state) !== null) continue;
    for (const rule of rules) {
      if (!pending.has(rule.id)) continue;
      const ctx: PickContext = {
        frame: folded, total: masks.length, prev, state, lastBattleEnd, lastMapChange, lastDaylightChange,
      };
      if (!rule.pick(ctx)) continue;
      pending.delete(rule.id);
      const snapshot = takeSaveSnapshot(session, state, mask);
      const slot = (points.length % 3) + 1;
      const channel = points.length % 2 === 0 ? "slot" : "code";
      let envelopeBytes: number;
      let decoded: SaveSnapshot;
      if (channel === "slot") {
        saveSlot(slots, slot, snapshot, session.content);
        const listed = listSlots(slots, session.content)[slot - 1];
        if (!listed || "error" in listed) throw new Error(`save ${rule.id}: slot ${slot} does not list as a save`);
        envelopeBytes = storage.map.get(`pocket-tuxemon/save/slot-${slot}`)!.length;
        decoded = loadSlot(slots, slot, session.content);
      } else {
        const code = exportSaveCode(session, snapshot);
        envelopeBytes = code.length;
        decoded = importSaveCode(session, code);
      }
      liveAt.set(folded, state);
      points.push({
        id: rule.id,
        label: rule.label,
        frame: folded,
        timelineFrame: state.frame,
        map: state.mapId,
        position: [state.move.tx, state.move.ty],
        clock: clockLabel(state),
        daylightStage: daylightStage(state),
        screen: canonicalJson((state.interp.screen ?? null) as never),
        stateSha256: digest(state),
        envelopeBytes,
        channel,
        snapshot: decoded,
      });
    }
  }
  if (pending.size > 0) throw new Error(`save points never reached: ${[...pending].join(", ")}`);
  const terminal = state;
  const terminalSha256 = digest(terminal);
  const terminalNoFrame = digest(withoutFrame(terminal));

  const resumes: ResumeResult[] = [];
  for (const point of points) {
    // Resume exactly as the menu does: no fix-up, the held mask as the
    // previous input. The reducer never reads `frame`, so the frame offset
    // stays constant to the end and is applied only for hashing.
    let resumed = restoreSave(session, point.snapshot);
    const offset = point.timelineFrame - resumed.frame;
    // The restore leaves the per-map NPC runtime table (state.chars) empty;
    // the reducer rebuilds it from the map on the next step. Compare the
    // restore frame minus that table, and the full state one frame later.
    const live = liveAt.get(point.frame)!;
    const restoreFrameDiff = stateDiff(live, { ...resumed, frame: resumed.frame + offset })
      .filter((path) => path !== "chars.chars");
    let prev = point.snapshot.held >>> 0;
    let restoredDiff = restoreFrameDiff;
    for (let frame = point.frame; frame < masks.length; frame++) {
      const mask = masks[frame]!;
      resumed = stepSession(session, resumed, input(mask, prev));
      prev = mask;
      if (frame === point.frame && liveNext.has(point.frame)) {
        restoredDiff = [
          ...restoreFrameDiff,
          ...stateDiff(liveNext.get(point.frame)!, { ...resumed, frame: resumed.frame + offset })
            .map((path) => `next:${path}`),
        ];
      }
    }
    const restoredMatchesLive = restoredDiff.length === 0;
    resumes.push({
      id: point.id,
      frame: point.frame,
      suffixFrames: masks.length - point.frame,
      terminalSha256: digest({ ...resumed, frame: resumed.frame + offset }),
      rawTerminalSha256: digest(resumed),
      onlyFrameDiffers: digest(withoutFrame(resumed)) === terminalNoFrame,
      restoredMatchesLive,
      restoredDiff,
    });
  }
  return {
    start,
    frames: masks.length,
    terminalSha256,
    terminalMap: terminal.mapId,
    terminalPosition: [terminal.move.tx, terminal.move.ty],
    points: points.map(({ snapshot: _snapshot, ...rest }) => rest),
    resumes,
  };
}

/** First save point after the first battle that ends at or after `from`. */
export function afterBattle(id: string, from: number): SavePointRule {
  return {
    id,
    label: `first save point after a battle that ends at or after frame ${from}`,
    pick: (ctx) => ctx.lastBattleEnd >= from && ctx.frame - ctx.lastBattleEnd <= 600,
  };
}

/** First save point after a map change at or after `from`. */
export function afterMapChange(id: string, from: number): SavePointRule {
  return {
    id,
    label: `first save point after a map change at or after frame ${from}`,
    pick: (ctx) => ctx.lastMapChange >= from && ctx.frame - ctx.lastMapChange <= 600,
  };
}

/** First save point within `window` frames after the daylight stage changed
 * (the tint tweens for four seconds, 240 frames, after the change). */
export function afterDaylightChange(id: string, window = 240): SavePointRule {
  return {
    id,
    label: `first save point within ${window} frames after the daylight stage changed`,
    pick: (ctx) => ctx.lastDaylightChange >= 0 && ctx.frame - ctx.lastDaylightChange <= window,
  };
}

/** Last-minute save before the daylight stage changes: the first save point
 * within `window` frames before `frame`. */
export function beforeFrame(id: string, frame: number, window: number): SavePointRule {
  return {
    id,
    label: `first save point within ${window} frames before frame ${frame}`,
    pick: (ctx) => ctx.frame >= frame - window && ctx.frame < frame,
  };
}

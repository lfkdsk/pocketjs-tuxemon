// Full-corpus K1 freeze scan. Enter every imported map at a known inbound
// landing (or its centre), auto-advance dialogs, and drive every direction.
// A second long window distinguishes a real stuck fiber/input lock from a
// legitimate wait or cutscene. The report is deterministic JSON.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type { SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { materializeShardedProject } from "./generated-project.ts";

// This corpus probe isolates world/event liveness from game-owned extension
// and battle behavior. It must accept every imported call while completing a
// Battle Processing request immediately, including maps outside the shipped
// Spyder battle-data slice.
const SCAN_BATTLE_RULES: BattleRules = {
  start: () => null,
  step: (state) => state,
  done: () => null,
};
const SCAN_SCENE_RULES: SceneRules = {
  start: () => null,
  step: (state) => state,
  done: () => null,
};
const SCAN_OPTIONS = {
  extensions: { allowUnknown: true },
  battle: SCAN_BATTLE_RULES,
  scenes: {
    "rpgkit.nameInput": SCAN_SCENE_RULES,
    "tux.journal": SCAN_SCENE_RULES,
    "tux.monsterPicker": SCAN_SCENE_RULES,
    "tux.pc": SCAN_SCENE_RULES,
    "tux.trade": SCAN_SCENE_RULES,
    "tux.monsterShop": SCAN_SCENE_RULES,
    "tux.daycare": SCAN_SCENE_RULES,
    "tux.radio": SCAN_SCENE_RULES,
    "tux.parkSummary": SCAN_SCENE_RULES,
  },
} as const;

function collectLandings(commands: readonly Command[], landing: Map<string, [number, number]>): void {
  for (const command of commands) {
    if (command.op === "transfer") {
      // Dynamic destinations (the faint-point flow) have no static landing
      // to seed. Their target maps are already covered independently by the
      // corpus-wide centre/inbound scan.
      if (
        typeof command.map === "string" &&
        typeof command.x === "number" &&
        typeof command.y === "number"
      ) {
        if (!landing.has(command.map)) landing.set(command.map, [command.x, command.y]);
      }
    } else if (command.op === "if") {
      collectLandings(command.then, landing);
      collectLandings(command.else ?? [], landing);
    } else if (command.op === "choices") {
      for (const option of command.options) collectLandings(option.commands, landing);
      collectLandings(command.cancel?.commands ?? [], landing);
    }
  }
}

const pads = [BTN_BITS.UP, BTN_BITS.LEFT, BTN_BITS.DOWN, BTN_BITS.RIGHT];
const WINDOW = 6_000;

function step(state: SessionState, session: ReturnType<typeof createSession>, frame: number): SessionState {
  const modal = state.interp.modal;
  return stepSession(session, state, {
    buttons: modal ? 0 : pads[Math.floor(frame / 30) % pads.length]!,
    confirmEdge: !!modal && frame % 2 === 0,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
  });
}

export interface FrozenRow {
  map: string;
  start: [number, number];
  finalMap: string;
  final: [number, number];
  cells: number;
  frames: number;
  inputLocked: boolean;
  blocking: boolean;
  lastWorldProgress: number;
  error?: string;
}

export interface FrozenReport {
  format: "pocket-tuxemon/frozen-k1/v2";
  maps: number;
  windowFrames: number;
  scannedFramesPerMap: number;
  permanentLocks: number;
  permanentBlockingFibers: number;
  errors: number;
  flagged: FrozenRow[];
}

function worldFingerprint(state: SessionState): string {
  const entries = (record: Readonly<Record<string, unknown>>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    state.mapId,
    state.move.tx,
    state.move.ty,
    entries(state.sw.variables),
    entries(state.sw.switches),
    entries(state.sw.self),
    entries(state.sw.items),
    state.sw.gold,
  ]);
}

export function verifyFrozenProject(project: Project, windowFrames = WINDOW): FrozenReport {
  const landing = new Map<string, [number, number]>();
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectLandings(page.commands, landing);
    }
  }

  const totalFrames = windowFrames * 2;
  const rows: FrozenRow[] = [];
  for (const map of project.maps) {
    const start = landing.get(map.id) ?? [Math.floor(map.width / 2), Math.floor(map.height / 2)];
    const localProject: Project = {
      ...project,
      start: { map: map.id, x: start[0], y: start[1], dir: "down" },
    };
    const session = createSession(localProject, 60, SCAN_OPTIONS);
    let state = startSession(localProject, session);
    const cells = new Set<string>();
    let error: string | undefined;
    let frames = 0;
    let lastUnlocked = 0;
    let lastWorldProgress = 0;
    let previousWorld = worldFingerprint(state);
    let lastBusy = -1;
    try {
      for (; frames < totalFrames; frames++) {
        state = step(state, session, frames);
        if (state.interp.error) {
          error = state.interp.error.message;
          break;
        }
        if (state.mapId === map.id) cells.add(`${state.move.tx},${state.move.ty}`);
        if (!state.interp.inputLocked) lastUnlocked = frames + 1;
        const fingerprint = worldFingerprint(state);
        if (fingerprint !== previousWorld) {
          lastWorldProgress = frames + 1;
          previousWorld = fingerprint;
        }
        if (state.interp.main || state.interp.modal || state.interp.inputLocked) lastBusy = frames + 1;
      }
    } catch (caught) {
      error = String(caught);
    }
    const row: FrozenRow = {
      map: map.id,
      start,
      finalMap: state.mapId,
      final: [state.move.tx, state.move.ty],
      cells: cells.size,
      frames,
      inputLocked: state.interp.inputLocked && frames - lastUnlocked >= windowFrames,
      // A repeating dialogue changes interpreter PCs and modal text forever but
      // makes no world progress. Count it even when an autorun restart leaves a
      // one-frame gap with no main fiber.
      blocking: lastBusy >= frames - 2 && frames - lastWorldProgress >= windowFrames,
      lastWorldProgress,
      ...(error ? { error } : {}),
    };
    if (row.inputLocked || row.blocking || row.error) rows.push(row);
  }

  return {
    format: "pocket-tuxemon/frozen-k1/v2",
    maps: project.maps.length,
    windowFrames,
    scannedFramesPerMap: totalFrames,
    permanentLocks: rows.filter((row) => row.inputLocked).length,
    permanentBlockingFibers: rows.filter((row) => row.blocking).length,
    errors: rows.filter((row) => row.error).length,
    flagged: rows,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const projectArg = args.find((arg) => !arg.startsWith("--"));
  const projectPath = projectArg ? resolve(projectArg) : null;
  const outArg = args.find((arg) => arg.startsWith("--out="));
  const outPath = resolve(outArg?.slice("--out=".length) ?? "dist/frozen-k1.json");
  const project = projectPath
    ? JSON.parse(readFileSync(projectPath, "utf8")) as Project
    : materializeShardedProject(resolve(import.meta.dir, ".."));
  const report = verifyFrozenProject(project);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...report, project: projectPath ?? "dist/project-shell.json" }, null, 2) + "\n");
  console.log(
    `K1 freeze scan: ${report.maps} maps; ${report.permanentLocks} permanent input locks; ` +
    `${report.permanentBlockingFibers} permanent blocking fibers; ${report.errors} errors`,
  );
  console.log(`Report: ${outPath}`);
  if (report.flagged.length) {
    for (const row of report.flagged) console.log(JSON.stringify(row));
    process.exitCode = 1;
  }
}

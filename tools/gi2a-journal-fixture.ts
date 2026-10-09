// Production-bundle visual fixture for the Tuxepedia journal scene.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { JournalSceneState, MonsterPickerSceneState } from "../battle/scenes.ts";
import type { BattleDb, BattleRuntimeShell } from "../importer/battle-schema.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { NameInputState } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { battlePreviewSourcePath } from "./render-battle-preview.ts";

export const GI2A_JOURNAL_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const GI2A_VISUAL_CASES = [
  "unknown",
  "seen",
  "caught",
  "preview",
  "picker",
  "nameInput",
] as const;
export type Gi2aVisualCase = typeof GI2A_VISUAL_CASES[number];

export const GI2A_VISUAL_FILES: Record<Gi2aVisualCase, Record<"480x272" | "960x544", string>> = {
  unknown: {
    "480x272": "gi2a-journal-unknown.480x272.png",
    "960x544": "gi2a-journal-unknown.960x544.png",
  },
  seen: {
    "480x272": "gi2a-journal-seen.480x272.png",
    "960x544": "gi2a-journal-seen.960x544.png",
  },
  caught: {
    "480x272": "gi2a-journal-caught.480x272.png",
    "960x544": "gi2a-journal-caught.960x544.png",
  },
  preview: {
    "480x272": "gi2a-journal.480x272.png",
    "960x544": "gi2a-journal.960x544.png",
  },
  picker: {
    "480x272": "gi2a-monster-picker.480x272.png",
    "960x544": "gi2a-monster-picker.960x544.png",
  },
  nameInput: {
    "480x272": "gi2a-name-input.480x272.png",
    "960x544": "gi2a-name-input.960x544.png",
  },
} as const;

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const SHELL = JSON.parse(
  readFileSync(join(ROOT, "dist/battle-runtime-shell.json"), "utf8"),
) as BattleRuntimeShell;
const DB = JSON.parse(
  readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8"),
) as BattleDb;
const TARGET_ID = "ignibus";
const TARGET_INDEX = SHELL.monstersIndex.findIndex((entry) => entry.id === TARGET_ID);

export interface Gi2aJournalCapture {
  width: number;
  height: number;
  rgba: Uint8Array;
  tree: unknown;
  picker: { rgba: Uint8Array; tree: unknown };
  nameInput: { rgba: Uint8Array; tree: unknown };
  cases: Record<Gi2aVisualCase, { rgba: Uint8Array; tree: unknown }>;
  state: JournalSceneState;
  selected: {
    index: number;
    id: string;
    name: string;
    description: string;
    artPath: string;
    front: [number, number, number, number];
  };
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

/** Mount the persistent unknown/seen/caught journal states, direct-reveal
 * preview, party picker, and name-input screen through the production bundle.
 * Direct state injection isolates rendering while reducer tests separately
 * prove scene opening, navigation, completion, and cancellation. */
export async function captureGi2aJournal(
  viewport: { width: number; height: number },
): Promise<Gi2aJournalCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("GI2a journal fixture: run `bun run build` first");
  }
  if (TARGET_INDEX < 0) throw new Error("GI2a journal fixture: Ignibus is absent from the journal index");
  const monster = DB.monsters[TARGET_ID];
  if (!monster) throw new Error("GI2a journal fixture: Ignibus detail shard is absent");

  const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, viewport);
  pump(world, 1);
  const session = globalThis.__rpgSessionState;
  if (!session) throw new Error("GI2a journal fixture: production session probe is unavailable");
  const fiber = session.interp.main?.key ?? "gi2a-journal-fixture";
  const mount = (id: string, state: JsonValue): { rgba: Uint8Array; tree: unknown } => {
    const live = globalThis.__rpgSessionState;
    if (!live) throw new Error(`GI2a journal fixture: session disappeared before ${id}`);
    live.scene = { kind: "scene", id, fiber, state, pausedTicks: 0 };
    pump(world, 1);
    const mounted = globalThis.__rpgSessionState?.scene;
    if (mounted?.kind !== "scene" || mounted.id !== id) {
      throw new Error(`GI2a journal fixture: production scene ${id} did not mount`);
    }
    return { rgba: world.render().slice(), tree: structuredClone(world.getTree()) };
  };
  const journal = (
    seen: string[],
    caught: string[],
    revealed: string | null,
  ): { capture: { rgba: Uint8Array; tree: unknown }; state: JournalSceneState } => {
    const state: JournalSceneState = {
      kind: "journal",
      cursor: TARGET_INDEX,
      seen,
      caught,
      revealed,
      phase: "browse",
      cancelled: false,
    };
    return { capture: mount("tux.journal", state as unknown as JsonValue), state };
  };
  const unknown = journal([], [], null);
  const seen = journal([TARGET_ID], [], null);
  const caught = journal([], [TARGET_ID], null);
  const preview = journal(["budaye"], ["embazook"], TARGET_ID);
  const pickerState: MonsterPickerSceneState = {
    kind: "monsterPicker",
    cursor: 5,
    variable: "v.rename",
    title: "Choose a Tuxemon",
    entries: ["One", "Two", "Three", "Four", "Five", "Six"].map((label, index) => ({
      iid: `fixture-${index + 1}`,
      slug: `fixture_${index + 1}`,
      label,
    })),
    cancellable: false,
    phase: "choose",
    cancelled: false,
  };
  const picker = mount("tux.monsterPicker", pickerState as unknown as JsonValue);
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890.-! ".split("");
  const nameState: NameInputState = {
    buffer: "Ignibus",
    cursor: 0,
    charset,
    columns: 10,
    rows: Math.ceil((charset.length + 3) / 10),
    maxLength: 15,
    title: "Name",
    titleIsDefault: true,
    variable: "tux.rename.name",
    allowEmpty: false,
    phase: "edit",
    cancelled: false,
    swallowCancel: true,
    holdDir: 0,
    holdTicks: 0,
    lastButtons: 0,
    rng: 0,
    random: false,
    randomPool: [],
    ext: session.ext,
  };
  const nameInput = mount("rpgkit.nameInput", nameState as unknown as JsonValue);
  const cases = {
    unknown: unknown.capture,
    seen: seen.capture,
    caught: caught.capture,
    preview: preview.capture,
    picker,
    nameInput,
  } satisfies Record<Gi2aVisualCase, { rgba: Uint8Array; tree: unknown }>;

  return {
    ...viewport,
    rgba: preview.capture.rgba,
    tree: preview.capture.tree,
    picker,
    nameInput,
    cases,
    state: preview.state,
    selected: {
      index: TARGET_INDEX,
      id: TARGET_ID,
      name: monster.name,
      description: monster.description,
      artPath: relative(ROOT, battlePreviewSourcePath(ROOT, monster.art.sheet)).replaceAll("\\", "/"),
      front: [...monster.art.front],
    },
  };
}

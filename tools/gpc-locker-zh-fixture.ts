// Production-bundle visual fixture for the zh_CN PC scene (item locker,
// bag, quantity picker, monster box, party, full/empty prompts). Scene
// states come from the real zh_CN reducers (opened on a fixed extension
// state and stepped with scripted input) and are mounted into the
// production bundle booted in zh_CN, so the pixels are the shipped views.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB_ZH, TUXEMON_SCENES_ZH } from "../battle/game-zh.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { TUXEMON_PC_SCENE_ID } from "../battle/storage-scenes.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneInput } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

export const GPC_ZH_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const GPC_ZH_CASES = [
  "pcMenu",
  "pcBox",
  "pcParty",
  "pcItemLocker",
  "pcItemQuantity",
  "pcItemBag",
  "pcItemEmpty",
  "pcItemFull",
  "pcItemDisband",
] as const;
export type GpcZhCase = typeof GPC_ZH_CASES[number];

export function gpcZhGoldenFile(visualCase: GpcZhCase, viewport: { width: number; height: number }): string {
  return `gpc-zh-${visualCase.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.${viewport.width}x${viewport.height}.png`;
}

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB_ZH);

/** zh_CN item names from the imported project (dist/project.zh_CN.json). */
const ITEM_CATALOG = [
  { id: "potion", name: "治疗药水" },
  { id: "tuxeball", name: "精灵球" },
  { id: "super_potion", name: "超级治疗药水" },
  { id: "revive", name: "复活草" },
  { id: "nu_phone", name: "Nu 手机" },
] as const;

/** Production zh_CN `tux.pc` scene args (labels + box names + notStorable),
 *  read from the imported project (dist/project.zh_CN.json) instead of a
 *  hand-written mirror, so the frames exercise the real import path: a wrong
 *  label mapping in the importer or the .po catalog flows straight into these
 *  frames and their semantic assertions. All six imported `tux.pc` commands
 *  carry identical args (the importer computes them once per language). */
let cachedPcArgs: Record<string, JsonValue> | undefined;
export function importedZhPcArgs(): Record<string, JsonValue> {
  if (cachedPcArgs) return cachedPcArgs;
  const projectPath = join(ROOT, "dist/project.zh_CN.json");
  if (!existsSync(projectPath)) {
    throw new Error("GPC zh fixture: run `bun run import` first (dist/project.zh_CN.json is missing)");
  }
  const project = JSON.parse(readFileSync(projectPath, "utf8")) as {
    maps?: Array<{
      events?: Array<{
        pages?: Array<{
          commands?: Array<{ op?: string; id?: string; args?: Record<string, JsonValue> }>;
        }>;
      }>;
    }>;
  };
  for (const map of project.maps ?? []) {
    for (const event of map.events ?? []) {
      for (const page of event.pages ?? []) {
        for (const command of page.commands ?? []) {
          if (command?.op === "scene" && command.id === TUXEMON_PC_SCENE_ID && command.args) {
            cachedPcArgs = command.args;
            return cachedPcArgs;
          }
        }
      }
    }
  }
  throw new Error("GPC zh fixture: no tux.pc scene command found in dist/project.zh_CN.json");
}

export interface GpcZhFrame {
  rgba: Uint8Array;
  tree: unknown;
  state: JsonValue;
}

export interface GpcZhCapture {
  width: number;
  height: number;
  cases: Record<GpcZhCase, GpcZhFrame>;
}

function monster(slug: string, iid: string, level: number, hpFraction = 1) {
  const spawned = spawnMonster(TUXEMON_BATTLE_DB_ZH, RULE_DB, { rng: level * 977 + iid.length, rngDraws: 0 }, slug, level, { iid });
  return { ...spawned, currentHp: Math.floor(spawned.base.hp * hpFraction) };
}

function fixtureExt(locker?: Record<string, number>): JsonValue {
  const state = initialTuxemonExtensionState();
  state.party = [
    monster("rockitten", "p-rock", 14),
    monster("cateye", "p-cat", 12, 0.4),
    monster("nut", "p-nut", 9, 0.15),
  ];
  state.kennel = [
    monster("budaye", "k-bud", 11),
    monster("aardorn", "k-aard", 8, 0.6),
    monster("bigfin", "k-fin", 16),
    monster("eyenemy", "k-eye", 6),
  ];
  state.kennelBox = true;
  state.boxes = { quarantine: { hidden: false, capacity: 30, monsters: [monster("tikoal", "q-tik", 10)] } };
  if (locker) state.itemLocker = locker;
  return packTuxemonExtensionState(state);
}

function readContext(ext: JsonValue, items: Record<string, number>): ExtensionReadContext {
  return {
    ext,
    switches: {},
    variables: {},
    items,
    gold: 0,
    playerName: "A",
    itemCatalog: ITEM_CATALOG as unknown as ExtensionReadContext["itemCatalog"],
  };
}

function drive(inputs: Partial<SceneInput>[], options: {
  locker?: Record<string, number>;
  items?: Record<string, number>;
} = {}): JsonValue {
  const rules = TUXEMON_SCENES_ZH[TUXEMON_PC_SCENE_ID]!;
  const ext = fixtureExt(options.locker);
  const started = rules.start(ext, importedZhPcArgs(), 0x5eed, readContext(ext, options.items ?? {}));
  if (!started) throw new Error("GPC zh fixture: PC did not open");
  let state = started.state;
  for (const input of inputs) {
    state = rules.step(structuredClone(state), { buttons: 0, ...input }, 1);
  }
  return state;
}

const A = { confirmEdge: true };
const DOWN = { downEdge: true };

/** Thirty distinct item slugs fill the locker to its kind cap. The slugs
 *  are never displayed (the deposit attempt shows the bag list), so they
 *  need no catalog names. */
const FULL_LOCKER = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`kind_${i}`, 1]));

export function gpcZhSceneStates(): Record<GpcZhCase, JsonValue> {
  return {
    // Main menu: all five entries visible, party list in the detail panel.
    pcMenu: drive([], { locker: { potion: 3, tuxeball: 12, super_potion: 1, revive: 1 }, items: { potion: 5, tuxeball: 2 } }),
    // Pick Up -> Kennel: the monster box with zh_CN names and HP bars.
    pcBox: drive([A, A]),
    // Drop Off -> party list.
    pcParty: drive([DOWN, A]),
    // Pick Up Item -> Locker: the item locker list (sorted by slug).
    pcItemLocker: drive([DOWN, DOWN, A, A], { locker: { potion: 3, tuxeball: 12, super_potion: 1, revive: 1 }, items: { potion: 5 } }),
    // Pick Up Item -> Locker -> Take -> quantity picker.
    pcItemQuantity: drive([DOWN, DOWN, A, A, A, A], { locker: { potion: 25, tuxeball: 12 }, items: { tuxeball: 1 } }),
    // Drop Off Item -> bag list (nu_phone is hidden upstream).
    pcItemBag: drive([DOWN, DOWN, A, A], { items: { potion: 5, tuxeball: 2, nu_phone: 1, super_potion: 1 } }),
    // Withdraw the only item, then confirm on the empty locker: itemEmpty.
    pcItemEmpty: drive([DOWN, DOWN, A, A, A, A, A, A], { locker: { potion: 1 } }),
    // Drop Off Item -> bag -> deposit with a full locker: itemLockerFull.
    pcItemFull: drive([DOWN, DOWN, DOWN, A, A, A], { locker: FULL_LOCKER, items: { potion: 5, tuxeball: 2 } }),
    // Pick Up Item -> Locker -> Disband -> quantity confirm: the itemDisbanded
    // message. This case exists so a wrong imported itemDisbanded label (the
    // monster-release wording) is caught by the semantic assertions.
    pcItemDisband: drive([DOWN, DOWN, A, A, A, DOWN, A, A], { locker: { potion: 3, tuxeball: 12 }, items: { potion: 5 } }),
  };
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

export async function captureGpcZh(viewport: { width: number; height: number }): Promise<GpcZhCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("GPC zh fixture: run `bun run build` first");
  }
  const g = globalThis as Record<string, unknown>;
  const previousLang = g.__pocketTuxemonLang;
  try {
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonLang: "zh_CN",
      __pocketTuxemonWorldDiagnostics: undefined,
      __rpgkitBoot: undefined,
    }, undefined, viewport);
    pump(world, 1);
    const session = globalThis.__rpgSessionState;
    if (!session) throw new Error("GPC zh fixture: production session probe is unavailable");
    const fiber = session.interp.main?.key ?? "gpc-zh-fixture";
    const states = gpcZhSceneStates();
    const cases = {} as GpcZhCapture["cases"];
    for (const visualCase of GPC_ZH_CASES) {
      const live = globalThis.__rpgSessionState;
      if (!live) throw new Error(`GPC zh fixture: session disappeared before ${visualCase}`);
      live.scene = { kind: "scene", id: TUXEMON_PC_SCENE_ID, fiber, state: states[visualCase], pausedTicks: 0 };
      // Two frames let lazy monster art resolve from the pak.
      pump(world, 2);
      const mounted = globalThis.__rpgSessionState?.scene;
      if (mounted?.kind !== "scene" || mounted.id !== TUXEMON_PC_SCENE_ID) {
        throw new Error(`GPC zh fixture: production scene ${TUXEMON_PC_SCENE_ID} did not mount`);
      }
      cases[visualCase] = { rgba: world.render().slice(), tree: structuredClone(world.getTree()), state: states[visualCase] };
    }
    return { ...viewport, cases };
  } finally {
    // bootWorld copies the zh_CN override onto globalThis; restore it so the
    // language-detection tests that share a worker still see their own env.
    if (previousLang === undefined) delete g.__pocketTuxemonLang;
    else g.__pocketTuxemonLang = previousLang;
  }
}

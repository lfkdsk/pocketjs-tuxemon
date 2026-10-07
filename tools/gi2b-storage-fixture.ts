// Production-bundle visual fixture for the PC storage, trade and monster
// shop scenes. Scene states come from the real reducers (opened on a fixed
// extension state and stepped with scripted input) and are mounted into the
// production bundle, so the pixels are the shipped views.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB, TUXEMON_SCENES } from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import {
  TUXEMON_MONSTER_SHOP_SCENE_ID,
  TUXEMON_PC_SCENE_ID,
  TUXEMON_TRADE_SCENE_ID,
} from "../battle/storage-scenes.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneInput } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { battlePreviewSourcePath } from "./render-battle-preview.ts";

export const GI2B_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const GI2B_VISUAL_CASES = ["pcBox", "pcOptions", "pcItemLocker", "pcItemQuantity", "pcItemBag", "tradeFlash", "tradeDone", "shop"] as const;
export type Gi2bVisualCase = typeof GI2B_VISUAL_CASES[number];

export function gi2bGoldenFile(visualCase: Gi2bVisualCase, viewport: { width: number; height: number }): string {
  const name = visualCase.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return `gi2b-${name}.${viewport.width}x${viewport.height}.png`;
}

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const DB = JSON.parse(readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8")) as BattleDb;
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);

export interface Gi2bArt {
  slug: string;
  artPath: string;
  front: [number, number, number, number];
}

export interface Gi2bCapture {
  width: number;
  height: number;
  cases: Record<Gi2bVisualCase, { rgba: Uint8Array; tree: unknown; state: JsonValue }>;
  art: Record<"tradeReceived" | "shop", Gi2bArt>;
}

function art(slug: string): Gi2bArt {
  const monster = DB.monsters[slug];
  if (!monster) throw new Error(`GI2b fixture: ${slug} is absent from the runtime database`);
  return {
    slug,
    artPath: relative(ROOT, battlePreviewSourcePath(ROOT, monster.art.sheet)).replaceAll("\\", "/"),
    front: [...monster.art.front],
  };
}

function monster(slug: string, iid: string, level: number, hpFraction = 1) {
  const spawned = spawnMonster(TUXEMON_BATTLE_DB, RULE_DB, { rng: level * 977 + iid.length, rngDraws: 0 }, slug, level, { iid });
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

const ITEM_CATALOG = [
  { id: "potion", name: "Potion" },
  { id: "tuxeball", name: "Tuxeball" },
  { id: "super_potion", name: "Super Potion" },
  { id: "revive", name: "Revive" },
  { id: "antidote", name: "Antidote" },
  { id: "nu_phone", name: "Nu Phone" },
] as const;

function readContext(
  ext: JsonValue,
  variables: Record<string, string> = {},
  gold = 0,
  items: Record<string, number> = {},
) {
  return {
    ext,
    switches: {},
    variables,
    items,
    gold,
    playerName: "A",
    itemCatalog: ITEM_CATALOG as unknown as ExtensionReadContext["itemCatalog"],
  };
}

function drive(id: string, args: JsonValue, inputs: Partial<SceneInput>[], options: {
  variables?: Record<string, string>;
  gold?: number;
  ticks?: number;
  items?: Record<string, number>;
  locker?: Record<string, number>;
} = {}): JsonValue {
  const rules = TUXEMON_SCENES[id]!;
  const ext = fixtureExt(options.locker);
  const started = rules.start(
    ext,
    args,
    0x5eed,
    readContext(ext, options.variables, options.gold, options.items),
  );
  if (!started) throw new Error(`GI2b fixture: ${id} did not open`);
  let state = started.state;
  for (const input of inputs) {
    state = rules.step(structuredClone(state), { buttons: 0, ...input }, options.ticks ?? 1);
  }
  return state;
}

const BOX_NAMES = { boxNames: { Kennel: "Shelter", quarantine: "Quarantine" } };
const BOX_NAMES_LOCKER = { ...BOX_NAMES, notStorable: ["nu_phone"] };

export function gi2bSceneStates(): Record<Gi2bVisualCase, { id: string; state: JsonValue }> {
  return {
    // Pick Up -> Shelter -> second row (display order is by slug).
    pcBox: { id: TUXEMON_PC_SCENE_ID, state: drive(TUXEMON_PC_SCENE_ID, BOX_NAMES, [{ confirmEdge: true }, { confirmEdge: true }, { downEdge: true }]) },
    pcOptions: {
      id: TUXEMON_PC_SCENE_ID,
      state: drive(TUXEMON_PC_SCENE_ID, BOX_NAMES, [{ confirmEdge: true }, { confirmEdge: true }, { downEdge: true }, { confirmEdge: true }]),
    },
    // Pick Up Item -> Locker -> item list (sorted by slug).
    pcItemLocker: {
      id: TUXEMON_PC_SCENE_ID,
      state: drive(
        TUXEMON_PC_SCENE_ID,
        BOX_NAMES_LOCKER,
        [{ downEdge: true }, { downEdge: true }, { confirmEdge: true }, { confirmEdge: true }],
        { locker: { potion: 3, tuxeball: 12, super_potion: 1, antidote: 2, revive: 1 } },
      ),
    },
    // Pick Up Item -> Locker -> Take -> quantity picker.
    pcItemQuantity: {
      id: TUXEMON_PC_SCENE_ID,
      state: drive(
        TUXEMON_PC_SCENE_ID,
        BOX_NAMES_LOCKER,
        [{ downEdge: true }, { downEdge: true }, { confirmEdge: true }, { confirmEdge: true }, { confirmEdge: true }, { confirmEdge: true }],
        { locker: { potion: 25, tuxeball: 12 }, items: { tuxeball: 1 } },
      ),
    },
    // Drop Off Item -> Locker -> bag list (nu_phone is hidden upstream).
    pcItemBag: {
      id: TUXEMON_PC_SCENE_ID,
      state: drive(
        TUXEMON_PC_SCENE_ID,
        BOX_NAMES_LOCKER,
        [{ downEdge: true }, { downEdge: true }, { confirmEdge: true }, { confirmEdge: true }],
        { items: { potion: 5, tuxeball: 2, nu_phone: 1, super_potion: 1 } },
      ),
    },
    // 3.5 s into the eight-second transition: both sprites alternate.
    tradeFlash: {
      id: TUXEMON_TRADE_SCENE_ID,
      state: drive(
        TUXEMON_TRADE_SCENE_ID,
        { variable: "v.cateye", species: "zunna" },
        Array.from({ length: 70 }, () => ({})),
        { variables: { "v.cateye": "p-cat" }, ticks: 3 },
      ),
    },
    tradeDone: {
      id: TUXEMON_TRADE_SCENE_ID,
      state: drive(
        TUXEMON_TRADE_SCENE_ID,
        { variable: "v.cateye", species: "zunna" },
        [{ confirmEdge: true }],
        { variables: { "v.cateye": "p-cat" } },
      ),
    },
    shop: {
      id: TUXEMON_MONSTER_SHOP_SCENE_ID,
      state: drive(
        TUXEMON_MONSTER_SHOP_SCENE_ID,
        {
          economy: "spyder_flower_petshop",
          entries: ["squink", "potturmeist", "fuzzlet", "woodoor", "ziggurat"]
            .map((slug) => ({ slug, price: 500, level: 10, stock: 1 })),
          labels: { title: "Pet Shop" },
        },
        [{ downEdge: true }],
        { gold: 1_250 },
      ),
    },
  };
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

export async function captureGi2b(viewport: { width: number; height: number }): Promise<Gi2bCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("GI2b fixture: run `bun run build` first");
  }
  const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, viewport);
  pump(world, 1);
  const session = globalThis.__rpgSessionState;
  if (!session) throw new Error("GI2b fixture: production session probe is unavailable");
  const fiber = session.interp.main?.key ?? "gi2b-fixture";
  const states = gi2bSceneStates();
  const cases = {} as Gi2bCapture["cases"];
  for (const visualCase of GI2B_VISUAL_CASES) {
    const { id, state } = states[visualCase];
    const live = globalThis.__rpgSessionState;
    if (!live) throw new Error(`GI2b fixture: session disappeared before ${visualCase}`);
    live.scene = { kind: "scene", id, fiber, state, pausedTicks: 0 };
    // Two frames let lazy monster art resolve from the pak.
    pump(world, 2);
    const mounted = globalThis.__rpgSessionState?.scene;
    if (mounted?.kind !== "scene" || mounted.id !== id) {
      throw new Error(`GI2b fixture: production scene ${id} did not mount`);
    }
    cases[visualCase] = { rgba: world.render().slice(), tree: structuredClone(world.getTree()), state };
  }
  return { ...viewport, cases, art: { tradeReceived: art("zunna"), shop: art("potturmeist") } };
}

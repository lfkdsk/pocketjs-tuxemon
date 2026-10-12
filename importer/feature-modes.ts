// Build-time import for the menu features that live outside Tuxemon's normal
// TMX map graph: NuPhone GPS, title-screen Battle, and the title Minigame.
// The runtime consumes only this validated, deterministic document; authored
// locations and difficulty recipes never have a second hand-maintained copy.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTextCatalog, type TextCatalog } from "./l10n.ts";
import { decodePng } from "./png.ts";
import { readYamlEvents, type Cond, type Rule, type TuxEvent } from "./source.ts";
import { randomMonsterCandidatePools } from "./random-monster.ts";
import type {
  AuthoredScriptUsage,
  FeatureImage,
  FeatureLocale,
  FeatureModesRuntimeData,
  LocalizedFeatureText,
  NuPhoneDirection,
  NuPhoneMapData,
  NuPhoneMapPoint,
  StartMenuData,
  TitleBattleData,
  TitleBattleDifficulty,
  TitleMinigameData,
  TitleMinigameDifficulty,
  WorldItemMapData,
} from "../ui/feature-modes-data.ts";

export type { FeatureLocale } from "../ui/feature-modes-data.ts";

export interface FeatureImageSource extends FeatureImage {
  /** Build-only path relative to mods/tuxemon in the pinned source checkout. */
  source: string;
}

export type NuPhoneMapImport = Omit<NuPhoneMapData, "art"> & {
  art: {
    map: FeatureImageSource;
    cursor: FeatureImageSource;
    player: FeatureImageSource;
    phoneIcon: FeatureImageSource;
    appIcon: FeatureImageSource;
  };
};

export type TitleBattleImport = TitleBattleData;

export interface FeatureModesImport {
  format: "pocket-tuxemon/feature-modes/v1";
  nuPhoneMap: NuPhoneMapImport;
  titleBattle: TitleBattleImport;
  titleMinigame: TitleMinigameData;
  startMenu: StartMenuData;
  worldItems: WorldItemMapData;
}

const DIRECTIONS: readonly NuPhoneDirection[] = ["up", "right", "down", "left"];
const DIFFICULTIES = ["beginner", "easy", "normal", "hard", "expert"] as const;
const MINIGAME_DIFFICULTIES = [
  { id: "easy", choices: 3, points: 1, clue: "image" },
  { id: "normal", choices: 5, points: 2, clue: "image" },
  { id: "hard", choices: 5, points: 3, clue: "description" },
] as const satisfies readonly Omit<TitleMinigameDifficulty, "label">[];

function featureCatalogs(): Record<FeatureLocale, TextCatalog> {
  return {
    en_US: createTextCatalog("en_US"),
    zh_CN: createTextCatalog("zh_CN"),
  };
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${at} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${at} must be an integer`);
  }
  return value;
}

function finite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${at} must be a finite number`);
  }
  return value;
}

function numberRecord(value: unknown, at: string): Record<string, number> {
  const source = record(value ?? {}, at);
  return Object.fromEntries(Object.entries(source).map(([key, entry]) => [
    key,
    finite(entry, `${at}.${key}`),
  ]));
}

function stringList(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${at} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function sameMembers(actual: readonly string[], expected: readonly string[], at: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((value, index) => value !== e[index])) {
    throw new Error(`${at} must contain exactly ${expected.join(", ")}`);
  }
}

function translate(catalogs: Readonly<Record<FeatureLocale, TextCatalog>>, key: string): LocalizedFeatureText {
  const en_US = catalogs.en_US.get(key);
  const zh_CN = catalogs.zh_CN.get(key);
  if (!en_US || !zh_CN) throw new Error(`feature modes: missing bilingual text '${key}'`);
  return { en_US, zh_CN };
}

/** Import all copy used by the game-owned START and expanded title menus
 * from Tuxemon's catalogs. The UI owns layout and state, never translations. */
export function loadStartMenu(
  catalogs: Readonly<Record<FeatureLocale, TextCatalog>> = featureCatalogs(),
): StartMenuData {
  const t = (key: string) => translate(catalogs, key);
  return {
    source: "tuxemon/states/start.py",
    root: {
      party: t("menu_monster"),
      bag: t("menu_bag"),
      player: t("menu_player"),
      missions: t("menu_missions"),
      save: t("menu_save"),
      load: t("menu_load"),
      options: t("menu_options"),
      tuxepedia: t("menu_tuxepedia"),
      exit: t("exit"),
    },
    title: {
      newGame: t("menu_new_game"),
      load: t("menu_load"),
      autosave: t("menu_autosave"),
      battle: t("menu_battle"),
      minigame: t("menu_minigame"),
      options: t("menu_options"),
      exit: t("exit"),
    },
    party: {
      info: t("monster_menu_info"),
      techniques: t("monster_menu_tech"),
      move: t("monster_menu_move"),
      sort: t("menu_sort"),
      release: t("monster_menu_release"),
      sortByLevel: t("sort_by_level"),
      sortByHp: t("sort_by_hp"),
      sortByName: t("sort_by_name"),
      sortById: t("sort_by_id"),
      releaseConfirmation: t("release_confirmation"),
      released: t("tuxemon_released"),
    },
    bag: {
      use: t("item_confirm_use"),
      cancel: t("item_confirm_cancel"),
      cannotUseHere: t("item_cannot_use_here"),
      noTarget: t("item_no_available_target"),
    },
    player: {
      wallet: t("player_wallet"),
      playtime: t("player_total_playtime"),
      battles: t("player_battles"),
      seen: t("tuxepedia_data_seen"),
      caught: t("tuxepedia_data_caught"),
    },
    common: {
      yes: t("yes"),
      no: t("no"),
      back: t("menu_back"),
      empty: t("empty"),
      hp: t("hp"),
      armour: t("armour"),
      dodge: t("dodge"),
      melee: t("melee"),
      ranged: t("ranged"),
      speed: t("speed"),
      height: t("height"),
      weight: t("weight"),
      taste: t("taste"),
      accuracy: t("technique_accuracy"),
      potency: t("technique_potency"),
      power: t("technique_power"),
    },
  };
}

function fnv1a32(parts: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Import the exact `MonsterModel.load_cache()` pool used by minigame.py.
 * The upstream cache excludes only txmn_id 0; `randomly`, evolution stage,
 * discovery status and form level do not participate. */
export function loadTitleMinigame(
  sourceRoot: string,
  catalogs: Readonly<Record<FeatureLocale, TextCatalog>> = featureCatalogs(),
): TitleMinigameData {
  const monsterRoot = join(sourceRoot, "mods/tuxemon/db/monster");
  const monsters = readdirSync(monsterRoot)
    .filter((file) => /\.(?:yaml|json)$/.test(file))
    .sort()
    .flatMap((file) => {
      const parsed = Bun.YAML.parse(readFileSync(join(monsterRoot, file), "utf8")) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map((value, index) => {
        const row = record(value, `db/monster/${file}[${index}]`);
        return {
          slug: nonEmptyString(row.slug, `db/monster/${file}[${index}].slug`),
          txmnId: integer(row.txmn_id, `db/monster/${file}[${index}].txmn_id`),
        };
      });
    })
    .filter((monster) => monster.txmnId > 0)
    .map((monster) => monster.slug)
    .sort();
  if (new Set(monsters).size !== monsters.length) {
    throw new Error("title minigame: positive-id monster slugs must be unique");
  }
  for (const slug of monsters) {
    const sheet = join(sourceRoot, "mods/tuxemon/gfx/sprites/battle", `${slug}-sheet.png`);
    if (!existsSync(sheet)) throw new Error(`title minigame: missing front sprite sheet for '${slug}'`);
    if (!catalogs.en_US.get(slug) || !catalogs.zh_CN.get(slug)) {
      throw new Error(`title minigame: missing bilingual monster name '${slug}'`);
    }
    if (!catalogs.en_US.get(`${slug}_description`) || !catalogs.zh_CN.get(`${slug}_description`)) {
      throw new Error(`title minigame: missing bilingual description '${slug}_description'`);
    }
  }
  const difficulties = MINIGAME_DIFFICULTIES.map((difficulty) => ({
    ...difficulty,
    label: translate(catalogs, `level_${difficulty.id}`),
  }));
  return {
    source: "tuxemon/states/minigame.py",
    title: translate(catalogs, "menu_minigame"),
    question: translate(catalogs, "who_is_that"),
    difficultyPrompt: translate(catalogs, "choose_difficulty"),
    scoreLabel: translate(catalogs, "score_label"),
    streakLabel: translate(catalogs, "streak_label"),
    streakBonus: translate(catalogs, "streak_bonus"),
    wrong: translate(catalogs, "generic_wrong"),
    exit: translate(catalogs, "exit"),
    difficulties,
    monsters,
    seed: fnv1a32(["pocket-tuxemon/title-minigame/v1", ...monsters]),
  };
}

function imageSource(sourceRoot: string, source: string, texture: string): FeatureImageSource {
  const path = join(sourceRoot, "mods/tuxemon", source);
  if (!existsSync(path)) throw new Error(`feature modes: missing image ${source}`);
  const image = decodePng(new Uint8Array(readFileSync(path)), source);
  return { source, texture, width: image.width, height: image.height };
}

function itemMenu(value: unknown, slug: string, expected: {
  menuType: "world" | "phone";
  state: "NuPhone" | "NuPhoneMap";
}): { labelKey: string; sprite: string } {
  const row = record(value, `db/item/${slug}.yaml`);
  if (row.slug !== slug) throw new Error(`db/item/${slug}.yaml must declare slug '${slug}'`);
  const menu = record(row.dynamic_menu, `db/item/${slug}.yaml.dynamic_menu`);
  if (menu.menu_type !== expected.menuType || menu.state !== expected.state) {
    throw new Error(
      `db/item/${slug}.yaml must open ${expected.state} from the ${expected.menuType} menu`,
    );
  }
  return {
    labelKey: nonEmptyString(menu.label_key, `db/item/${slug}.yaml.dynamic_menu.label_key`),
    sprite: nonEmptyString(row.sprite, `db/item/${slug}.yaml.sprite`),
  };
}

/** Validate and normalize mods/nu_phone_map.yaml without depending on object
 * key iteration at runtime. Exported so tests can mutate the real parsed
 * document in memory and prove that malformed authored data fails closed. */
export function parseNuPhoneMap(
  value: unknown,
  catalogs: Readonly<Record<FeatureLocale, TextCatalog>>,
): Omit<NuPhoneMapImport, "entry" | "art"> {
  const doc = record(value, "nu_phone_map.yaml");
  nonEmptyString(doc.map_path, "nu_phone_map.yaml.map_path");
  if (!Array.isArray(doc.map_data) || doc.map_data.length === 0) {
    throw new Error("nu_phone_map.yaml.map_data must be a non-empty array");
  }

  const rawGroups = record(doc.map_groups, "nu_phone_map.yaml.map_groups");
  const rawNav = record(doc.nav, "nu_phone_map.yaml.nav");
  const core = new Set(stringList(doc.core, "nu_phone_map.yaml.core"));
  const seenKeys = new Set<string>();
  const points = doc.map_data.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length !== 3) {
      throw new Error(`nu_phone_map.yaml.map_data[${index}] must be [x, y, key]`);
    }
    const x = integer(raw[0], `nu_phone_map.yaml.map_data[${index}][0]`);
    const y = integer(raw[1], `nu_phone_map.yaml.map_data[${index}][1]`);
    const key = nonEmptyString(raw[2], `nu_phone_map.yaml.map_data[${index}][2]`);
    if (x < 0 || x >= 256 || y < 0 || y >= 144) {
      throw new Error(`nu_phone_map.yaml.map_data[${index}] lies outside the 256x144 nominal canvas`);
    }
    if (seenKeys.has(key)) throw new Error(`nu_phone_map.yaml.map_data repeats '${key}'`);
    seenKeys.add(key);
    const mapSlugs = stringList(rawGroups[key], `nu_phone_map.yaml.map_groups.${key}`);
    const navRow = record(rawNav[key], `nu_phone_map.yaml.nav.${key}`);
    sameMembers(Object.keys(navRow), DIRECTIONS, `nu_phone_map.yaml.nav.${key}`);
    const nav = Object.fromEntries(DIRECTIONS.map((direction) => {
      const target = navRow[direction];
      if (target !== null && (typeof target !== "string" || target.length === 0)) {
        throw new Error(`nu_phone_map.yaml.nav.${key}.${direction} must be a location key or null`);
      }
      return [direction, target as string | null];
    })) as Record<NuPhoneDirection, string | null>;
    return {
      key,
      x,
      y,
      label: translate(catalogs, key),
      mapSlugs,
      core: core.has(key),
      nav,
    } satisfies NuPhoneMapPoint;
  });

  sameMembers(Object.keys(rawGroups), [...seenKeys], "nu_phone_map.yaml.map_groups");
  sameMembers(Object.keys(rawNav), [...seenKeys], "nu_phone_map.yaml.nav");
  for (const key of core) {
    if (!seenKeys.has(key)) throw new Error(`nu_phone_map.yaml.core references unknown location '${key}'`);
  }

  const mapToLocation: Record<string, string> = {};
  for (const point of points) {
    for (const slug of point.mapSlugs) {
      if (mapToLocation[slug]) {
        throw new Error(`nu_phone_map.yaml map slug '${slug}' belongs to more than one location`);
      }
      mapToLocation[slug] = point.key;
    }
    for (const direction of DIRECTIONS) {
      const target = point.nav[direction];
      if (target !== null && !seenKeys.has(target)) {
        throw new Error(`nu_phone_map.yaml.nav.${point.key}.${direction} references unknown '${target}'`);
      }
    }
  }

  return {
    source: "mods/nu_phone_map.yaml",
    nominalWidth: 256,
    nominalHeight: 144,
    points,
    mapToLocation: Object.fromEntries(Object.entries(mapToLocation).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )),
  };
}

function exactlyOne<T>(values: readonly T[], at: string): T {
  if (values.length !== 1) throw new Error(`${at} must occur exactly once (found ${values.length})`);
  return values[0]!;
}

function rulesEqual(actual: readonly Rule[], expected: readonly string[], at: string): void {
  const raw = actual.map((rule) => rule.raw);
  if (raw.length !== expected.length || raw.some((value, index) => value !== expected[index])) {
    throw new Error(`${at} differs from the supported authored script`);
  }
}

function conditionsEqual(actual: readonly Cond[], expected: readonly string[], at: string): void {
  rulesEqual(actual, expected, at);
}

function usage(events: readonly TuxEvent[]): AuthoredScriptUsage {
  const actions = new Map<string, number>();
  const conditions = new Map<string, number>();
  for (const event of events) {
    for (const action of event.acts) actions.set(action.type, (actions.get(action.type) ?? 0) + 1);
    for (const condition of event.conds) {
      const key = `${condition.op} ${condition.type}`;
      conditions.set(key, (conditions.get(key) ?? 0) + 1);
    }
  }
  return {
    eventCount: events.length,
    actionCount: [...actions.values()].reduce((sum, count) => sum + count, 0),
    conditionCount: [...conditions.values()].reduce((sum, count) => sum + count, 0),
    eventNames: events.map((event) => event.name),
    actions: Object.fromEntries([...actions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    conditions: Object.fromEntries([...conditions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
}

/** Validate the actual battle_menu event program and derive the five party
 * recipes from its random_monster commands. */
export function parseTitleBattle(
  events: readonly TuxEvent[],
  catalogs: Readonly<Record<FeatureLocale, TextCatalog>>,
  sourceRoot: string,
): TitleBattleImport {
  if (events.some((event) => event.source !== "battle_menu.yaml" || event.kind !== "event")) {
    throw new Error("battle_menu.yaml must contain only event entries from that source file");
  }
  const byName = new Map(events.map((event) => [event.name, event]));
  if (byName.size !== events.length) throw new Error("battle_menu.yaml event names must be unique");
  sameMembers([...byName.keys()], [
    "Environment",
    "Update Time Variables",
    "Create Maple",
    "Start Maple",
    "Post Win",
    "Post Lose",
    "Post Draw",
    ...DIFFICULTIES.map((id) => `Difficulty ${id}`),
  ], "battle_menu.yaml events");

  const environment = byName.get("Environment")!;
  rulesEqual(environment.acts, ["set_environment interior"], "battle_menu.yaml Environment actions");
  conditionsEqual(environment.conds, ["not environment_is interior"], "battle_menu.yaml Environment conditions");
  const updateTime = byName.get("Update Time Variables")!;
  rulesEqual(updateTime.acts, ["update_time player"], "battle_menu.yaml Update Time Variables actions");
  conditionsEqual(updateTime.conds, ["is current_state WorldState"], "battle_menu.yaml Update Time Variables conditions");
  const create = byName.get("Create Maple")!;
  rulesEqual(create.acts, ["create_npc professor,1,1"], "battle_menu.yaml Create Maple actions");
  conditionsEqual(create.conds, ["not char_exists professor"], "battle_menu.yaml Create Maple conditions");
  const start = byName.get("Start Maple")!;
  rulesEqual(start.acts, ["start_battle player,professor"], "battle_menu.yaml Start Maple actions");
  conditionsEqual(start.conds, [
    "is char_exists professor",
    "is party_size player,greater_than,0",
    "is party_size professor,greater_than,0",
    "not char_defeated player",
    "not char_defeated professor",
  ], "battle_menu.yaml Start Maple conditions");

  for (const [name, result] of [["Post Win", "won"], ["Post Lose", "lost"], ["Post Draw", "draw"]] as const) {
    const event = byName.get(name)!;
    rulesEqual(event.acts, ["quit_world"], `battle_menu.yaml ${name} actions`);
    conditionsEqual(event.conds, [
      `is battle_outcome player,${result},professor`,
      "is current_state WorldState",
    ], `battle_menu.yaml ${name} conditions`);
  }

  const recipes = DIFFICULTIES.map((id) => {
    const event = byName.get(`Difficulty ${id}`)!;
    conditionsEqual(event.conds, [
      `is variable_set difficulty:${id}`,
      "is char_exists professor",
      "not variable_set monsters:full",
    ], `battle_menu.yaml Difficulty ${id} conditions`);
    const complete = exactlyOne(
      event.acts.filter((action) => action.raw === "set_variable monsters:full"),
      `battle_menu.yaml Difficulty ${id} completion marker`,
    );
    const random = event.acts.filter((action) => action.type === "random_monster");
    if (event.acts[event.acts.length - 1] !== complete || random.length + 1 !== event.acts.length) {
      throw new Error(`battle_menu.yaml Difficulty ${id} must end after only its random_monster recipe`);
    }
    const player = random.filter((action) => action.args.length === 1);
    const opponent = random.filter((action) => action.args[1] === "professor" && action.args.length === 2);
    if (player.length === 0 || player.length !== opponent.length || player.length + opponent.length !== random.length) {
      throw new Error(`battle_menu.yaml Difficulty ${id} must generate equal non-empty parties`);
    }
    const levels = new Set(random.map((action) => Number(action.args[0])));
    const level = exactlyOne([...levels], `battle_menu.yaml Difficulty ${id} monster level`);
    if (!Number.isInteger(level) || level <= 0) {
      throw new Error(`battle_menu.yaml Difficulty ${id} monster level must be a positive integer`);
    }
    return {
      id,
      label: translate(catalogs, `level_${id}`),
      level,
      partySize: player.length,
    };
  });
  const pools = randomMonsterCandidatePools(sourceRoot, recipes.map((recipe) => recipe.level));
  const difficulties = recipes.map((recipe) => ({
    ...recipe,
    candidates: pools.get(recipe.level)!,
  } satisfies TitleBattleDifficulty));

  return {
    source: "mods/tuxemon/maps/battle_menu.yaml",
    title: translate(catalogs, "menu_battle"),
    difficultyPrompt: translate(catalogs, "choose_difficulty"),
    player: "player",
    opponent: "professor",
    environment: "interior",
    difficulties,
    authored: usage(events),
  };
}

/** Load and validate the out-of-map title Battle program without also
 * decoding the NuPhone artwork. Coverage accounting uses this narrow entry
 * point so it can prove that the exact authored program has a native runtime
 * materialization. */
export function loadTitleBattle(
  sourceRoot: string,
  catalogs: Readonly<Record<FeatureLocale, TextCatalog>> = featureCatalogs(),
): TitleBattleImport {
  const battlePath = join(sourceRoot, "mods/tuxemon/maps/battle_menu.yaml");
  return parseTitleBattle(readYamlEvents(battlePath, "loaded"), catalogs, sourceRoot);
}

/** Read all out-of-map feature sources and their item/menu metadata. */
export function loadFeatureModes(
  sourceRoot: string,
  surfaceLabels: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {},
): FeatureModesImport {
  const catalogs = featureCatalogs();
  const mapPath = join(sourceRoot, "mods/nu_phone_map.yaml");
  const rawMap = Bun.YAML.parse(readFileSync(mapPath, "utf8")) as unknown;
  const rawMapRecord = record(rawMap, "nu_phone_map.yaml");
  const mapSource = nonEmptyString(rawMapRecord.map_path, "nu_phone_map.yaml.map_path");
  const phoneItemPath = join(sourceRoot, "mods/tuxemon/db/item/nu_phone.yaml");
  const appItemPath = join(sourceRoot, "mods/tuxemon/db/item/app_map.yaml");
  const phone = itemMenu(Bun.YAML.parse(readFileSync(phoneItemPath, "utf8")), "nu_phone", {
    menuType: "world",
    state: "NuPhone",
  });
  const app = itemMenu(Bun.YAML.parse(readFileSync(appItemPath, "utf8")), "app_map", {
    menuType: "phone",
    state: "NuPhoneMap",
  });
  const nuPhoneMap = parseNuPhoneMap(rawMap, catalogs);
  const fishingPath = join(sourceRoot, "mods/fishing.yaml");
  const fishingSource = record(Bun.YAML.parse(readFileSync(fishingPath, "utf8")), "fishing.yaml");
  const fishing: WorldItemMapData["fishing"] = Object.fromEntries(
    Object.entries(fishingSource).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([slug, value]) => {
        const row = record(value, `fishing.yaml.${slug}`);
        const bounds = row.level_bounds;
        if (!Array.isArray(bounds) || bounds.length !== 2) {
          throw new Error(`fishing.yaml.${slug}.level_bounds must contain two numbers`);
        }
        const low = integer(bounds[0], `fishing.yaml.${slug}.level_bounds[0]`);
        const high = integer(bounds[1], `fishing.yaml.${slug}.level_bounds[1]`);
        if (low < 0 || high < low) throw new Error(`fishing.yaml.${slug}.level_bounds is invalid`);
        const environment = record(row.environment, `fishing.yaml.${slug}.environment`);
        const failureKey = nonEmptyString(row.failure_dialog, `fishing.yaml.${slug}.failure_dialog`);
        const config: WorldItemMapData["fishing"][string] = {
          trigger: finite(row.trigger, `fishing.yaml.${slug}.trigger`),
          levelBounds: [low, high],
          expReqMod: finite(row.exp_req_mod, `fishing.yaml.${slug}.exp_req_mod`),
          stages: stringList(row.stages ?? [], `fishing.yaml.${slug}.stages`),
          stageWeights: numberRecord(row.stage_weights, `fishing.yaml.${slug}.stage_weights`),
          shapes: stringList(row.shapes ?? [], `fishing.yaml.${slug}.shapes`),
          shapeWeights: numberRecord(row.shape_weights, `fishing.yaml.${slug}.shape_weights`),
          types: stringList(row.types ?? [], `fishing.yaml.${slug}.types`),
          typeWeights: numberRecord(row.type_weights, `fishing.yaml.${slug}.type_weights`),
          tags: stringList(row.tags ?? [], `fishing.yaml.${slug}.tags`),
          tagWeights: numberRecord(row.tag_shape, `fishing.yaml.${slug}.tag_shape`),
          environment: {
            default: nonEmptyString(environment.default, `fishing.yaml.${slug}.environment.default`),
            night: nonEmptyString(environment.night, `fishing.yaml.${slug}.environment.night`),
          },
          failure: translate(catalogs, failureKey),
        };
        if (config.trigger < 0 || config.trigger > 1) {
          throw new Error(`fishing.yaml.${slug}.trigger must be within 0..1`);
        }
        return [slug, config];
      }),
  );

  return {
    format: "pocket-tuxemon/feature-modes/v1",
    nuPhoneMap: {
      ...nuPhoneMap,
      entry: {
        phoneItem: "nu_phone",
        appItem: "app_map",
        phoneLabel: translate(catalogs, phone.labelKey),
        appLabel: translate(catalogs, app.labelKey),
        noTrackers: translate(catalogs, "nu_map_missing"),
      },
      art: {
        map: imageSource(sourceRoot, mapSource, "assets/nuphone/map.png"),
        cursor: imageSource(sourceRoot, "gfx/ui/menu/map_cross.png", "assets/nuphone/cursor.png"),
        player: imageSource(sourceRoot, "gfx/ui/menu/map_player.png", "assets/nuphone/player.png"),
        phoneIcon: imageSource(sourceRoot, phone.sprite, "assets/nuphone/phone.png"),
        appIcon: imageSource(sourceRoot, app.sprite, "assets/nuphone/app-map.png"),
      },
    },
    titleBattle: loadTitleBattle(sourceRoot, catalogs),
    titleMinigame: loadTitleMinigame(sourceRoot, catalogs),
    startMenu: loadStartMenu(catalogs),
    worldItems: {
      source: "mods/tuxemon/maps/*.tmx",
      surfable: Object.fromEntries(Object.entries(surfaceLabels)
        .filter(([, labels]) => (labels.surfable?.length ?? 0) > 0)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([map, labels]) => [map, [...labels.surfable!].sort((a, b) => a - b)])),
      fishingSource: "mods/fishing.yaml",
      fishing,
    },
  };
}

/** Remove build-only upstream image paths before this document enters the JS
 * bundle. PocketJS scans literal `.png` strings as application textures; only
 * the generated texture names belong in runtime data. */
export function featureModesRuntimeData(imported: FeatureModesImport): FeatureModesRuntimeData {
  const art = Object.fromEntries(Object.entries(imported.nuPhoneMap.art).map(([key, image]) => [
    key,
    { texture: image.texture, width: image.width, height: image.height },
  ])) as NuPhoneMapData["art"];
  return {
    format: imported.format,
    nuPhoneMap: { ...imported.nuPhoneMap, art },
    titleBattle: imported.titleBattle,
    titleMinigame: imported.titleMinigame,
    startMenu: imported.startMenu,
    worldItems: imported.worldItems,
  };
}

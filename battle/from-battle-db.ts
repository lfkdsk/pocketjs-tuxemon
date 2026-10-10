// Pure adapter: GB1's generated `pocket-tuxemon/battle-db/v1` -> the GB2
// reducer's `TuxemonBattleDb` shape. GB1 stores only what the *importer*
// needs (camelCase field names, flattened taste/shape rows, a map-shaped
// element affinity table); GB2's reducer was built and differentially
// verified against the Tuxemon oracle export, which mirrors upstream
// Pydantic model field names (snake_case) and array-shaped affinity rows.
// This module bridges the two without changing either one.
//
// GB1's `monster.moveset` is a level-up *schedule*
// (`{technique, level, method}[]`), not a "currently known moves" list.
// `TuxemonBattleDb.monster[slug].moveset` is the same kind of schedule
// (`{technique, learning_method, level_learned}[]`), consumed by
// `learnedMoves()` in `stats.ts` — so this adapter only renames fields.
// Code that turns a `BattleDb` trainer party into a battle-ready
// `MonsterSnapshot.moves` (a flat "known now" list) must still call
// `learnedMoves()`; it must not assume the schedule already is that list.

import type {
  BattleDb,
  BattlePlugin,
  BattleStatModifier,
} from "../importer/battle-schema.ts";
import type {
  DbMonster,
  DbCaptureDevice,
  DbCaptureRules,
  DbEvolution,
  DbItem,
  DbRule,
  DbStatModifier,
  DbStatus,
  DbTechnique,
  Stats,
  TuxemonBattleDb,
} from "./types.ts";

function toRules(plugins: BattlePlugin[]): DbRule[] {
  return plugins.map((plugin) => ({
    type: plugin.type,
    parameters: (plugin.parameters ?? []).map(String),
    ...(plugin.operator === undefined ? {} : { operator: plugin.operator }),
  }));
}

function toStatModifier(modifier: BattleStatModifier): DbStatModifier {
  return {
    value: modifier.value,
    operation: modifier.operation,
    step: modifier.step,
    max_deviation: modifier.max_deviation,
    max_step_limit: modifier.max_step_limit,
    scaling_mode: modifier.scaling_mode,
    overridetofull: modifier.overridetofull,
  };
}

function toStatModifiers(
  statModifiers: Record<string, BattleStatModifier>,
): DbTechnique["stat_modifiers"] {
  return Object.fromEntries(
    Object.entries(statModifiers).map(([stat, modifier]) => [stat, toStatModifier(modifier)]),
  ) as DbTechnique["stat_modifiers"];
}

function toMonster(slug: string, monster: BattleDb["monsters"][string]): DbMonster {
  return {
    slug,
    species: monster.species,
    shape: monster.shape,
    stage: monster.stage,
    types: monster.types,
    tags: monster.tags,
    terrains: monster.terrains,
    catch_rate: monster.catchRate,
    catch_resistance: monster.catchResistance,
    evolutions: monster.evolutions.map((evolution) => ({
      ...evolution,
      monster_slug: String(evolution.monster_slug),
    })) as DbEvolution[],
    moveset: monster.moveset.map((move) => ({
      technique: move.technique,
      learning_method: move.method,
      level_learned: move.level,
      ...(move.evolutionStage === undefined ? {} : {
        evolution_stage_learned: move.evolutionStage,
      }),
    })),
  };
}

function toItem(slug: string, item: BattleDb["items"][string]): DbItem {
  // ParkEffect's `park capture` uses the same status/device/shake formula as
  // CaptureEffect upstream. The runtime keeps its MainParkMenuState gate, so
  // normal battles still cannot use the Park Tuxeball.
  const effects = toRules(item.effects).map((effect): DbRule =>
    effect.type === "park" && effect.parameters[0] === "capture"
      ? { type: "capture", parameters: [] }
      : effect
  );
  return {
    slug,
    sort: item.sort,
    category: item.category,
    usable_in: item.usableIn,
    consumable: item.consumable,
    effects,
    conditions: toRules(item.conditions),
    behaviors: item.behaviors,
    stat_modifiers: toStatModifiers(item.statModifiers),
    immunity_to_status: item.immunityToStatus,
  };
}

function toTechnique(slug: string, technique: BattleDb["techniques"][string]): DbTechnique {
  return {
    slug,
    sort: technique.sort,
    range: technique.range,
    speed: technique.speed,
    accuracy: technique.accuracy,
    potency: technique.potency,
    power: technique.power,
    healing_power: technique.healingPower,
    recharge: technique.recharge,
    types: technique.types,
    effects: toRules(technique.effects),
    conditions: toRules(technique.conditions),
    stat_modifiers: toStatModifiers(technique.statModifiers),
    target: technique.target,
  };
}

function toStatus(slug: string, status: BattleDb["statuses"][string]): DbStatus {
  return {
    slug,
    category: status.category as DbStatus["category"],
    effects: toRules(status.effects),
    conditions: toRules(status.conditions),
    stat_modifiers: toStatModifiers(status.statModifiers),
    on_positive_status: status.positiveTransition as DbStatus["on_positive_status"],
    on_negative_status: status.negativeTransition as DbStatus["on_negative_status"],
    on_tech_use: status.onTechniqueUse,
    on_item_use: status.onItemUse,
    duration: status.duration,
    max_stacks: status.maxStacks,
    bond: status.bond,
    behaviors: { persists_after_combat: Boolean(status.behaviors.persists_after_combat) },
    modifiers: status.modifiers,
  };
}

/** A lazily-resolved, cached view of `source`'s keys through `resolve`. GB1's
 * `monsters`/`techniques`/`items`/`statuses` tables dominate the database's
 * size (~80%); a battle only ever touches a handful of slugs, so converting
 * on first read — instead of eagerly mapping every entry, as this function
 * used to — is what makes a sharded, on-demand `BattleDb` source (GP1's
 * `battle-repository.ts`) pay only for the slugs a battle actually uses.
 * `source` may itself be an eager plain object (tests, `battle/game.ts`) or
 * a lazy shard-table Proxy; either way `prop in source` and `source[prop]`
 * are the only operations used, so both compose transparently. */
function lazyRecord<T>(source: Record<string, unknown>, resolve: (slug: string) => T): Record<string, T> {
  const cache = new Map<string, T>();
  const resolveCached = (slug: string): T => {
    const cached = cache.get(slug);
    if (cached !== undefined) return cached;
    const value = resolve(slug);
    cache.set(slug, value);
    return value;
  };
  return new Proxy({} as Record<string, T>, {
    get(_target, prop) {
      if (typeof prop !== "string" || !(prop in source)) return undefined;
      return resolveCached(prop);
    },
    has(_target, prop) {
      return typeof prop === "string" && prop in source;
    },
    ownKeys() {
      return Object.keys(source);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string" || !(prop in source)) return undefined;
      return { value: resolveCached(prop), enumerable: true, configurable: true, writable: false };
    },
  });
}

/** Pure conversion; throws if GB1 references a rule the reducer cannot use. */
export function battleDbToTuxemonBattleDb(db: BattleDb): TuxemonBattleDb {
  const speedTiers = db.rules.actionOrder.speedTiers;
  return {
    monster: lazyRecord(db.monsters, (slug) => toMonster(slug, db.monsters[slug]!)),
    technique: lazyRecord(db.techniques, (slug) => toTechnique(slug, db.techniques[slug]!)),
    item: lazyRecord(db.items, (slug) => toItem(slug, db.items[slug]!)),
    technique_speed: lazyRecord(db.techniques, (slug) => speedTiers[db.techniques[slug]!.speed] ?? 0),
    element: Object.fromEntries(
      Object.entries(db.elements).map(([slug, element]) => [slug, {
        types: Object.entries(element.multipliers)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([against, multiplier]) => ({ against, multiplier })),
      }]),
    ),
    element_order: db.elementOrder,
    taste: Object.fromEntries(
      Object.entries(db.tastes).map(([slug, taste]) => [slug, {
        taste_type: taste.type,
        rarity_score: taste.rarity,
        modifiers: [{ values: [taste.stat], multiplier: taste.multiplier }],
      }]),
    ),
    taste_order: db.tasteOrder,
    shape: Object.fromEntries(
      Object.entries(db.shapes).map(([slug, shape]) => [slug, { attributes: shape as Stats }]),
    ),
    status: lazyRecord(db.statuses, (slug) => toStatus(slug, db.statuses[slug]!)),
    weather: db.weather,
    capture: {
      ...(db.rules.capture as unknown as Omit<DbCaptureRules, "max_catch_rate">),
      max_catch_rate: db.rules.catchRateRange[1],
    },
    capture_devices: {
      status_modifier: Number((db.rules.captureDevices as Record<string, unknown>).statusModifier ?? 1),
      capdev_modifier: Number((db.rules.captureDevices as Record<string, unknown>).deviceModifier ?? 1),
      items: ((db.rules.captureDevices as Record<string, unknown>).items ?? {}) as Record<string, DbCaptureDevice>,
    },
    progression: {
      level_range: [...db.rules.levelRange],
      max_moves: db.rules.maxMoves,
      acquisition_multipliers: { ...db.rules.experience.acquisitionMultipliers },
      experience_groups: Object.fromEntries(
        Object.entries(db.rules.experience.groups).map(([slug, group]) => [slug, {
          multiplier: group.multiplier,
          experience_coefficient: group.experienceCoefficient,
        }]),
      ),
    },
  };
}

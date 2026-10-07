import {
  advanceBattle,
  endBattle,
  enqueueAction,
  makePendingAction,
  nextRandom,
  randomChoice,
  randomIntInclusive,
  submitAction,
  submitDecision,
  type BattleAction,
  type BattleCoreRules,
} from "./core.ts";
import { calculateDefeatExperience, giveExperience } from "./progression.ts";
import { applyStatModifier, calculateBaseStats, combatStat, monsterFromSnapshot, pythonRound } from "./stats.ts";
import { weatherDamageFactor } from "./weather-modifiers.ts";
import {
  STAT_NAMES,
  type BattleMonster,
  type BattleStart,
  type BattleStatus,
  type DbCaptureDevice,
  type DbItem,
  type DbRule,
  type DbTechnique,
  type PlayerPolicy,
  type StatName,
  type Stats,
  type TuxemonBattleDb,
  type TuxemonBattleDecision,
  type TuxemonBattleState,
} from "./types.ts";

const SORT_ORDER = ["potion", "utility", "quest", "meta", "damage"];
const TARGET_ORDER = [
  "enemy_monster",
  "own_monster",
  "enemy_team",
  "own_team",
  "enemy_trainer",
  "own_trainer",
] as const;
const RANGE_MAP: Record<string, readonly [StatName | "level", StatName | "resist"]> = {
  melee: ["melee", "armour"],
  touch: ["melee", "dodge"],
  ranged: ["ranged", "dodge"],
  reach: ["ranged", "armour"],
  reliable: ["level", "resist"],
};
const PERSISTENT_STATUSES = new Set(["burn", "poison"]);
const BOND_STATUSES = new Set(["grabbed", "lifeleech", "lifegift"]);

interface TechniqueResult {
  success: boolean;
  damage: number;
  multiplier: number;
  shouldTackle: boolean;
  hit: boolean;
  /** Upstream ScopeEffect's stat readout; combat_scope renders it as "AR:{AR} DE:{DE} ME:{ME} RD:{RD} SD:{SD}". */
  scope: Pick<Stats, "armour" | "dodge" | "melee" | "ranged" | "speed"> | null;
}

export interface CaptureAttemptResult {
  statusModifier: number;
  deviceModifier: number;
  shakeCheck: number;
  success: boolean;
  shakes: number;
}

export function cloneBattleState(state: TuxemonBattleState): TuxemonBattleState {
  return JSON.parse(JSON.stringify(state)) as TuxemonBattleState;
}

/** Own each mutable branch; historical events and rewards are append-only.
 * Base stats and type lists are replaced as whole values by battle rules;
 * individual values and birthdate never change during a battle. */
function battleDraft(state: TuxemonBattleState): TuxemonBattleState {
  const monster = (value: BattleMonster): BattleMonster => ({
    ...value,
    stages: { ...value.stages },
    statusBoosts: { ...value.statusBoosts },
    trainingPoints: { ...value.trainingPoints },
    moves: value.moves.map(move => ({ ...move })),
    status: value.status ? { ...value.status, appliedEffects: [...value.status.appliedEffects] } : null,
  });
  return {
    ...state,
    parties: [state.parties[0].map(monster), state.parties[1].map(monster)],
    field: [...state.field],
    queue: state.queue.map((action) => ({ ...action })),
    pending: state.pending.map((entry) => ({ ...entry, action: { ...entry.action } })),
    hitRolls: { ...state.hitRolls },
    decisionQueue: [...state.decisionQueue],
    awaiting: state.awaiting ? { ...state.awaiting } : null,
    events: [...state.events],
    rewards: [...state.rewards],
    damageByDefender: Object.fromEntries(Object.entries(state.damageByDefender).map(([uid, attackers]) => [uid, [...attackers]])),
    result: state.result ? { ...state.result } : null,
    inventory: { ...state.inventory },
    variables: { ...state.variables },
  };
}

// An index exists only while a reducer owns its draft. Public helpers still
// observe caller mutations when used outside that transaction.
const draftIndexes = new WeakMap<TuxemonBattleState, Map<number, { monster: BattleMonster; side: 0 | 1 }>>();

export function getMonster(state: TuxemonBattleState, uid: number): BattleMonster {
  const index = draftIndexes.get(state);
  if (index) {
    const entry = index.get(uid);
    if (entry) return entry.monster;
  } else {
    for (const party of state.parties) for (const monster of party) if (monster.uid === uid) return monster;
  }
  throw new Error(`battle: unknown monster uid ${uid}`);
}

export function getSide(state: TuxemonBattleState, uid: number): 0 | 1 {
  const index = draftIndexes.get(state);
  if (index) {
    const entry = index.get(uid);
    if (entry) return entry.side;
  } else {
    for (let side = 0; side < 2; side++) {
      for (const monster of state.parties[side]!) if (monster.uid === uid) return side as 0 | 1;
    }
  }
  throw new Error(`battle: uid ${uid} has no owner`);
}

function activeOnSide(state: TuxemonBattleState, side: 0 | 1): BattleMonster[] {
  const result: BattleMonster[] = [];
  for (const uid of state.field) if (getSide(state, uid) === side) result.push(getMonster(state, uid));
  return result;
}

function aliveParty(state: TuxemonBattleState, side: 0 | 1): BattleMonster[] {
  return state.parties[side].filter((monster) => monster.currentHp > 0);
}

function targetGroup(
  state: TuxemonBattleState,
  objective: string,
  user: BattleMonster,
  target: BattleMonster,
): BattleMonster[] {
  const userSide = getSide(state, user.uid);
  const targetSide = getSide(state, target.uid);
  switch (objective) {
    case "enemy_monster": return [target];
    case "own_monster": return [user];
    case "enemy_team": return activeOnSide(state, targetSide);
    case "own_team": return activeOnSide(state, userSide);
    case "enemy_trainer": return aliveParty(state, targetSide);
    case "own_trainer": return aliveParty(state, userSide);
    default: throw new Error(`battle: unknown target objective '${objective}'`);
  }
}

/** Target order is deliberately stable; this is the documented set-order exemption. */
function objectiveTargets(
  state: TuxemonBattleState,
  objectives: readonly string[],
  user: BattleMonster,
  target: BattleMonster,
): BattleMonster[] {
  const seen = new Set<number>();
  const result: BattleMonster[] = [];
  for (const objective of objectives) {
    for (const monster of targetGroup(state, objective, user, target)) {
      if (!seen.has(monster.uid)) {
        seen.add(monster.uid);
        result.push(monster);
      }
    }
  }
  return result;
}

function techniqueTargets(
  state: TuxemonBattleState,
  technique: DbTechnique,
  user: BattleMonster,
  target: BattleMonster,
): BattleMonster[] {
  return objectiveTargets(
    state,
    TARGET_ORDER.filter((objective) => technique.target[objective]),
    user,
    target,
  );
}

function statusRecord(slug: string, linked: number | null, db: TuxemonBattleDb): BattleStatus {
  const model = db.status[slug];
  if (!model) throw new Error(`battle: unknown status '${slug}'`);
  return {
    slug,
    turn: (model.duration ?? 0) > 0 ? 1 : 0,
    stack: 1,
    uses: 0,
    linked,
    appliedEffects: [],
  };
}

function resetMoveStats(db: TuxemonBattleDb, monster: BattleMonster): void {
  for (const move of monster.moves) {
    const model = db.technique[move.slug];
    move.power = model.power;
    move.potency = model.potency;
  }
}

function applyStatusStart(db: TuxemonBattleDb, monster: BattleMonster): void {
  const current = monster.status;
  if (!current) return;
  const model = db.status[current.slug];
  for (const effect of model.effects) {
    if (effect.type !== "statchange" || current.appliedEffects.includes(effect.type)) continue;
    for (const [stat, modifier] of Object.entries(model.stat_modifiers ?? {})) {
      if (modifier) applyStatModifier(monster, stat as StatName, modifier, null, true);
    }
    current.appliedEffects.push(effect.type);
  }
}

function clearStatus(db: TuxemonBattleDb, monster: BattleMonster): void {
  if (!monster.status) return;
  monster.status = null;
  monster.statusBoosts = {};
  resetMoveStats(db, monster);
}

function applyStatus(
  db: TuxemonBattleDb,
  monster: BattleMonster,
  slug: string,
  linked: number | null,
): boolean {
  const incoming = db.status[slug];
  if (!incoming) throw new Error(`battle: unknown status '${slug}'`);
  const current = monster.status;
  if (current?.slug === slug) {
    current.stack = Math.min(current.stack + 1, incoming.max_stacks ?? 5);
    current.turn = 0;
    current.uses = 0;
    return false;
  }
  if (current) {
    const reaction = incoming.category === "positive"
      ? db.status[current.slug].on_positive_status
      : incoming.category === "negative"
        ? db.status[current.slug].on_negative_status
        : "replaced";
    if (reaction === "removed") {
      clearStatus(db, monster);
      return false;
    }
    if (reaction !== "replaced") return false;
    clearStatus(db, monster);
  }
  monster.status = statusRecord(slug, linked, db);
  applyStatusStart(db, monster);
  return true;
}

function statusConditionsPass(db: TuxemonBattleDb, monster: BattleMonster): boolean {
  if (!monster.status) return false;
  for (const condition of db.status[monster.status.slug].conditions ?? []) {
    if (condition.type !== "current_hp") continue;
    const [operator, raw] = condition.parameters;
    const right = Number(raw);
    const left = monster.currentHp / monster.base.hp;
    const passed = operator === ">" ? left > right
      : operator === ">=" ? left >= right
        : operator === "<" ? left < right
          : operator === "<=" ? left <= right
            : operator === "==" || operator === "=" ? left === right
              : operator === "!=" ? left !== right : false;
    if ((condition.operator === "not") === passed) return false;
  }
  return true;
}

function techniqueConditionsPass(
  technique: DbTechnique,
  target: BattleMonster,
): boolean {
  for (const condition of technique.conditions ?? []) {
    if (condition.type !== "status") return false;
    const actual = target.status?.slug === condition.parameters[0];
    if (condition.operator === "not" ? actual : !actual) return false;
  }
  return true;
}

function compareNumber(operator: string, left: number, right: number): boolean {
  switch (operator) {
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    case ">=": return left >= right;
    case "==":
    case "=": return left === right;
    case "!=": return left !== right;
    default: throw new Error(`battle: unsupported comparison '${operator}'`);
  }
}

function baseConditionPasses(
  db: TuxemonBattleDb,
  target: BattleMonster,
  parameters: string[],
): boolean {
  const species = db.monster[target.slug];
  const source = parameters[0];
  const dataset = new Set((source === "types" ? target.types
    : source === "tags" ? species.tags
      : source === "terrains" ? species.terrains
        : source === "shape" ? [species.shape]
          : source === "species" ? [species.species]
            : []).map((value) => value.trim().toLowerCase()));
  if (!["types", "tags", "terrains", "shape", "species"].includes(source ?? "")) {
    throw new Error(`battle: unsupported base condition source '${String(source)}'`);
  }
  const checks = (parameters[1] ?? "").split(":").map((raw) => {
    const option = raw.trim().toLowerCase();
    if (!option) return false;
    return option.startsWith("!") ? !dataset.has(option.slice(1)) : dataset.has(option);
  });
  const matchAll = ["true", "1", "yes"].includes((parameters[2] ?? "").trim().toLowerCase());
  return matchAll ? checks.every(Boolean) : checks.some(Boolean);
}

export function itemConditionsPass(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  item: DbItem,
  target: BattleMonster,
): boolean {
  for (const condition of item.conditions) {
    let actual: boolean;
    switch (condition.type) {
      case "base":
        actual = baseConditionPasses(db, target, condition.parameters);
        break;
      case "wild_monster":
        actual = state.kind === "wild" && getSide(state, target.uid) === 1;
        break;
      case "current_hp":
        actual = compareNumber(
          condition.parameters[0]!,
          target.currentHp / target.base.hp,
          Number(condition.parameters[1]),
        );
        break;
      case "status":
        actual = target.status?.slug === condition.parameters[0];
        break;
      case "has_status":
        actual = target.status !== null;
        break;
      default:
        throw new Error(`battle: unsupported item condition '${condition.type}' on '${item.slug}'`);
    }
    const expected = condition.operator !== "not";
    if (actual !== expected) return false;
  }
  return true;
}

function usableMoves(
  db: TuxemonBattleDb,
  monster: BattleMonster,
  target: BattleMonster,
): Array<{ moveIndex: number; slug: string }> {
  return monster.moves.flatMap((move, moveIndex) =>
    move.cooldown === 0 && techniqueConditionsPass(db.technique[move.slug], target)
      ? [{ moveIndex, slug: move.slug }]
      : [],
  );
}

function applyPreChecking(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  user: BattleMonster,
  target: BattleMonster,
  selected: { moveIndex?: number; slug: string },
): { moveIndex?: number; slug: string } {
  const status = user.status;
  if (!status) return selected;
  const effect = db.status[status.slug].effects.find((candidate) =>
    ["charmed", "confused", "flinching", "noddingoff", "wild"].includes(candidate.type),
  );
  if (!effect) return selected;
  const p = effect.parameters;
  let replacements: Array<{ moveIndex?: number; slug: string }> = [];
  if (effect.type === "charmed") {
    if (nextRandom(state) > Number(p[0])) {
      const tech = db.technique[selected.slug];
      if (tech.target.enemy_monster || tech.target.enemy_team || tech.target.enemy_trainer) {
        state.hitRolls[String(user.uid)] = 1.1;
      }
    }
  } else if (effect.type === "confused") {
    user.isConfused = nextRandom(state) < Number(p[0]);
    if (user.isConfused) {
      const available = user.moves.flatMap((move, moveIndex) => {
        const tech = db.technique[move.slug];
        return move.cooldown === 0 && !tech.effects.some((rule) =>
          rule.type === "give" && rule.parameters.includes("confused"),
        ) ? [{ moveIndex, slug: move.slug }] : [];
      });
      if (available.length > 0) replacements = [randomChoice(state, available)];
      else replacements = [{ slug: db.status[status.slug].on_tech_use ?? "empty" }];
    }
  } else if (effect.type === "flinching") {
    if (nextRandom(state) > Number(p[0])) {
      replacements = [{ slug: db.status[status.slug].on_tech_use ?? "empty" }];
      status.uses++;
      if (status.uses >= 1) clearStatus(db, user);
    }
  } else if (effect.type === "noddingoff") {
    replacements = [{ slug: db.status[status.slug].on_tech_use ?? "empty" }];
  } else if (effect.type === "wild") {
    if (nextRandom(state) < Number(p[0])) {
      replacements = [{ slug: db.status[status.slug].on_tech_use ?? "empty" }];
      user.currentHp = Math.max(0, user.currentHp - Math.trunc(user.base.hp / Number(p[1])));
    }
  }
  // CombatSession.pre_checking performs a second random.choice even though
  // every current status plugin returns at most one replacement.
  return replacements.length > 0 ? randomChoice(state, replacements) : selected;
}

function applyPerformTechniqueStatus(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  user: BattleMonster,
  preStatus: BattleStatus | null,
): void {
  if (!preStatus || user.status !== preStatus) return;
  const model = db.status[preStatus.slug];
  let followups: string[] = [];
  for (const effect of model.effects) {
    if (["chargedup", "charging", "exhausted"].includes(effect.type)) {
      clearStatus(db, user);
      if (model.on_tech_use) followups.push(model.on_tech_use);
    } else if (effect.type === "noddingoff" && preStatus.turn > 1) {
      if (nextRandom(state) > Number(effect.parameters[0]) ||
          ((model.duration ?? 0) > 0 && preStatus.turn > (model.duration ?? 0))) {
        clearStatus(db, user);
      }
    } else if (effect.type === "confused" && user.isConfused) {
      user.isConfused = false;
    }
  }
  if (followups.length === 0) return;
  // Upstream applies PERFORM_TECH's returned status in CombatSession and
  // again in CombatState. Keep both choices/draws for differential parity.
  const first = randomChoice(state, followups);
  applyStatus(db, user, first, null);
  const second = randomChoice(state, followups);
  applyStatus(db, user, second, null);
}

function affinity(db: TuxemonBattleDb, attack: string[], defend: string[]): number {
  let multiplier = 1;
  for (const attackType of attack) {
    for (const defendType of defend) {
      const row = db.element[attackType]?.types.find((entry) => entry.against === defendType);
      multiplier *= row?.multiplier ?? 1;
    }
  }
  return Math.max(0.25, Math.min(4, multiplier));
}

export function calculateDamage(
  db: TuxemonBattleDb,
  technique: DbTechnique,
  move: { power: number },
  user: BattleMonster,
  target: BattleMonster,
  weatherFactor = 1,
): readonly [number, number] {
  const range = RANGE_MAP[technique.range];
  if (!range) return [0, 0];
  const strength = range[0] === "level"
    ? 7 + user.level
    : combatStat(user, range[0]) * (7 + user.level);
  const resistance = Math.max(1, range[1] === "resist" ? 1 : combatStat(target, range[1]));
  // The returned multiplier stays the type affinity alone (effectiveness
  // messages and oracle element_multiplier traces); the weather factor is
  // upstream's additional_factors product, applied to damage only.
  const multiplier = affinity(db, technique.types, target.types);
  return [Math.trunc(strength * move.power * multiplier * weatherFactor / resistance), multiplier];
}

function recordDamage(
  state: TuxemonBattleState,
  attacker: BattleMonster,
  defender: BattleMonster,
): void {
  const key = String(defender.uid);
  const attackers = state.damageByDefender[key] ?? (state.damageByDefender[key] = []);
  if (!attackers.includes(attacker.uid)) attackers.push(attacker.uid);
}

function statusModifier(db: TuxemonBattleDb, status: string, host: BattleMonster): number {
  const applicable = (db.status[status].modifiers ?? [])
    .filter((modifier) => modifier.attribute === "type" && modifier.values.some((type) => host.types.includes(type)))
    .map((modifier) => modifier.multiplier);
  return applicable.length === 0 ? 1 : Math.min(...applicable);
}

function applyStatusTick(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  host: BattleMonster,
  slug: string,
): boolean {
  const status = host.status;
  if (!status || status.slug !== slug) return false;
  let success = false;
  for (const effect of db.status[slug].effects) {
    const p = effect.parameters;
    switch (effect.type) {
      case "burnt":
      case "poisoned": {
        const damage = Math.trunc(host.base.hp / Number(p[0]) * statusModifier(db, slug, host));
        if (damage > 0) {
          host.currentHp = Math.max(0, host.currentHp - damage);
          success = true;
        } else clearStatus(db, host);
        break;
      }
      case "recover": {
        const heal = Math.min(Math.trunc(host.base.hp / Number(p[0])), host.base.hp - host.currentHp);
        host.currentHp += heal;
        success ||= heal > 0;
        break;
      }
      case "lifeleech": {
        if (status.linked !== null) {
          const linked = getMonster(state, status.linked);
          if (linked.currentHp > 0) {
            const amount = Math.min(
              Math.trunc(host.base.hp / Number(p[0])),
              host.currentHp,
              linked.base.hp - linked.currentHp,
            );
            host.currentHp -= amount;
            linked.currentHp += amount;
            success = true;
          } else clearStatus(db, host);
        }
        break;
      }
      case "lifegift": {
        if (status.linked !== null) {
          const linked = getMonster(state, status.linked);
          if (linked.currentHp > 0) {
            const amount = Math.min(
              Math.trunc(linked.base.hp / Number(p[0])),
              linked.currentHp,
              host.base.hp - host.currentHp,
            );
            linked.currentHp -= amount;
            host.currentHp += amount;
            success = true;
          } else clearStatus(db, host);
        }
        break;
      }
      case "grabbed":
      case "stuck": {
        const ranges = p[1]!.split(":");
        for (const move of host.moves) {
          if (ranges.includes(db.technique[move.slug].range)) {
            move.power = db.technique[move.slug].power / Number(p[0]);
            move.potency = db.technique[move.slug].potency / Number(p[0]);
          }
        }
        success = true;
        break;
      }
      case "wasting": {
        const damage = Math.trunc(host.base.hp / Number(p[0])) * status.turn;
        host.currentHp = Math.max(0, host.currentHp - damage);
        success = host.currentHp > 0;
        break;
      }
      // The upstream queue removes a performed action from history before
      // these hooks query it. Preserve that observable no-op.
      case "elemental_shield":
      case "feedback":
      case "prickly":
      case "retaliate":
      case "revenge":
        break;
      default:
        // statchange is ON_START/ON_END; the remaining main-line effects are
        // PRE_CHECKING, PERFORM_TECH, CHECK_PARTY_HP, or item/swap hooks.
        success = true;
    }
  }
  state.events.push({
    type: "status",
    turn: state.turn,
    status: slug,
    target: host.uid,
    success,
    hp: partyHp(state),
  });
  return success;
}

function applyTechniqueStatChanges(
  state: TuxemonBattleState,
  technique: DbTechnique,
  targets: BattleMonster[],
): void {
  for (const target of targets) {
    for (const [stat, modifier] of Object.entries(technique.stat_modifiers ?? {})) {
      if (!modifier) continue;
      const deviation = modifier.max_deviation
        ? randomIntInclusive(state, -modifier.max_deviation, modifier.max_deviation)
        : null;
      applyStatModifier(target, stat as StatName | "current_hp", modifier, deviation);
    }
  }
}

function partyHp(state: TuxemonBattleState): Record<string, number> {
  return Object.fromEntries(
    state.field.map((uid) => {
      const monster = getMonster(state, uid);
      return [String(uid), monster.currentHp];
    }),
  );
}

function partyStatuses(state: TuxemonBattleState): Record<string, string | null> {
  return Object.fromEntries(
    state.field.map((uid) => {
      const monster = getMonster(state, uid);
      return [String(uid), monster.status?.slug ?? null];
    }),
  );
}

function captureStatusModifier(
  db: TuxemonBattleDb,
  itemSlug: string,
  target: BattleMonster,
): number {
  const config = db.capture_devices.items[itemSlug];
  let modifier = db.capture_devices.status_modifier;
  if (!config || !target.status) return modifier;
  const specific = config.specific_status_modifiers?.[target.status.slug];
  if (specific !== undefined) return modifier * specific;
  const category = db.status[target.status.slug]?.category;
  if (category) modifier *= category === "negative" ? config.negative_modifier : config.positive_modifier;
  return modifier;
}

function captureVariablesMatch(
  variables: Record<string, string | number | boolean>,
  rule: { key: string; value: string | number | boolean },
): boolean {
  return String(variables[rule.key]) === String(rule.value);
}

function configuredCaptureDeviceModifier(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  itemSlug: string,
  target: BattleMonster,
  config: DbCaptureDevice,
): number {
  let modifier = db.capture_devices.capdev_modifier;
  if (config.specific_capdev_modifier) modifier *= config.specific_capdev_modifier;

  if (itemSlug === "tuxeball_crusher") {
    let crusher = Math.min((target.base.armour / 5) * 0.01 + 1, 1.4);
    // Preserve the upstream comparison bug: a positive-status multiplier is
    // compared with the whole calculated modifier and collapses this to 1%.
    if (captureStatusModifier(db, itemSlug, target) === config.positive_modifier) crusher = 0.01;
    modifier *= crusher;
  }

  if (config.specific_element_modifiers) {
    let matched = false;
    for (const [slug, value] of Object.entries(config.specific_element_modifiers)) {
      if (!target.types.includes(slug)) continue;
      modifier *= value;
      matched = true;
    }
    if (!matched) modifier *= config.fallback_element_malus;
  }

  if (config.specific_gender_modifiers) {
    let matched = false;
    for (const slug of Object.keys(config.specific_gender_modifiers)) {
      if (target.gender === slug) matched = true;
    }
    // Upstream never applies the configured matching multiplier and always
    // applies one fallback; a mismatch applies it once here and once below.
    if (!matched) modifier *= config.fallback_gender_malus;
    modifier *= config.fallback_gender_malus;
  }

  if (config.specific_variables_modifiers) {
    let matched = false;
    for (const rule of config.specific_variables_modifiers) {
      if (!captureVariablesMatch(state.variables, rule)) continue;
      modifier *= config.fallback_variables_bonus;
      matched = true;
    }
    if (!matched) modifier *= config.fallback_variables_malus;
  }

  if (config.random_bounds) {
    const [lower, upper] = config.random_bounds;
    modifier *= lower + (upper - lower) * nextRandom(state);
  }
  return modifier;
}

function captureDeviceModifier(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  item: DbItem,
  target: BattleMonster,
): number {
  const combined = item.effects.find((effect) => effect.type === "capture_combined");
  if (combined) {
    const own = activeOnSide(state, 0)[0];
    if (!own || own.types.length === 0) return db.capture_devices.capdev_modifier;
    const same = own.types.length === target.types.length &&
      own.types.every((slug, index) => slug === target.types[index]);
    const label = combined.parameters[1];
    const lower = Number(combined.parameters[2]);
    const upper = Number(combined.parameters[3]);
    if (label === "xero") return same ? lower : upper;
    if (label === "omni") return same ? upper : lower;
    return db.capture_devices.capdev_modifier;
  }
  const config = db.capture_devices.items[item.slug];
  return config
    ? configuredCaptureDeviceModifier(db, state, item.slug, target, config)
    : db.capture_devices.capdev_modifier;
}

/** Mutates only the serialised RNG cursor and returns the upstream capture roll. */
export function attemptCapture(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  itemSlug: string,
  target: BattleMonster,
): CaptureAttemptResult {
  const item = db.item[itemSlug];
  if (!item) throw new Error(`battle: unknown item '${itemSlug}'`);
  const species = db.monster[target.slug];
  const statusModifier = captureStatusModifier(db, itemSlug, target);
  const deviceModifier = captureDeviceModifier(db, state, item, target);
  const catchCheck = (
    (db.capture.shake_hp_multiplier * target.base.hp -
      db.capture.shake_current_hp_multiplier * target.currentHp) *
    species.catch_rate * statusModifier * deviceModifier /
    (db.capture.shake_hp_divisor * target.base.hp)
  );
  let shakeCheck = db.capture.shake_constant /
    (Math.sqrt(Math.sqrt(db.capture.max_catch_rate / catchCheck)) * db.capture.shake_denominator);
  const [lower, upper] = species.catch_resistance;
  shakeCheck *= lower + (upper - lower) * nextRandom(state);
  let shakes = db.capture.total_shakes;
  let success = true;
  for (let index = 0; index < db.capture.total_shakes; index++) {
    if (randomIntInclusive(state, 0, db.capture.shake_divisor) <= Math.trunc(shakeCheck)) continue;
    success = false;
    shakes = index + 1;
    break;
  }
  return { statusModifier, deviceModifier, shakeCheck, success, shakes };
}

function changeInventory(state: TuxemonBattleState, slug: string, amount: number): void {
  state.inventory[slug] = Math.max(0, (state.inventory[slug] ?? 0) + amount);
}

function applyCaptureDeviceEffects(config: DbCaptureDevice, target: BattleMonster): void {
  for (const effect of config.capdev_effects ?? []) {
    if (effect.target_attribute === "level") {
      // Tuxemon 9e6258ff attempts to assign Monster.level, a read-only
      // property. Keep the exact externally visible bug for differential
      // parity; Item.use aborts before stock consumption or capture mutation.
      const error = new Error("property 'level' of 'Monster' object has no setter");
      error.name = "AttributeError";
      throw error;
    }
    if (effect.target_attribute !== "taste_warm" || effect.operation !== "set" ||
        typeof effect.value !== "string") {
      throw new Error(
        `battle: unsupported capture effect ${effect.operation} ${effect.target_attribute}`,
      );
    }
    target.tasteWarm = effect.value;
  }
}

function performCapture(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  action: BattleAction,
  rules: BattleCoreRules<BattleMonster, TuxemonBattleState>,
): void {
  const item = db.item[action.ref];
  const target = getMonster(state, action.target);
  const roll = attemptCapture(db, state, action.ref, target);
  const combined = item.effects.some((effect) => effect.type === "capture_combined");
  const config = db.capture_devices.items[item.slug];
  if (!combined && config) {
    if (roll.success && config.capdev_persistent_on_success) changeInventory(state, item.slug, 1);
    if (!roll.success && config.capdev_persistent_on_failure) changeInventory(state, item.slug, 1);
    if (roll.success) applyCaptureDeviceEffects(config, target);
  }
  if (item.consumable) changeInventory(state, item.slug, -1);
  state.events.push({
    type: "capture",
    turn: state.turn,
    user: action.user,
    target: target.uid,
    item: item.slug,
    ...roll,
    quantity: state.inventory[item.slug] ?? 0,
  });
  if (!roll.success) return;

  target.captureDevice = item.slug;
  target.acquisition = "captured";
  target.bond = 25;
  state.capturedUid = target.uid;
  if (target.status && !db.status[target.status.slug]?.behaviors?.persists_after_combat) {
    clearStatus(db, target);
  }
  endBattle(state, rules, "captured");
}

function performItem(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  action: BattleAction,
): void {
  const item = db.item[action.ref];
  if (!item) throw new Error(`battle: unknown item '${action.ref}'`);
  const target = getMonster(state, action.target);
  const before = {
    hp: target.currentHp,
    status: target.status?.slug ?? null,
    types: [...target.types],
    stages: { ...target.stages },
  };
  let success = false;
  for (const effect of item.effects) {
    switch (effect.type) {
      case "heal": {
        if (target.status?.slug === "festering" && item.category === "potion") break;
        const amount = effect.parameters[1] === "percentage"
          ? Math.trunc(target.base.hp * Number(effect.parameters[0]))
          : Math.trunc(Number(effect.parameters[0]));
        target.currentHp = Math.max(0, Math.min(target.base.hp, target.currentHp + amount));
        success = true;
        break;
      }
      case "restore": {
        const category = effect.parameters[0];
        if (!category || (target.status && db.status[target.status.slug]?.category === category)) {
          clearStatus(db, target);
        }
        success = true;
        break;
      }
      case "statchange": {
        for (const [stat, modifier] of Object.entries(item.stat_modifiers)) {
          if (!modifier) continue;
          const deviation = modifier.max_deviation
            ? randomIntInclusive(state, -modifier.max_deviation, modifier.max_deviation)
            : null;
          applyStatModifier(target, stat as StatName | "current_hp", modifier, deviation);
        }
        success = true;
        break;
      }
      case "switch_type": {
        const requested = effect.parameters[0]!;
        const element = requested === "random"
          ? randomChoice(state, db.element_order ?? Object.keys(db.element))
          : requested;
        if (!target.types.includes(element)) target.types = [element];
        success = true;
        break;
      }
      default:
        throw new Error(`battle: unsupported item effect '${effect.type}' on '${item.slug}'`);
    }
  }
  // The pinned upstream configuration consumes consumables on both success
  // and failure. Capture persistence is handled separately above.
  if (item.consumable) changeInventory(state, item.slug, -1);
  state.events.push({
    type: "item",
    turn: state.turn,
    user: action.user,
    target: target.uid,
    item: item.slug,
    success,
    quantity: state.inventory[item.slug] ?? 0,
    before,
    after: {
      hp: target.currentHp,
      status: target.status?.slug ?? null,
      types: [...target.types],
      stages: { ...target.stages },
    },
  });
}

function performRun(
  state: TuxemonBattleState,
  action: BattleAction,
  rules: BattleCoreRules<BattleMonster, TuxemonBattleState>,
): void {
  const user = getMonster(state, action.user!);
  const target = getMonster(state, action.target);
  const chance = 0.4 + 0.15 * (state.runAttempts + user.level - target.level);
  const roll = nextRandom(state);
  const success = roll <= chance;
  if (success) state.runAttempts = 0;
  else state.runAttempts++;
  state.events.push({
    type: "run",
    turn: state.turn,
    user: user.uid,
    target: target.uid,
    chance,
    roll,
    success,
    runAttempts: state.runAttempts,
  });
  if (success) endBattle(state, rules, "ran");
}

function performTechnique(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  action: BattleAction,
): void {
  const user = getMonster(state, action.user!);
  const target = getMonster(state, action.target);
  const technique = db.technique[action.ref];
  if (!technique) throw new Error(`battle: unknown technique '${action.ref}'`);
  const liveMove = action.moveIndex === undefined ? undefined : user.moves[action.moveIndex];
  const move = liveMove && liveMove.slug === action.ref
    ? liveMove
    : {
        slug: action.ref,
        cooldown: 0,
        power: technique.power,
        potency: technique.potency,
        hit: user.fallbackHit,
      };
  const before = partyHp(state);
  const preStatus = user.status;
  // One weather factor per technique use: the dealer is the modifier
  // subject, so every damage effect of this technique shares it.
  const weatherFactor = weatherDamageFactor(db, state, user);
  const result: TechniqueResult = {
    success: false,
    damage: 0,
    multiplier: 0,
    shouldTackle: false,
    hit: move.hit,
    scope: null,
  };
  const setHit = (hit: boolean): void => {
    result.hit = hit;
    move.hit = hit;
    if (!liveMove) user.fallbackHit = hit;
  };
  const targetWasOutOfRange = target.outOfRange;

  for (const effect of technique.effects) {
    if (targetWasOutOfRange && effect.type !== "appear") continue;
    const parameters = effect.parameters ?? [];
    const hitRoll = state.hitRolls[String(user.uid)] ?? 0;
    switch (effect.type) {
      case "damage": {
        setHit(technique.accuracy >= hitRoll);
        // DamageEffect reports the neutral multiplier even on a miss.
        if (!result.hit) {
          result.multiplier += 1;
          break;
        }
        const targets = techniqueTargets(state, technique, user, target);
        const enemySide = activeOnSide(state, getSide(state, target.uid));
        const spread = targets.filter((candidate) => enemySide.includes(candidate)).length > 1;
        for (const victim of targets) {
          let [damage, multiplier] = calculateDamage(db, technique, move, user, victim, weatherFactor);
          if (spread && enemySide.includes(victim)) damage = Math.trunc(damage * 0.75);
          victim.currentHp = Math.max(0, victim.currentHp - damage);
          if (victim.uid === target.uid) {
            result.damage += damage;
            result.multiplier += multiplier;
          } else if (damage > 0) recordDamage(state, user, victim);
          result.success ||= damage > 0;
          result.shouldTackle ||= damage > 0;
        }
        break;
      }
      case "give": {
        const potency = nextRandom(state);
        if (move.potency < potency || technique.accuracy < hitRoll) break;
        const [condition, objectives] = parameters;
        const targets = objectiveTargets(state, objectives!.split(":"), user, target);
        for (const recipient of targets) {
          const linked = db.status[condition!].bond ? user.uid : null;
          applyStatus(db, recipient, condition!, linked);
        }
        result.success ||= targets.length > 0;
        break;
      }
      case "splash": {
        setHit(technique.accuracy >= hitRoll);
        let [damage, multiplier] = calculateDamage(db, technique, move, user, target, weatherFactor);
        if (!result.hit) damage = Math.trunc(damage / Number(parameters[0]));
        const targets = techniqueTargets(state, technique, user, target);
        const enemySide = activeOnSide(state, getSide(state, target.uid));
        if (targets.filter((candidate) => enemySide.includes(candidate)).length > 1) {
          damage = Math.trunc(damage * 0.75);
        }
        for (const victim of targets) {
          victim.currentHp = Math.max(0, victim.currentHp - damage);
          if (victim.uid !== target.uid && damage > 0) recordDamage(state, user, victim);
        }
        result.damage += damage;
        result.multiplier += multiplier;
        result.success ||= damage > 0;
        result.shouldTackle ||= damage > 0;
        break;
      }
      case "healing": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const targets = parameters[0]
          ? targetGroup(state, parameters[0], user, target)
          : techniqueTargets(state, technique, user, target);
        let changed = false;
        for (const recipient of targets) {
          const heal = Math.trunc(7 + recipient.level * technique.healing_power);
          const amount = Math.min(heal, recipient.base.hp - recipient.currentHp);
          recipient.currentHp += amount;
          changed ||= amount > 0;
        }
        result.success ||= changed;
        break;
      }
      case "switch": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const targets = objectiveTargets(state, parameters[0]!.split(":"), user, target);
        const element = parameters[1] === "random"
          ? randomChoice(state, db.element_order ?? Object.keys(db.element))
          : parameters[1]!;
        for (const recipient of targets) {
          if (!recipient.types.includes(element)) recipient.types = [element];
        }
        result.success = true;
        break;
      }
      case "multiattack": {
        let hits = 0;
        let damage = 0;
        for (let index = 0; index < Number(parameters[0]); index++) {
          state.hitRolls[String(user.uid)] = nextRandom(state);
          if (technique.accuracy < state.hitRolls[String(user.uid)]!) break;
          hits++;
          damage += calculateDamage(db, technique, move, user, target, weatherFactor)[0];
        }
        if (hits > 0) target.currentHp = Math.max(0, target.currentHp - damage);
        result.damage += damage;
        result.success ||= hits > 0;
        result.shouldTackle ||= hits > 0;
        break;
      }
      case "statchange": {
        if (!parameters[0]) break;
        const potency = nextRandom(state);
        if (move.potency < potency || technique.accuracy < hitRoll) break;
        applyTechniqueStatChanges(
          state,
          technique,
          objectiveTargets(state, parameters[0].split(":"), user, target),
        );
        result.success = true;
        break;
      }
      case "remove": {
        const potency = nextRandom(state);
        if (move.potency < potency || technique.accuracy < hitRoll) break;
        const targets = objectiveTargets(state, parameters[1]!.split(":"), user, target);
        for (const recipient of targets) {
          const current = recipient.status && db.status[recipient.status.slug];
          if (parameters[0] === "all" || current?.slug === parameters[0] || current?.category === parameters[0]) {
            clearStatus(db, recipient);
          }
        }
        result.success ||= targets.length > 0;
        break;
      }
      case "disappear": {
        user.outOfRange = true;
        const scheduled = makePendingAction(state, {
          kind: "technique",
          user: user.uid,
          target: target.uid,
          ref: parameters[0]!,
        });
        state.pending.push({ turn: state.turn + 1, action: scheduled });
        result.success = true;
        break;
      }
      case "appear": {
        user.outOfRange = false;
        result.success ||= !target.outOfRange;
        result.shouldTackle ||= !target.outOfRange;
        break;
      }
      case "prop_healing": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const targets = objectiveTargets(state, parameters[0]!.split(":"), user, target);
        const amount = Math.trunc(user.base.hp * Number(parameters[1]));
        for (const recipient of targets) {
          recipient.currentHp = Math.min(recipient.base.hp, recipient.currentHp + amount);
        }
        result.success = true;
        break;
      }
      case "prop_damage": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const targets = objectiveTargets(state, parameters[0]!.split(":"), user, target);
        const damage = Math.trunc(target.base.hp * Number(parameters[1]));
        for (const victim of targets) {
          victim.currentHp = Math.max(0, victim.currentHp - damage);
          if (victim.uid !== target.uid && damage > 0) recordDamage(state, user, victim);
        }
        result.damage += damage;
        result.success = true;
        result.shouldTackle = true;
        break;
      }
      case "cooldown_modifier": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const targets = objectiveTargets(state, parameters[0]!.split(":"), user, target);
        const amount = Number(parameters[1]);
        const parameter = parameters[2]!;
        const value = parameters[3]!;
        for (const recipient of targets) {
          for (const candidate of recipient.moves) {
            const model = db.technique[candidate.slug];
            const selected = parameter === "types"
              ? model.types.includes(value)
              : String((model as unknown as Record<string, unknown>)[parameter]) !== value;
            if (!selected) continue;
            if (amount === 0) candidate.cooldown = Math.max(0, candidate.cooldown - 1);
            else if (candidate.cooldown <= model.recharge) candidate.cooldown = Math.min(10, candidate.cooldown + amount);
          }
        }
        result.success = true;
        break;
      }
      case "photogenesis": {
        if (state.inside) break;
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        if (user.currentHp >= user.base.hp) {
          result.success = true;
          break;
        }
        let [start, peak, end] = parameters.map(Number);
        let hour = state.hour;
        if (end! < start!) end! += 24;
        if (hour < start!) hour += 24;
        if (peak! < start!) peak! += 24;
        let multiplier = 0;
        if (end! <= 47 && hour <= 47 && peak! <= 47 && start! <= hour && hour < end!) {
          let distance = Math.abs(hour - peak!);
          if (distance > (end! - start!) / 2) distance = end! - start! - distance;
          multiplier = Math.max((db.shape[db.monster[user.slug].shape].attributes.hp / 2) *
            (1 - (distance / ((end! - start!) / 2)) ** 2), 0);
        }
        const heal = Math.trunc((7 + user.level * technique.healing_power) * multiplier);
        if (heal > 0) {
          user.currentHp += Math.min(heal, user.base.hp - user.currentHp);
          result.success = true;
        }
        break;
      }
      case "money": {
        setHit(technique.accuracy >= hitRoll);
        const damage = calculateDamage(db, technique, move, user, target, weatherFactor)[0];
        if (result.hit) {
          if (getSide(state, user.uid) === 0) state.techniqueGold += damage;
        } else user.currentHp = Math.max(0, user.currentHp - damage);
        result.success ||= result.hit;
        result.shouldTackle ||= result.hit;
        break;
      }
      case "reverse": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        for (const recipient of objectiveTargets(state, parameters[0]!.split(":"), user, target)) {
          recipient.types = [...recipient.originalTypes];
        }
        result.success = true;
        break;
      }
      case "transfer": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const [source, destination] = parameters[1] === "user_to_target"
          ? [user, target]
          : [target, user];
        if (source.status?.slug === parameters[0]) {
          clearStatus(db, source);
          // Upstream deliberately bypasses transition and ON_START here.
          destination.status = statusRecord(parameters[0]!, null, db);
          destination.status.turn = 0;
          result.success = true;
        }
        break;
      }
      case "sacrifice": {
        setHit(technique.accuracy >= hitRoll);
        if (!result.hit) break;
        const damage = Math.trunc(user.currentHp * Number(parameters[0]));
        user.currentHp = 0;
        target.currentHp = Math.max(0, target.currentHp - damage);
        result.damage += damage;
        result.success = true;
        result.shouldTackle = true;
        break;
      }
      case "empty":
        setHit(technique.accuracy >= hitRoll);
        result.success ||= result.hit;
        break;
      case "scope": {
        // Upstream ScopeEffect only formats a stat readout; it never rolls
        // accuracy or touches state, so `hit` persists its prior value.
        // It also reads target.armour/dodge/melee/ranged/speed directly
        // (scope.py:40-47), which are the monster's base_stats
        // (monster.py:350-372) with no stage or status modifier applied, so
        // this reads `target.base` rather than `combatStats(target)`.
        result.success = true;
        const { armour, dodge, melee, ranged, speed } = target.base;
        result.scope = { armour, dodge, melee, ranged, speed };
        break;
      }
      default:
        throw new Error(`battle: unsupported technique effect '${effect.type}' on '${technique.slug}'`);
    }
  }

  move.cooldown = technique.recharge;
  applyPerformTechniqueStatus(db, state, user, preStatus);
  if (result.shouldTackle) recordDamage(state, user, target);
  state.events.push({
    type: "technique",
    turn: state.turn,
    user: user.uid,
    target: target.uid,
    technique: technique.slug,
    hit: move.hit,
    success: result.success,
    damage: result.damage,
    multiplier: result.multiplier,
    // Omitted unless a scope-effect technique ran, so the oracle golden
    // trace (which predates this readout and never carries the key for the
    // trainer corpus, since `scope` isn't in it) stays byte-identical.
    ...(result.scope ? { scope: result.scope } : {}),
    hpBefore: before,
    hp: partyHp(state),
    statuses: partyStatuses(state),
  });
}

function statusSwapHook(db: TuxemonBattleDb, monster: BattleMonster): void {
  const current = monster.status;
  if (!current) return;
  for (const effect of db.status[current.slug].effects) {
    if (effect.type === "harpooned" || effect.type === "spiky") {
      monster.currentHp = Math.max(0, monster.currentHp - Math.trunc(monster.base.hp / Number(effect.parameters[0])));
    }
  }
}

function pruneMonsterActions(state: TuxemonBattleState, uid: number): void {
  state.queue = state.queue.filter((action) => action.user !== uid && action.target !== uid);
  state.pending = state.pending.filter(({ action }) => action.user !== uid && action.target !== uid);
}

function awardDefeat(db: TuxemonBattleDb, state: TuxemonBattleState, loser: BattleMonster): void {
  const participants = (state.damageByDefender[String(loser.uid)] ?? [])
    .map((uid) => getMonster(state, uid));
  const playerParticipants = participants.filter((monster) =>
    getSide(state, monster.uid) === 0 && monster.currentHp > 0,
  );
  const reward = {
    loser: loser.uid,
    winners: [] as TuxemonBattleState["rewards"][number]["winners"],
    prize: 0,
  };
  for (const winner of playerParticipants) {
    const awarded = calculateDefeatExperience(db, loser, winner, participants.length);
    const gained: StatName[] = [];
    for (const stat of STAT_NAMES) {
      if (loser.base[stat] > winner.base[stat]) {
        const total = STAT_NAMES.reduce((sum, name) => sum + winner.trainingPoints[name], 0);
        if (total < 300 && winner.trainingPoints[stat] < 150) {
          winner.trainingPoints[stat]++;
          gained.push(stat);
        }
      }
    }
    // The legacy GB2 oracle export has no progression config because that
    // corpus intentionally omitted RewardSystem. Preserve its historical
    // trace mode; production databases always carry the config below.
    if (db.progression && gained.length > 0) {
      winner.base = calculateBaseStats(
        db,
        winner.slug,
        winner.level,
        winner.individualValues,
        winner.tasteCold,
        winner.tasteWarm,
        winner.trainingPoints,
      );
    }
    const progression = db.progression
      ? giveExperience(db, winner, awarded, {
        owned: true,
        party: state.parties[0],
        variables: state.variables,
        inside: state.inside,
      })
      : {
        awardedExperience: awarded,
        effectiveExperience: awarded,
        levelsGained: 0,
        learnedMoves: [],
        forgottenMoves: [],
        evolutionTarget: null,
      };
    if (!db.progression) winner.totalExperience += awarded;
    winner.bond = Math.min(100, winner.bond + 3);
    reward.winners.push({
      uid: winner.uid,
      experience: awarded,
      effectiveExperience: progression.effectiveExperience,
      levelsGained: progression.levelsGained,
      learnedMoves: progression.learnedMoves,
      forgottenMoves: progression.forgottenMoves,
      evolutionTarget: progression.evolutionTarget,
      trainingPoints: gained,
    });
  }
  if (state.kind === "trainer" && participants.some((monster) => getSide(state, monster.uid) === 0)) {
    if (state.moneyMethod === "conserved") reward.prize = Math.trunc(loser.level * loser.moneyModifier);
    else reward.prize = participants.filter((monster) =>
      getSide(state, monster.uid) === 0 && monster.currentHp > 0,
    ).length * Math.trunc(loser.level * loser.moneyModifier);
    state.prize += reward.prize;
  }
  state.rewards.push(reward);
  delete state.damageByDefender[String(loser.uid)];
  for (const attackers of Object.values(state.damageByDefender)) {
    const index = attackers.indexOf(loser.uid);
    if (index >= 0) attackers.splice(index, 1);
  }
}

function captureItem(item: DbItem): boolean {
  return item.effects.some((effect) => effect.type === "capture" || effect.type === "capture_combined");
}

function itemBlockedByStatus(db: TuxemonBattleDb, target: BattleMonster): boolean {
  return Boolean(target.status && db.status[target.status.slug]?.effects.some((effect) => effect.type === "lockdown"));
}

export function canUseBattleItem(
  db: TuxemonBattleDb,
  state: TuxemonBattleState,
  itemSlug: string,
  targetUid: number,
  capture: boolean,
): boolean {
  const item = db.item[itemSlug];
  if (!item || (state.inventory[itemSlug] ?? 0) <= 0 ||
      !item.usable_in.includes("MainCombatMenuState") || captureItem(item) !== capture) {
    return false;
  }
  let target: BattleMonster;
  try {
    target = getMonster(state, targetUid);
  } catch {
    return false;
  }
  if (capture) {
    if (state.kind !== "wild" || getSide(state, target.uid) !== 1 || !state.field.includes(target.uid)) {
      return false;
    }
  } else if (getSide(state, target.uid) !== 0) {
    return false;
  }
  return !itemBlockedByStatus(db, target) && itemConditionsPass(db, state, item, target);
}

export function canRun(state: TuxemonBattleState, userUid: number): boolean {
  if (state.kind !== "wild" || !state.field.includes(userUid) || getSide(state, userUid) !== 0) {
    return false;
  }
  const status = getMonster(state, userUid).status?.slug;
  return status !== "grabbed" && status !== "stuck" && activeOnSide(state, 1).length > 0;
}

export function canSwap(state: TuxemonBattleState, userUid: number, targetUid: number): boolean {
  let user: BattleMonster;
  let target: BattleMonster;
  try {
    user = getMonster(state, userUid);
    target = getMonster(state, targetUid);
  } catch {
    return false;
  }
  if (!state.field.includes(user.uid) || state.field.includes(target.uid) ||
      getSide(state, user.uid) !== 0 || getSide(state, target.uid) !== 0 || target.currentHp <= 0) {
    return false;
  }
  const status = user.status?.slug;
  if (status === "grabbed" || status === "stuck") return false;
  return !state.queue.some((action) => action.kind === "swap" && action.target === target.uid);
}

function makeRules(db: TuxemonBattleDb): BattleCoreRules<BattleMonster, TuxemonBattleState> {
  function primaryTarget(state: TuxemonBattleState, uid: number): BattleMonster {
    const side = getSide(state, uid);
    const target = activeOnSide(state, side === 0 ? 1 : 0)[0];
    if (!target) throw new Error(`battle: monster ${uid} has no target`);
    return target;
  }

  function selectAction(
    state: TuxemonBattleState,
    uid: number,
    policy: PlayerPolicy | "ai",
    choice: number,
  ): Omit<BattleAction, "subPriority"> {
    const user = getMonster(state, uid);
    const targets = activeOnSide(state, getSide(state, uid) === 0 ? 1 : 0);
    const candidates = user.moves.flatMap((move, moveIndex) => targets.flatMap((target) =>
      move.cooldown === 0 && techniqueConditionsPass(db.technique[move.slug], target)
        ? [{ moveIndex, slug: move.slug, target }]
        : [],
    ));
    let selected: { moveIndex?: number; slug: string; target: BattleMonster };
    if (candidates.length === 0) {
      selected = { slug: user.fallback, target: targets[0]! };
      if (policy === "ai") selected = randomChoice(state, [selected]);
    } else if (policy === "ai") selected = randomChoice(state, candidates);
    else selected = candidates[Math.max(0, choice) % candidates.length]!;
    const checked = applyPreChecking(db, state, user, selected.target, selected);
    state.events.push({
      type: "decision",
      turn: state.turn,
      side: getSide(state, uid),
      user: uid,
      technique: checked.slug,
      target: selected.target.uid,
    });
    return {
      kind: "technique",
      user: uid,
      target: selected.target.uid,
      ref: checked.slug,
      ...(checked.moveIndex === undefined ? {} : { moveIndex: checked.moveIndex }),
    };
  }

  const rules: BattleCoreRules<BattleMonster, TuxemonBattleState> = {
    uid: (monster) => monster.uid,
    side: getSide,
    monster: getMonster,
    fainted: (monster) => monster.currentHp <= 0,
    fillPositions(state) {
      // Upstream restores a disappeared monster when its scheduled return
      // action was discarded (for example because that action's target
      // fainted). Due pending actions have already moved into our queue.
      for (const uid of state.field) {
        const monster = getMonster(state, uid);
        const hasReturnAction = state.queue.some((action) => action.user === uid) ||
          state.pending.some(({ action }) => action.user === uid);
        if (monster.outOfRange && !hasReturnAction) monster.outOfRange = false;
      }
      for (const side of [1, 0] as const) {
        while (activeOnSide(state, side).length < state.fieldSize) {
          const replacement = state.parties[side].find((monster) =>
            monster.currentHp > 0 && !state.field.includes(monster.uid),
          );
          if (!replacement) break;
          state.field.push(replacement.uid);
          // FieldMonsters retains trainer dictionary order: AI then player.
          state.field.sort((a, b) => getSide(state, b) - getSide(state, a));
          for (const active of state.field.map((uid) => getMonster(state, uid))) {
            if (active.status && BOND_STATUSES.has(active.status.slug)) clearStatus(db, active);
          }
          statusSwapHook(db, replacement);
          state.events.push({ type: "sendOut", turn: state.turn, side, monster: replacement.uid });
        }
      }
    },
    onDecisionStart(state, uid) {
      const monster = getMonster(state, uid);
      for (const move of monster.moves) move.cooldown = Math.max(0, move.cooldown - 1);
    },
    skipsDecision(state, uid) {
      const monster = getMonster(state, uid);
      return monster.outOfRange || state.pending.some(({ action }) => action.user === uid);
    },
    decideAi(state, uid) {
      return selectAction(state, uid, "ai", 0);
    },
    playerAction(state, uid, choice) {
      return selectAction(state, uid, state.policy, choice);
    },
    sortKey(state, action) {
      if (action.user === null) return [0, 0, 0];
      const sort = action.kind === "run" || action.kind === "swap"
        ? "meta"
        : action.kind === "item" || action.kind === "capture"
          ? db.item[action.ref]?.sort
          : db.technique[action.ref]?.sort;
      if (!sort) throw new Error(`battle: no sort category for ${action.kind} '${action.ref}'`);
      const primary = SORT_ORDER.indexOf(sort);
      const order = primary < 0 ? SORT_ORDER.length : primary;
      if (action.kind !== "technique") return [-order, 0, action.subPriority];
      const technique = db.technique[action.ref];
      const monster = getMonster(state, action.user);
      const speed = technique.sort === "meta" || technique.sort === "potion" ? 0 : Math.trunc(
        Math.max(combatStat(monster, "speed"), 0) *
        (1 + (db.technique_speed[technique.slug] ?? 0) * 0.25) +
        Math.max(combatStat(monster, "dodge"), 0) * 0.01,
      );
      // meta/potion actions really use zero; only speed_test clamps ordinary
      // techniques to a minimum of one.
      return [-order, speed, action.subPriority];
    },
    perform(state, action) {
      if (action.kind === "status") {
        applyStatusTick(db, state, getMonster(state, action.target), action.ref);
      } else if (action.kind === "technique") {
        performTechnique(db, state, action);
      } else if (action.kind === "item") {
        performItem(db, state, action);
      } else if (action.kind === "capture") {
        performCapture(db, state, action, rules);
      } else if (action.kind === "run") {
        performRun(state, action, rules);
      } else if (action.kind === "swap") {
        const user = getMonster(state, action.user!);
        const target = getMonster(state, action.target);
        const index = state.field.indexOf(user.uid);
        if (index < 0 || target.currentHp <= 0 || state.field.includes(target.uid)) return;
        for (const queued of state.queue) {
          if (queued.target === user.uid) queued.target = target.uid;
        }
        state.field[index] = target.uid;
        for (const active of state.field.map((uid) => getMonster(state, uid))) {
          if (active.status && BOND_STATUSES.has(active.status.slug)) clearStatus(db, active);
        }
        statusSwapHook(db, target);
        statusSwapHook(db, user);
        state.events.push({
          type: "swap",
          turn: state.turn,
          side: 0,
          user: user.uid,
          target: target.uid,
        });
      } else {
        throw new Error(`battle: unsupported action '${String(action.kind)}'`);
      }
    },
    checkParty(state) {
      for (const uid of [...state.field]) {
        const monster = getMonster(state, uid);
        if (monster.status?.slug === "diehard") {
          if (monster.currentHp === 1) clearStatus(db, monster);
          if (monster.currentHp <= 0) {
            monster.currentHp = 1;
            clearStatus(db, monster);
          }
        }
        if (monster.status?.slug === "recover" && monster.currentHp >= monster.base.hp) {
          monster.currentHp = monster.base.hp;
          clearStatus(db, monster);
        }
        if (monster.currentHp > 0) continue;
        pruneMonsterActions(state, uid);
        awardDefeat(db, state, monster);
        state.field = state.field.filter((candidate) => candidate !== uid);
        state.events.push({ type: "faint", turn: state.turn, monster: uid });
      }
    },
    queuePostActions(state) {
      for (const uid of state.field) {
        const monster = getMonster(state, uid);
        if (!monster.status || !statusConditionsPass(db, monster)) continue;
        if ((db.status[monster.status.slug].duration ?? 0) > 0) monster.status.turn++;
        enqueueAction(state, {
          kind: "status",
          user: null,
          target: uid,
          ref: monster.status.slug,
        });
      }
    },
    finish(state) {
      for (const monster of [...state.parties[0], ...state.parties[1]]) {
        monster.stages = {};
        monster.statusBoosts = {};
        monster.types = [...monster.originalTypes];
        monster.outOfRange = false;
        monster.isConfused = false;
        resetMoveStats(db, monster);
        for (const move of monster.moves) move.cooldown = 0;
        if (monster.currentHp <= 0) {
          monster.currentHp = 0;
          clearStatus(db, monster);
          monster.status = statusRecord("faint", null, db);
        } else if (monster.status && !PERSISTENT_STATUSES.has(monster.status.slug)) {
          clearStatus(db, monster);
        }
      }
      const outcome = state.outcome!;
      state.result = {
        outcome,
        playerDefeated: outcome === "lost" || outcome === "draw",
        battleLastResult: outcome === "ran" ? "run" : outcome,
        // Move gold and the trainer prize stay separate: only the prize is
        // shared with bills at completion, and only on a trainer win.
        gold: state.techniqueGold,
        prize: outcome === "won" && state.kind === "trainer" ? state.prize : 0,
      };
    },
  };
  return rules;
}

export function createBattle(db: TuxemonBattleDb, start: BattleStart): TuxemonBattleState {
  let uid = 1;
  const state: TuxemonBattleState = {
    version: 1,
    kind: start.kind ?? "trainer",
    opponent: start.opponent ?? "opponent",
    policy: start.policy ?? "first",
    inside: start.inside ?? false,
    hour: start.hour ?? 12,
    weather: start.weather ?? null,
    fieldSize: start.fieldSize ?? 1,
    moneyMethod: start.moneyMethod ?? "conserved",
    rng: start.seed >>> 0,
    rngDraws: 0,
    turn: 0,
    phase: "housekeeping",
    parties: [
      start.player.map((snapshot) => monsterFromSnapshot(db, uid++, snapshot)),
      start.enemy.map((snapshot) => monsterFromSnapshot(db, uid++, snapshot)),
    ],
    field: [],
    queue: [],
    pending: [],
    hitRolls: {},
    decisionQueue: [],
    awaiting: null,
    outcome: null,
    events: [],
    rewards: [],
    prize: 0,
    techniqueGold: 0,
    damageByDefender: {},
    result: null,
    runAttempts: start.runAttempts ?? 0,
    inventory: { ...(start.inventory ?? {}) },
    variables: { ...(start.variables ?? {}) },
    capturedUid: null,
  };
  return advanceBattle(state, makeRules(db));
}

/** Immutable reducer entry point. Every returned value is ordinary JSON. */
export function reduceBattle(
  db: TuxemonBattleDb,
  previous: TuxemonBattleState,
  decision: TuxemonBattleDecision,
): TuxemonBattleState {
  const state = battleDraft(previous);
  const index = new Map<number, { monster: BattleMonster; side: 0 | 1 }>();
  for (let side = 0; side < 2; side++) {
    for (const monster of state.parties[side]!) {
      if (!index.has(monster.uid)) index.set(monster.uid, { monster, side: side as 0 | 1 });
    }
  }
  draftIndexes.set(state, index);
  try {
    const rules = makeRules(db);
    if (decision.type === "technique") {
      return submitDecision(state, rules, decision.choice);
    }
    const user = state.awaiting?.uid;
    if (user === undefined) throw new Error("battle: no action decision is pending");
    if (decision.type === "replacement") {
      if (!canSwap(state, user, decision.uid)) {
        throw new Error(`battle: replacement ${decision.uid} is unavailable`);
      }
      return submitAction(state, rules, {
        kind: "swap",
        user,
        target: decision.uid,
        ref: "swap",
      });
    }
    if (decision.type === "run") {
      if (!canRun(state, user)) throw new Error("battle: escape is unavailable");
      const target = activeOnSide(state, 1)[0]!;
      return submitAction(state, rules, {
        kind: "run",
        user,
        target: target.uid,
        ref: "menu_run",
      });
    }
    const capture = decision.type === "capture";
    if (!canUseBattleItem(db, state, decision.item, decision.target, capture)) {
      throw new Error(`battle: item '${decision.item}' is unavailable for target ${decision.target}`);
    }
    return submitAction(state, rules, {
      kind: capture ? "capture" : "item",
      user,
      target: decision.target,
      ref: decision.item,
    });
  } finally {
    draftIndexes.delete(state);
  }
}

/** Deterministic headless helper used by golden tests and the future autoplay driver. */
export function runPolicyBattle(
  db: TuxemonBattleDb,
  start: BattleStart,
  maxDecisions = 10_000,
): TuxemonBattleState {
  let state = createBattle(db, start);
  for (let guard = 0; state.phase !== "ended" && guard < maxDecisions; guard++) {
    if (!state.awaiting) throw new Error(`battle: stalled in ${state.phase}`);
    const choice = state.policy === "cycle" ? state.turn - 1 : 0;
    state = reduceBattle(db, state, { type: "technique", choice });
  }
  if (state.phase !== "ended") throw new Error("battle: decision limit exceeded");
  return state;
}

export { applyStatus, clearStatus, makeRules, statusSwapHook, usableMoves };

// Runtime shape for the generated Tuxemon battle database.  This deliberately
// contains only fields consumed by battle rules or battle UI; source-only
// metadata stays in the upstream YAML.

export type BattleScope = "spyder" | "full";
export type BattleStat = "hp" | "armour" | "dodge" | "melee" | "ranged" | "speed";
export type BattleFormulaStat = BattleStat | "level" | "resist";

export interface BattleRangeRule {
  user: { stat: BattleFormulaStat; weight: number };
  target: { stat: BattleFormulaStat; weight: number };
}

/** One normalized `mods/ai_opponent.yaml` target-scoring profile. Upstream
 * evaluates this profile for trainer doubles before move selection; its
 * later legal-action choice replaces that target unless the monster must use
 * a fallback move. */
export interface BattleOpponentTargetRule {
  healthWeight: number;
  armourWeight: number;
  dodgeWeight: number;
  meleeWeight: number;
  rangedWeight: number;
  speedWeight: number;
  statusEffectsWeight: number;
  statusEffects: Record<string, number>;
  levelDifferenceThreshold: number;
  levelDifferenceWeight: number;
}

export interface BattlePlugin {
  type: string;
  parameters?: unknown[];
  operator?: string;
}

export interface BattleImageRef {
  /** Complete lazy TILESET reference: `ui:tile.<name>#0`. */
  key: string;
  width: number;
  height: number;
  /** Visible source rectangle inside the power-of-two texture. */
  rect: [number, number, number, number];
}

export type BattleSpriteBounds = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

/** Mirrors upstream `StatModel` (`tuxemon/db.py`), defaults included. */
export interface BattleStatModifier {
  value: number;
  step: number | null;
  max_deviation: number;
  operation: string;
  overridetofull: boolean;
  max_step_limit: number;
  scaling_mode: "linear" | "nonlinear";
}

export interface BattleStatusModifier {
  attribute: string;
  values: string[];
  multiplier: number;
}

export interface BattleAnimationPage extends BattleImageRef {
  firstFrame: number;
  frames: number;
  columns: number;
  frameWidth: number;
  frameHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export interface BattleAnimationRef {
  slug: string;
  pages: BattleAnimationPage[];
  durationMs: number;
  flipAxes: string;
  loops: number;
}

/** One complete upstream BattleMusicModel, normalized to runtime logical
 * audio ids. A null cue is authored silence; unresolved slugs never reach
 * this shape because the importer rejects them just as upstream's
 * MusicProperties validator does. */
export interface BattleMusicSet {
  battle: string | null;
  victory: string | null;
  defeat: string | null;
}

export interface BattleMusicCatalog {
  /** Every authored environment, independent of battle-art scope. */
  environments: Record<string, BattleMusicSet>;
  /** Only NPCs that author audio.battle_music; one complete set overrides. */
  npcOverrides: Record<string, BattleMusicSet>;
}

/** One root `mods/plagues.yaml` profile. Field names are normalized to the
 * game schema while preserving every upstream knob, including currently
 * dormant recovery/carrier settings. */
export interface BattlePlagueRow {
  spreadness: number;
  carrierSpreadness: number | null;
  naturalRecoveryChance: number;
  symptomOnsetChance: number;
  typeWeights: Record<string, number>;
  shapeWeights: Record<string, number>;
  statusWeights: Record<string, number>;
  resistanceModifiers: {
    types: Record<string, number>;
    shapes: Record<string, number>;
    statuses: Record<string, number>;
  };
  weightRange: [number, number] | null;
  heightRange: [number, number] | null;
  inoculation: {
    requiredHeldItem: string | null;
    eligibleTypes: string[] | null;
    eligibleShapes: string[] | null;
  } | null;
  cure: {
    chance: number;
    messageCured: string | null;
    messageCarrierCured: string | null;
  } | null;
  messages: {
    spreadSuccess: string | null;
    targetResists: string | null;
    minorEffect: string | null;
    targetInfected: string | null;
    userSuppressed: string | null;
    symptomOnset: string | null;
  };
}

export interface BattleDb {
  format: "pocket-tuxemon/battle-db/v1";
  sourceRevision: string;
  scope: BattleScope;
  rules: {
    levelRange: [number, number];
    trainingPoints: {
      maxPerStat: number;
      maxTotal: number;
      defaultGain: number;
    };
    statCoefficient: number;
    ivRange: [number, number];
    sizeVariation: {
      height: [number, number];
      weight: [number, number];
    };
    maxMoves: number;
    bondStageFloors: Record<string, number>;
    catchRateRange: [number, number];
    catchResistanceRange: [number, number];
    experience: {
      acquisitionMultipliers: Record<string, number>;
      groups: Record<string, {
        multiplier: number;
        experienceCoefficient: number;
      }>;
    };
    statStages: Record<string, number>;
    actionOrder: {
      sortOrder: string[];
      speedTiers: Record<string, number>;
      speedFactor: number;
      dodgeModifier: number;
      baseSpeedBonus: number;
      minSpeedModifier: number;
    };
    damage: {
      affinityMultiplierRange: [number, number];
      rangeMap: Record<string, BattleRangeRule>;
    };
    opponentTargeting: Record<string, BattleOpponentTargetRule>;
    capture: Record<string, unknown>;
    captureDevices: Record<string, unknown>;
  };
  shapes: Record<string, Record<BattleStat, number>>;
  elements: Record<string, {
    multipliers: Record<string, number>;
    icon: BattleImageRef;
    smallIcon: BattleImageRef;
  }>;
  /**
   * Upstream `db.database["element"]` insertion order for the pinned source
   * revision. Random `switch`/`switch_type` element picks consume this order,
   * not the alphabetically-sorted `elements` object keys.
   */
  elementOrder: string[];
  tastes: Record<string, {
    type: "cold" | "warm";
    rarity: number;
    stat: BattleStat;
    multiplier: number;
  }>;
  /** Upstream table insertion order; weighted taste generation depends on it. */
  tasteOrder: string[];
  monsters: Record<string, {
    /** Localized display name from en_US/base.po. */
    name: string;
    /** Localized journal copy from <slug>_description. */
    description: string;
    species: string;
    txmnId: number;
    shape: string;
    stage: string;
    /** Upstream `randomly` flag (default true); excluded from random_monster pools when false. */
    randomly: boolean;
    /** Parent slugs from history.evolves_from, for the random_monster underleveled-form check. */
    evolvesFrom: string[];
    types: string[];
    tags: string[];
    terrains: string[];
    height: number;
    weight: number;
    genderWeights: Record<string, number>;
    catchRate: number;
    catchResistance: [number, number];
    moveset: Array<{ technique: string; level: number; method: string; evolutionStage?: string }>;
    evolutions: Array<Record<string, unknown>>;
    art: {
      sheet: BattleImageRef;
      front: [number, number, number, number];
      back: [number, number, number, number];
      menu: [[number, number, number, number], [number, number, number, number]];
    };
  }>;
  techniques: Record<string, {
    /** Localized display name and description from the active .po catalog. */
    name: string;
    description: string;
    id: number;
    sort: string;
    category: string;
    range: string;
    speed: string;
    accuracy: number;
    potency: number;
    power: number;
    healingPower: number;
    recharge: number;
    types: string[];
    target: Record<string, boolean>;
    behaviors: Record<string, unknown>;
    effects: BattlePlugin[];
    conditions: BattlePlugin[];
    statModifiers: Record<string, BattleStatModifier>;
    messages: { use: string | null; success: string | null; failure: string | null };
    animation?: BattleAnimationRef;
  }>;
  items: Record<string, {
    /** Localized display name and description from the active .po catalog. */
    name: string;
    description: string;
    sort: string;
    /** Localized category label; `category` remains the stable rule key. */
    categoryName: string;
    category: string;
    usableIn: string[];
    cost: number | null;
    consumable: boolean;
    rewardMethod: "default" | "xp_equal" | "xp_transmitter" | "xp_feeder" | "xp_overkill" | "xp_damage_prop" | "xp_bond" | "xp_stage" | "xp_survivor";
    moneyMultiplier: number;
    effects: BattlePlugin[];
    conditions: BattlePlugin[];
    behaviors: Record<string, unknown>;
    modifiers: unknown[];
    statModifiers: Record<string, BattleStatModifier>;
    immunityToStatus: string[];
    /** Localized result text selected by upstream ItemController. */
    messages: { use: string; success: string; failure: string };
    captureSprite?: BattleImageRef;
    animation?: BattleAnimationRef;
  }>;
  statuses: Record<string, {
    name: string;
    sort: string;
    category: string | null;
    behaviors: Record<string, unknown>;
    effects: BattlePlugin[];
    conditions: BattlePlugin[];
    positiveTransition: string | null;
    negativeTransition: string | null;
    duration: number | null;
    bond: boolean;
    stepInterval: number | null;
    stepEffectValue: number | null;
    stepEffectType: string | null;
    onTechniqueUse: string | null;
    onItemUse: string | null;
    gainCondition: string | null;
    maxStacks: number;
    statModifiers: Record<string, BattleStatModifier>;
    /** Type-immunity/extra-damage modifiers, e.g. fire immune to burn. */
    modifiers: BattleStatusModifier[];
    icon: BattleImageRef;
    animation?: BattleAnimationRef;
  }>;
  encounters: Record<string, {
    type: string;
    monsters: Array<{
      monster: string;
      level: [number, number];
      weight: number;
      experienceModifier: number;
      heldItems: unknown[];
      variables: Array<{ key: string; value: string }>;
    }>;
  }>;
  battleMusic: BattleMusicCatalog;
  npcs: Record<string, {
    combat: Record<string, unknown>;
    items: Array<{ slug: string; quantity?: number }>;
    combatSheet: string | null;
    art?: BattleImageRef;
  }>;
  trainerParties: Array<{
    id: string;
    opponent: string;
    kind: "single" | "double";
    party: Array<{
      species: string[];
      speciesVariable?: string;
      level: number;
      experienceModifier: number;
      moneyModifier: number;
    }>;
    sources: Array<{ map: string; event: string }>;
  }>;
  environments: Record<string, {
    background: BattleImageRef;
    island: BattleImageRef;
    hud: Record<string, BattleImageRef>;
    partyIcons: Record<string, BattleImageRef>;
  }>;
  /**
   * The ten rows of mods/tuxemon/db/weather/weathers.yaml. Upstream's
   * `Weather.modifiers` is never consumed by combat code in the pinned
   * revision (all shipped lists are empty), so the battle engine applies
   * these through an upstream-shaped ModifiersHandler pipeline that stays
   * dormant until the rows are populated. See battle/weather-modifiers.ts.
   */
  weather: Record<string, WeatherRow>;
  /** Root plague profiles whose same-named techniques can replace an infected
   * monster's chosen enemy-targeting move during combat. */
  plagues: Record<string, BattlePlagueRow>;
  ui: {
    hpBar: BattleImageRef;
    expBar: BattleImageRef;
    crosshairs: BattleImageRef;
    missingMonster: BattleImageRef;
    rangeIcons: Record<string, BattleImageRef>;
    speedIcons: Record<string, BattleImageRef>;
    trainerSheets: Record<string, BattleImageRef>;
  };
}

/** One modifier record of a weather row, with the same field semantics as
 *  upstream's Modifier model (tuxemon/db.py): matched against the damage
 *  dealer's types, resolved by priority/stacking/max_stacks. */
export interface WeatherModifier {
  attribute: string;
  values: readonly string[];
  multiplier: number;
  priority: number;
  stacking: "additive" | "multiplicative" | "override";
  maxStacks: number | null;
  conditionName: string | null;
}

export interface WeatherRow {
  slug: string;
  /** Translation msgid, e.g. "weather_rain". */
  name: string;
  temperature: string;
  wind: string;
  modifiers: readonly WeatherModifier[];
}

/** GP1: one sharded monster/technique/item/status pak entry. */
export interface BattleRuntimeIndexEntry {
  readonly id: string;
  readonly entry: string;
}

/** Compact metadata kept in the eager shell so the journal can list every
 * imported monster without resolving every sharded detail record. */
export interface JournalMonsterIndexEntry extends BattleRuntimeIndexEntry {
  readonly txmnId: number;
  readonly name: string;
}

/** Presentation metadata that every battle needs. Keeping the icon in the
 * eager shell avoids resolving every status rule shard on first battle. */
export interface BattleRuntimeStatusIndexEntry extends BattleRuntimeIndexEntry {
  readonly icon: BattleImageRef;
}

/** GP1: the compact, bundled projection of `runtimeBattleDb()`. Carries every
 * small, always-needed table inline and replaces `monsters`/`techniques`/
 * `items`/`statuses` — together ~80% of the runtime database's bytes — with
 * per-slug indexes that `battle/battle-repository.ts` resolves on demand. */
export interface BattleRuntimeShell {
  format: BattleDb["format"];
  sourceRevision: string;
  scope: BattleScope;
  rules: BattleDb["rules"];
  shapes: BattleDb["shapes"];
  elements: BattleDb["elements"];
  elementOrder: string[];
  tastes: BattleDb["tastes"];
  tasteOrder: string[];
  encounters: BattleDb["encounters"];
  battleMusic: BattleDb["battleMusic"];
  environments: BattleDb["environments"];
  weather: BattleDb["weather"];
  /** Absent only in pre-plague runtime shells. */
  plagues?: BattleDb["plagues"];
  npcs: BattleDb["npcs"];
  ui: BattleDb["ui"];
  monstersIndex: JournalMonsterIndexEntry[];
  /** Campaign-visible subset of monstersIndex. Optional so a shell produced
   * before title-mode catalog isolation still behaves as an all-monster
   * journal rather than failing to boot. */
  journalMonsterIds?: string[];
  techniquesIndex: BattleRuntimeIndexEntry[];
  itemsIndex: BattleRuntimeIndexEntry[];
  statusesIndex: BattleRuntimeStatusIndexEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPow2 = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;

const isFiniteRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] <= value[1];

/** Every art reference, in a stable order, for pak-manifest validation. */
export function collectBattleArtRefs(db: BattleDb): BattleImageRef[] {
  const refs: BattleImageRef[] = [];
  for (const value of Object.values(db.monsters)) refs.push(value.art.sheet);
  for (const value of Object.values(db.techniques)) {
    for (const page of value.animation?.pages ?? []) refs.push(page);
  }
  for (const value of Object.values(db.items)) if (value.captureSprite) refs.push(value.captureSprite);
  for (const value of Object.values(db.items)) for (const page of value.animation?.pages ?? []) refs.push(page);
  for (const value of Object.values(db.statuses)) {
    refs.push(value.icon);
    for (const page of value.animation?.pages ?? []) refs.push(page);
  }
  for (const value of Object.values(db.elements)) refs.push(value.icon, value.smallIcon);
  for (const value of Object.values(db.npcs)) if (value.art) refs.push(value.art);
  for (const value of Object.values(db.environments)) {
    refs.push(value.background, value.island, ...Object.values(value.hud), ...Object.values(value.partyIcons));
  }
  refs.push(db.ui.hpBar, db.ui.expBar, db.ui.crosshairs, db.ui.missingMonster);
  refs.push(...Object.values(db.ui.rangeIcons), ...Object.values(db.ui.speedIcons));
  refs.push(...Object.values(db.ui.trainerSheets));
  return refs.sort((a, b) => a.key.localeCompare(b.key));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`battle-db schema: ${message}`);
}

/** Validates one entity's `statModifiers` map against upstream `StatModel` bounds. */
function validateStatModifiers(statModifiers: Record<string, BattleStatModifier>, label: string): void {
  for (const [stat, modifier] of Object.entries(statModifiers)) {
    assert(isRecord(modifier), `${label} stat modifier ${stat} must be an object`);
    assert(Number.isFinite(modifier.value), `${label} stat modifier ${stat} has invalid value`);
    assert(modifier.step === null || (Number.isInteger(modifier.step) && modifier.step >= -6 && modifier.step <= 6), `${label} stat modifier ${stat} has invalid step`);
    assert(Number.isFinite(modifier.max_deviation) && modifier.max_deviation >= 0, `${label} stat modifier ${stat} has invalid max_deviation`);
    assert(typeof modifier.operation === "string" && modifier.operation.length > 0, `${label} stat modifier ${stat} has invalid operation`);
    assert(typeof modifier.overridetofull === "boolean", `${label} stat modifier ${stat} has invalid overridetofull`);
    assert(Number.isFinite(modifier.max_step_limit) && modifier.max_step_limit > 0, `${label} stat modifier ${stat} has invalid max_step_limit`);
    assert(modifier.scaling_mode === "linear" || modifier.scaling_mode === "nonlinear", `${label} stat modifier ${stat} has invalid scaling_mode`);
  }
}

/** Strict relational validation; returns the narrowed value for callers. */
export function validateBattleDb(value: unknown, pakKeys?: ReadonlySet<string>): BattleDb {
  assert(isRecord(value), "root must be an object");
  assert(value.format === "pocket-tuxemon/battle-db/v1", "unsupported format");
  assert(value.scope === "spyder" || value.scope === "full", "scope must be spyder or full");
  const db = value as unknown as BattleDb;
  for (const key of ["shapes", "elements", "tastes", "monsters", "techniques", "items", "statuses", "encounters", "battleMusic", "npcs", "environments", "weather", "plagues"] as const) {
    assert(isRecord(db[key]), `${key} must be an object`);
  }
  assert(isRecord(db.battleMusic.environments), "battleMusic.environments must be an object");
  assert(isRecord(db.battleMusic.npcOverrides), "battleMusic.npcOverrides must be an object");
  const validateMusicSets = (sets: Record<string, BattleMusicSet>, owner: string): void => {
    for (const [slug, music] of Object.entries(sets)) {
      assert(isRecord(music), `${owner} ${slug} battle music must be an object`);
      for (const cue of ["battle", "victory", "defeat"] as const) {
        assert(
          music[cue] === null || (typeof music[cue] === "string" && music[cue].length > 0),
          `${owner} ${slug} has invalid ${cue} music`,
        );
      }
    }
  };
  validateMusicSets(db.battleMusic.environments, "environment");
  validateMusicSets(db.battleMusic.npcOverrides, "npc");
  assert(Array.isArray(db.trainerParties), "trainerParties must be an array");
  assert(Array.isArray(db.elementOrder), "elementOrder must be an array");
  assert(new Set(db.elementOrder).size === db.elementOrder.length, "elementOrder contains duplicates");
  assert(
    db.elementOrder.length === Object.keys(db.elements).length && db.elementOrder.every((slug) => slug in db.elements),
    "elementOrder must be a permutation of elements",
  );
  assert(Array.isArray(db.tasteOrder), "tasteOrder must be an array");
  assert(new Set(db.tasteOrder).size === db.tasteOrder.length, "tasteOrder contains duplicates");
  assert(
    db.tasteOrder.length === Object.keys(db.tastes).length && db.tasteOrder.every((slug) => slug in db.tastes),
    "tasteOrder must be a permutation of tastes",
  );
  assert(isRecord(db.rules) && isRecord(db.ui), "rules and ui must be objects");
  assert(isFiniteRange(db.rules.levelRange), "levelRange must be an ordered numeric pair");
  assert(isFiniteRange(db.rules.ivRange), "ivRange must be an ordered numeric pair");
  assert(isRecord(db.rules.trainingPoints), "trainingPoints must be an object");
  assert(Number.isInteger(db.rules.trainingPoints.maxPerStat) && db.rules.trainingPoints.maxPerStat > 0, "trainingPoints.maxPerStat must be a positive integer");
  assert(Number.isInteger(db.rules.trainingPoints.maxTotal) && db.rules.trainingPoints.maxTotal >= db.rules.trainingPoints.maxPerStat, "trainingPoints.maxTotal must cover one stat");
  assert(Number.isInteger(db.rules.trainingPoints.defaultGain) && db.rules.trainingPoints.defaultGain > 0, "trainingPoints.defaultGain must be a positive integer");
  assert(db.rules.maxMoves > 0 && Number.isInteger(db.rules.maxMoves), "maxMoves must be a positive integer");
  assert(isRecord(db.rules.bondStageFloors), "bondStageFloors must be an object");
  for (const [stage, floor] of Object.entries(db.rules.bondStageFloors)) {
    assert(stage.length > 0 && Number.isInteger(floor) && floor >= 0 && floor <= 100, `bondStageFloors.${stage} must be an integer in 0..100`);
  }
  assert(db.rules.statCoefficient >= 0, "statCoefficient must be non-negative");
  assert(isRecord(db.rules.sizeVariation), "sizeVariation must be an object");
  assert(isFiniteRange(db.rules.sizeVariation.height) && isFiniteRange(db.rules.sizeVariation.weight), "size variation must contain ordered numeric pairs");
  assert(isFiniteRange(db.rules.catchRateRange), "catchRateRange must be an ordered numeric pair");
  assert(isFiniteRange(db.rules.catchResistanceRange), "catchResistanceRange must be an ordered numeric pair");
  assert(isRecord(db.rules.experience) && isRecord(db.rules.experience.acquisitionMultipliers) && isRecord(db.rules.experience.groups), "experience rules must be objects");
  assert("default" in db.rules.experience.groups, "experience rules require the default group");
  for (const [method, multiplier] of Object.entries(db.rules.experience.acquisitionMultipliers)) {
    assert(Number.isFinite(multiplier) && multiplier >= 0, `experience multiplier ${method} must be non-negative`);
  }
  for (const [group, rule] of Object.entries(db.rules.experience.groups)) {
    assert(Number.isFinite(rule.multiplier) && rule.multiplier > 0, `experience group ${group} has invalid multiplier`);
    assert(Number.isFinite(rule.experienceCoefficient) && rule.experienceCoefficient > 0, `experience group ${group} has invalid coefficient`);
  }
  assert(isRecord(db.rules.actionOrder) && Array.isArray(db.rules.actionOrder.sortOrder) && isRecord(db.rules.actionOrder.speedTiers), "actionOrder rules must be present");
  assert(new Set(db.rules.actionOrder.sortOrder).size === db.rules.actionOrder.sortOrder.length, "action sort order contains duplicates");
  for (const [speed, tier] of Object.entries(db.rules.actionOrder.speedTiers)) {
    assert(Number.isInteger(tier), `speed tier ${speed} must be an integer`);
  }
  for (const key of ["speedFactor", "dodgeModifier", "baseSpeedBonus", "minSpeedModifier"] as const) {
    assert(Number.isFinite(db.rules.actionOrder[key]), `actionOrder.${key} must be finite`);
  }
  assert(isRecord(db.rules.damage) && isRecord(db.rules.damage.rangeMap), "damage rules must be present");
  assert(isFiniteRange(db.rules.damage.affinityMultiplierRange), "affinityMultiplierRange must be an ordered numeric pair");
  const formulaStats = new Set<BattleFormulaStat>(["hp", "armour", "dodge", "melee", "ranged", "speed", "level", "resist"]);
  for (const [range, rule] of Object.entries(db.rules.damage.rangeMap)) {
    assert(isRecord(rule) && isRecord(rule.user) && isRecord(rule.target), `damage range ${range} must define user and target`);
    assert(formulaStats.has(rule.user.stat), `damage range ${range} has invalid user stat`);
    assert(formulaStats.has(rule.target.stat), `damage range ${range} has invalid target stat`);
    assert(Number.isFinite(rule.user.weight) && rule.user.weight > 0, `damage range ${range} has invalid user weight`);
    assert(Number.isFinite(rule.target.weight) && rule.target.weight > 0, `damage range ${range} has invalid target weight`);
  }
  assert(isRecord(db.rules.opponentTargeting), "opponentTargeting rules must be present");
  assert("default" in db.rules.opponentTargeting, "opponentTargeting rules require the default profile");
  for (const [slug, rule] of Object.entries(db.rules.opponentTargeting)) {
    assert(isRecord(rule), `opponentTargeting ${slug} must be an object`);
    for (const key of [
      "healthWeight", "armourWeight", "dodgeWeight", "meleeWeight", "rangedWeight",
      "speedWeight", "statusEffectsWeight", "levelDifferenceThreshold", "levelDifferenceWeight",
    ] as const) {
      assert(Number.isFinite(rule[key]), `opponentTargeting ${slug}.${key} must be finite`);
    }
    assert(rule.levelDifferenceThreshold >= 0, `opponentTargeting ${slug} has a negative level threshold`);
    assert(isRecord(rule.statusEffects), `opponentTargeting ${slug}.statusEffects must be an object`);
    for (const [status, score] of Object.entries(rule.statusEffects)) {
      assert(status.length > 0 && Number.isFinite(score), `opponentTargeting ${slug} has an invalid status score`);
    }
  }

  for (const [slug, monster] of Object.entries(db.monsters)) {
    assert(typeof monster.name === "string" && monster.name.length > 0, `monster ${slug} has no localized name`);
    assert(typeof monster.description === "string" && monster.description.length > 0, `monster ${slug} has no localized description`);
    // Upstream reserves 0 for monsters that do not yet have a numbered
    // Tuxepedia entry; retain those rows and sort them deterministically.
    assert(Number.isInteger(monster.txmnId) && monster.txmnId >= 0, `monster ${slug} has invalid tuxepedia id`);
    assert(monster.shape in db.shapes, `monster ${slug} references missing shape ${monster.shape}`);
    assert(monster.types.length > 0, `monster ${slug} has no element`);
    for (const type of monster.types) assert(type in db.elements, `monster ${slug} references missing element ${type}`);
    for (const move of monster.moveset) {
      assert(move.technique in db.techniques, `monster ${slug} references missing technique ${move.technique}`);
      assert(Number.isInteger(move.level) && move.level >= 0, `monster ${slug} has invalid move level`);
    }
    assert(Array.isArray(monster.evolutions), `monster ${slug} evolutions must be an array`);
    for (const evolution of monster.evolutions) {
      assert(isRecord(evolution), `monster ${slug} has an invalid evolution row`);
      assert(typeof evolution.monster_slug === "string" && evolution.monster_slug.length > 0, `monster ${slug} evolution has no target`);
      assert(evolution.monster_slug in db.monsters, `monster ${slug} references missing evolution target ${evolution.monster_slug}`);
    }
    assert(monster.catchRate >= db.rules.catchRateRange[0] && monster.catchRate <= db.rules.catchRateRange[1], `monster ${slug} has invalid catch rate`);
    assert(monster.catchResistance[0] >= db.rules.catchResistanceRange[0] && monster.catchResistance[0] <= monster.catchResistance[1] && monster.catchResistance[1] <= db.rules.catchResistanceRange[1], `monster ${slug} has invalid catch resistance`);
  }
  for (const [slug, technique] of Object.entries(db.techniques)) {
    assert(typeof technique.name === "string" && technique.name.length > 0, `technique ${slug} has no localized name`);
    assert(typeof technique.description === "string" && technique.description.length > 0, `technique ${slug} has no localized description`);
    assert(Number.isFinite(technique.accuracy) && technique.accuracy >= 0, `technique ${slug} has invalid accuracy`);
    assert(Number.isFinite(technique.recharge) && technique.recharge >= 0, `technique ${slug} has invalid recharge`);
    assert(technique.sort in Object.fromEntries(db.rules.actionOrder.sortOrder.map((sort) => [sort, true])), `technique ${slug} has unknown action sort ${technique.sort}`);
    assert(technique.speed in db.rules.actionOrder.speedTiers, `technique ${slug} has unknown speed ${technique.speed}`);
    if (technique.effects.some((effect) => effect.type === "damage")) {
      assert(technique.range in db.rules.damage.rangeMap, `damage technique ${slug} has unknown range ${technique.range}`);
    }
    for (const type of technique.types) assert(type in db.elements, `technique ${slug} references missing element ${type}`);
    validateStatModifiers(technique.statModifiers, `technique ${slug}`);
  }
  for (const [slug, plague] of Object.entries(db.plagues)) {
    assert(isRecord(plague), `plague ${slug} must be an object`);
    for (const [field, chance] of [
      ["spreadness", plague.spreadness],
      ["naturalRecoveryChance", plague.naturalRecoveryChance],
      ["symptomOnsetChance", plague.symptomOnsetChance],
    ] as const) {
      assert(Number.isFinite(chance) && chance >= 0 && chance <= 1, `plague ${slug} has invalid ${field}`);
    }
    assert(plague.carrierSpreadness === null || (Number.isFinite(plague.carrierSpreadness)
      && plague.carrierSpreadness >= 0 && plague.carrierSpreadness <= 1), `plague ${slug} has invalid carrierSpreadness`);
    assert(plague.weightRange === null || isFiniteRange(plague.weightRange), `plague ${slug} has invalid weightRange`);
    assert(plague.heightRange === null || isFiniteRange(plague.heightRange), `plague ${slug} has invalid heightRange`);
    const weights = {
      typeWeights: plague.typeWeights,
      shapeWeights: plague.shapeWeights,
      statusWeights: plague.statusWeights,
      resistanceTypes: plague.resistanceModifiers?.types,
      resistanceShapes: plague.resistanceModifiers?.shapes,
      resistanceStatuses: plague.resistanceModifiers?.statuses,
    };
    for (const [label, values] of Object.entries(weights)) {
      assert(isRecord(values), `plague ${slug} ${label} must be an object`);
      assert(Object.entries(values).every(([key, value]) => key.length > 0
        && Number.isFinite(value) && Number(value) >= 0), `plague ${slug} has invalid ${label}`);
    }
    if (plague.inoculation !== null) {
      assert(isRecord(plague.inoculation), `plague ${slug} inoculation must be an object or null`);
      assert(plague.inoculation.requiredHeldItem === null || (typeof plague.inoculation.requiredHeldItem === "string"
        && plague.inoculation.requiredHeldItem.length > 0), `plague ${slug} has invalid inoculation item`);
      for (const [label, values] of [["eligibleTypes", plague.inoculation.eligibleTypes], ["eligibleShapes", plague.inoculation.eligibleShapes]] as const) {
        assert(values === null || (Array.isArray(values) && values.every((value) => typeof value === "string" && value.length > 0)),
          `plague ${slug} has invalid inoculation ${label}`);
      }
    }
    if (plague.cure !== null) {
      assert(isRecord(plague.cure) && Number.isFinite(plague.cure.chance)
        && plague.cure.chance >= 0 && plague.cure.chance <= 1, `plague ${slug} has invalid cure`);
      assert(plague.cure.messageCured === null || typeof plague.cure.messageCured === "string", `plague ${slug} has invalid cure message`);
      assert(plague.cure.messageCarrierCured === null || typeof plague.cure.messageCarrierCured === "string", `plague ${slug} has invalid carrier cure message`);
    }
    assert(isRecord(plague.messages) && Object.values(plague.messages).every((message) => message === null || typeof message === "string"),
      `plague ${slug} has invalid messages`);
    const technique = db.techniques[slug];
    assert(technique !== undefined, `plague ${slug} references missing technique ${slug}`);
    assert(technique.effects.some((effect) => effect.type === "plague" && String(effect.parameters?.[0]) === slug),
      `plague ${slug} technique must apply its matching plague effect`);
  }
  for (const [slug, item] of Object.entries(db.items)) {
    assert(typeof item.name === "string" && item.name.length > 0, `item ${slug} has no localized name`);
    assert(typeof item.description === "string" && item.description.length > 0, `item ${slug} has no localized description`);
    assert(typeof item.categoryName === "string" && item.categoryName.length > 0, `item ${slug} has no localized category`);
    assert(isRecord(item.messages), `item ${slug} messages must be an object`);
    for (const key of ["use", "success", "failure"] as const) {
      assert(typeof item.messages[key] === "string" && item.messages[key].length > 0, `item ${slug} has no localized ${key} message`);
    }
    assert(db.rules.actionOrder.sortOrder.includes(item.sort), `item ${slug} has unknown action sort ${item.sort}`);
    assert([
      "default", "xp_equal", "xp_transmitter", "xp_feeder", "xp_overkill",
      "xp_damage_prop", "xp_bond", "xp_stage", "xp_survivor",
    ].includes(item.rewardMethod), `item ${slug} has invalid reward method`);
    assert(Number.isFinite(item.moneyMultiplier) && item.moneyMultiplier >= 0, `item ${slug} has invalid money multiplier`);
    validateStatModifiers(item.statModifiers, `item ${slug}`);
  }
  for (const [slug, status] of Object.entries(db.statuses)) {
    assert(typeof status.name === "string" && status.name.length > 0, `status ${slug} has no localized name`);
    validateStatModifiers(status.statModifiers, `status ${slug}`);
    assert(Array.isArray(status.modifiers), `status ${slug} modifiers must be an array`);
    for (const modifier of status.modifiers) {
      assert(typeof modifier.attribute === "string" && modifier.attribute.length > 0, `status ${slug} modifier has invalid attribute`);
      assert(Array.isArray(modifier.values) && modifier.values.every((value) => typeof value === "string"), `status ${slug} modifier has invalid values`);
      assert(Number.isFinite(modifier.multiplier) && modifier.multiplier >= 0, `status ${slug} modifier has invalid multiplier`);
    }
  }
  for (const [slug, encounter] of Object.entries(db.encounters)) {
    assert(encounter.monsters.length > 0, `encounter ${slug} is empty`);
    for (const row of encounter.monsters) {
      assert(row.monster in db.monsters, `encounter ${slug} references missing monster ${row.monster}`);
      assert(Number.isFinite(row.weight) && row.weight > 0, `encounter ${slug} has non-positive weight`);
      assert(Number.isInteger(row.level[0]) && Number.isInteger(row.level[1]) && row.level[0] <= row.level[1], `encounter ${slug} has invalid level range`);
    }
  }
  const partyIds = new Set<string>();
  for (const trainer of db.trainerParties) {
    assert(!partyIds.has(trainer.id), `duplicate trainer party id ${trainer.id}`);
    partyIds.add(trainer.id);
    assert(trainer.opponent in db.npcs, `trainer ${trainer.id} references missing npc ${trainer.opponent}`);
    assert(trainer.party.length > 0, `trainer ${trainer.id} has no party`);
    for (const member of trainer.party) {
      assert(member.species.length > 0, `trainer ${trainer.id} has unresolved species`);
      assert(Number.isInteger(member.level) && member.level >= 0, `trainer ${trainer.id} has invalid level`);
      for (const slug of member.species) {
        const monster = db.monsters[slug];
        assert(monster, `trainer ${trainer.id} references missing monster ${slug}`);
        const spawnMoves = monster.moveset
          .filter((move) => move.method === "level_up" && move.level <= member.level && (!move.evolutionStage || move.evolutionStage === monster.stage))
          .slice(-db.rules.maxMoves);
        for (const move of spawnMoves) assert(move.technique in db.techniques, `trainer ${trainer.id}/${slug} references missing move ${move.technique}`);
      }
    }
  }

  for (const ref of collectBattleArtRefs(db)) {
    assert(/^ui:tile\.[^#]+#0$/.test(ref.key), `art key ${ref.key} is not a single-tile pak ref`);
    assert(isPow2(ref.width) && isPow2(ref.height), `art ${ref.key} is not power-of-two`);
    assert(ref.width <= 512 && ref.height <= 512, `art ${ref.key} exceeds 512px`);
    assert(ref.rect[0] >= 0 && ref.rect[1] >= 0 && ref.rect[2] > 0 && ref.rect[3] > 0, `art ${ref.key} has invalid rect`);
    assert(ref.rect[0] + ref.rect[2] <= ref.width && ref.rect[1] + ref.rect[3] <= ref.height, `art ${ref.key} rect exceeds texture`);
    if (pakKeys) {
      const pakKey = ref.key.slice(0, -2);
      assert(pakKeys.has(pakKey), `art ${ref.key} is absent from pak manifest`);
    }
  }
  return db;
}

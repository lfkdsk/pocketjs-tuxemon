import { describe, expect, test } from "bun:test";

import { validateTeam, type ArenaTeamRecord } from "../battle/arena.ts";
import {
  arenaTeamRecordFromProvenance,
  appendArenaItem,
  buildValidatedArenaTeam,
  type ArenaProvenanceEvent,
} from "../battle/arena-team.ts";
import {
  applyExpeditionAction,
  checkExpeditionConservation,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type Expedition,
  type ExpeditionAction,
} from "../battle/expedition.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const SEED = "0123456789abcdef".repeat(4);
const NEXT_SEED = "fedcba9876543210".repeat(4);
const FIRST_THROW_CAPTURE_SEED = "3".padStart(64, "0");

function apply(expedition: Expedition, action: ExpeditionAction): Expedition {
  const result = applyExpeditionAction(expedition, action);
  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.expedition.remainingSteps).toBe(expedition.remainingSteps - 1);
  expect(result.expedition.nextAction).toBe(expedition.nextAction + 1);
  expect(checkExpeditionConservation(result.expedition)).toEqual([]);
  return result.expedition;
}

function action(expedition: Expedition, type: ExpeditionAction["type"]): ExpeditionAction {
  const found = legalExpeditionActions(expedition).find((candidate) => candidate.type === type);
  if (!found) throw new Error(`expected a legal ${type} action`);
  return found;
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

function collectKeys(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, result);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      result.add(key);
      collectKeys(entry, result);
    }
  }
  return result;
}

describe("Arena expeditions", () => {
  test("create, observe, legal actions, and apply are deterministic and detached", () => {
    const config = {
      seed: SEED,
      rules: { cycle: "ranked" as const, stepBudget: 20 },
    };
    const first = createExpedition(config);
    const second = createExpedition(config);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(observeExpedition(second)).toEqual(observeExpedition(first));
    expect(legalExpeditionActions(second)).toEqual(legalExpeditionActions(first));

    const before = canonicalJson(first);
    const legal = legalExpeditionActions(first);
    const travel = legal.find((candidate) => candidate.type === "travel");
    expect(travel).toBeDefined();
    if (!travel) return;
    const firstNext = apply(first, JSON.parse(JSON.stringify(travel)) as ExpeditionAction);
    const secondNext = apply(second, travel);
    expect(canonicalJson(firstNext)).toBe(canonicalJson(secondNext));
    expect(firstNext).not.toBe(first);
    expect(canonicalJson(first)).toBe(before);
    expect(firstNext.remainingSteps).toBe(first.remainingSteps - 1);
    expect(firstNext.nextAction).toBe(first.nextAction + 1);

    (legal[0] as { sequence: number }).sequence = 999;
    expect(legalExpeditionActions(first)[0]!.sequence).toBe(first.nextAction);
    expect(checkExpeditionConservation(firstNext)).toEqual([]);
  });

  test("observations have exact public keys and hide seed, RNG, and future encounters", () => {
    let expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 20 },
    });
    const initial = observeExpedition(expedition);
    expect(keys(initial)).toEqual([
      "area", "backpack", "cycle", "destinations", "encounter", "lastTransition", "money",
      "nextAction", "remainingSteps", "result", "run", "shop", "status", "team", "v",
    ]);
    expect(initial.lastTransition).toBeNull();
    expect(keys(initial.area)).toEqual(["id", "name"]);
    expect(keys(initial.destinations[0]!)).toEqual(["id", "name"]);
    expect(keys(initial.team[0]!)).toEqual(["experience", "hp", "level", "moves", "slot", "species", "status"]);
    expect(keys(initial.team[0]!.species)).toEqual(["en_US", "slug", "zh_CN"]);
    expect(keys(initial.team[0]!.hp)).toEqual(["current", "max"]);
    expect(keys(initial.team[0]!.moves[0]!)).toEqual(["en_US", "slug", "zh_CN"]);
    expect(keys(initial.backpack[0]!)).toEqual(["en_US", "item", "quantity", "zh_CN"]);
    expect(keys(initial.shop!)).toEqual(["goods", "id"]);
    expect(keys(initial.shop!.goods[0]!)).toEqual(["en_US", "item", "price", "remaining", "zh_CN"]);
    expect(initial.encounter).toBeNull();
    const initialJson = JSON.stringify(initial);
    expect(initialJson).not.toContain(SEED);

    expedition = apply(expedition, action(expedition, "explore"));
    const encountered = observeExpedition(expedition);
    expect(keys(encountered.encounter!)).toEqual(["battle", "hpPercent", "level", "species", "status"]);
    expect(keys(encountered.encounter!.species)).toEqual(["en_US", "slug", "zh_CN"]);
    expect(keys(encountered.encounter!.battle)).toEqual([
      "actingParty", "deadlineTicks", "format", "legalActions", "opponent", "own", "result",
      "round", "side", "turn", "v",
    ]);
    const privateKeys = [
      "seed", "rng", "rngDraws", "rules", "ledger", "shopPurchases", "nextEventSeq",
      "acquireSeed", "partyIndices", "futureEncounter", "nextEncounter", "encounterTable",
    ];
    const observedKeys = collectKeys(encountered);
    for (const key of privateKeys) expect(observedKeys.has(key), `${key} leaked`).toBe(false);
    expect(initialJson).not.toContain(encountered.encounter!.species.slug);
    expect(JSON.stringify(encountered)).not.toContain(SEED);
  });

  test("stale and out-of-order actions are rejected without mutating state", () => {
    const initial = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 10 },
    });
    const firstAction = action(initial, "travel");
    const current = apply(initial, firstAction);
    const before = canonicalJson(current);

    const stale = applyExpeditionAction(current, firstAction);
    expect(stale).toEqual({ ok: false, expedition: current, error: "STALE_ACTION" });
    expect(stale.expedition).toBe(current);
    expect(canonicalJson(current)).toBe(before);

    const currentAction = action(current, "travel");
    const future = { ...currentAction, sequence: current.nextAction + 1 };
    const outOfOrder = applyExpeditionAction(current, future);
    expect(outOfOrder).toEqual({ ok: false, expedition: current, error: "OUT_OF_ORDER" });
    expect(outOfOrder.expedition).toBe(current);
    expect(canonicalJson(current)).toBe(before);
  });

  test("every accepted action costs one step and exhausted budget is an effective terminal", () => {
    const expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 1 },
    });
    const exhausted = apply(expedition, action(expedition, "explore"));
    expect(exhausted.remainingSteps).toBe(0);
    expect(exhausted.nextAction).toBe(2);
    expect(exhausted.ended).toBe(true);
    expect(exhausted.endReason).toBe("budget");
    expect(exhausted.encounter).toBeNull();
    expect(legalExpeditionActions(exhausted)).toEqual([]);
    expect(observeExpedition(exhausted)).toMatchObject({
      status: "ended",
      remainingSteps: 0,
      encounter: null,
      result: { reason: "budget" },
    });
    const rejected = applyExpeditionAction(exhausted, { type: "end", sequence: exhausted.nextAction });
    expect(rejected).toEqual({ ok: false, expedition: exhausted, error: "EXPEDITION_OVER" });
    expect(checkExpeditionConservation(exhausted)).toEqual([]);
  });

  test("real shop purchases and persistent items conserve money, inventory, and provenance", () => {
    let shopRun = createExpedition({
      seed: SEED,
      rules: { cycle: "persistent", stepBudget: 10, initialMoney: 1_000 },
    });
    const potion = legalExpeditionActions(shopRun).find((candidate) =>
      candidate.type === "shop" && candidate.item === "potion"
    );
    expect(potion).toBeDefined();
    if (!potion || potion.type !== "shop") return;
    const price = observeExpedition(shopRun).shop!.goods.find((good) => good.item === potion.item)!.price;
    const money = shopRun.money;
    const quantity = shopRun.inventory.potion ?? 0;
    shopRun = apply(shopRun, potion);
    expect(shopRun.money).toBe(money - price);
    expect(shopRun.inventory.potion).toBe(quantity + 1);
    expect(shopRun.ledger.spentMoney).toBe(price);
    expect(shopRun.ledger.purchasedItems.potion).toBe(1);
    expect(checkExpeditionConservation(shopRun)).toEqual([]);

    let itemRun = createExpedition({
      seed: SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 10,
        initialItems: { raise_melee: 2 },
      },
    });
    const beforeRecord = itemRun.team[0]!;
    const firstItem = action(itemRun, "useItem");
    itemRun = apply(itemRun, firstItem);
    expect(itemRun.inventory.raise_melee).toBe(1);
    expect(itemRun.ledger.consumedItems.raise_melee).toBe(1);
    expect(itemRun.team[0]).not.toEqual(beforeRecord);
    expect(itemRun.team[0]!.provenance.at(-1)).toMatchObject({ type: "item", item: "raise_melee", step: 1 });
    expect(validateTeam(itemRun.team, {
      levelCap: itemRun.rules.levelCap,
      requiredKind: "expedition",
    })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(itemRun)).toEqual([]);

    itemRun = apply(itemRun, action(itemRun, "useItem"));
    expect(itemRun.inventory.raise_melee).toBe(0);
    expect(itemRun.ledger.consumedItems.raise_melee).toBe(2);
    expect(legalExpeditionActions(itemRun).some((candidate) =>
      candidate.type === "useItem" && candidate.item === "raise_melee"
    )).toBe(false);
    expect(checkExpeditionConservation(itemRun)).toEqual([]);
  });

  test("a real generated encounter can be captured and produces a validated team record", () => {
    let expedition = createExpedition({
      seed: FIRST_THROW_CAPTURE_SEED,
      rules: { cycle: "persistent", stepBudget: 10, initialItems: { tuxeball: 5, tea: 1 } },
    });
    expedition = apply(expedition, action(expedition, "explore"));
    expect(observeExpedition(expedition).encounter?.species.slug).toBe("pairagrin");
    const capture = action(expedition, "catch");
    expedition = apply(expedition, capture);

    expect(expedition.encounter).toBeNull();
    expect(expedition.team.map((record) => record.species)).toEqual(["rockitten", "pairagrin"]);
    expect(expedition.inventory.tuxeball).toBe(4);
    expect(expedition.ledger.consumedItems.tuxeball).toBe(1);
    const acquired = expedition.team[1]!;
    expect(acquired.provenance[0]).toMatchObject({
      type: "acquire",
      species: "pairagrin",
      origin: {
        kind: "expedition",
        area: "spyder_route1",
        step: 2,
        experienceModifier: 3,
        capture: { result: "caught", item: "tuxeball", success: true },
      },
    });
    expect(buildValidatedArenaTeam([acquired], { levelCap: expedition.rules.levelCap })[0]!
      .experienceModifier).toBe(3);

    // Records created before the encounter multiplier was added remain valid
    // and retain their historical 1x reconstruction rather than being silently
    // reinterpreted as newly captured 3x records.
    const legacyProvenance = JSON.parse(JSON.stringify(acquired.provenance)) as ArenaProvenanceEvent[];
    const legacyAcquire = legacyProvenance[0];
    if (legacyAcquire?.type !== "acquire" || !legacyAcquire.origin) {
      throw new Error("captured provenance fixture missing");
    }
    delete legacyAcquire.origin.experienceModifier;
    const legacyRecord = arenaTeamRecordFromProvenance(acquired.species, legacyProvenance, {
      levelCap: expedition.rules.levelCap,
    });
    expect(validateTeam([legacyRecord], { levelCap: expedition.rules.levelCap })).toEqual({
      ok: true,
      errors: [],
    });
    expect(buildValidatedArenaTeam([legacyRecord], { levelCap: expedition.rules.levelCap })[0]!
      .experienceModifier).toBe(1);
    const legacyWithExperience = appendArenaItem(legacyRecord, {
      type: "item",
      item: "tea",
      step: 3,
    }, legacyRecord.provenance.at(-1)!.seq + 1, { levelCap: expedition.rules.levelCap }).record;
    expect(legacyWithExperience.experience).toBe(legacyRecord.experience! + 500);
    expect(validateTeam([legacyWithExperience], { levelCap: expedition.rules.levelCap })).toEqual({
      ok: true,
      errors: [],
    });

    const invalidProvenance = JSON.parse(JSON.stringify(acquired.provenance)) as ArenaProvenanceEvent[];
    const invalidAcquire = invalidProvenance[0];
    if (invalidAcquire?.type !== "acquire" || !invalidAcquire.origin) {
      throw new Error("captured provenance fixture missing");
    }
    invalidAcquire.origin.experienceModifier = 1;
    expect(() => arenaTeamRecordFromProvenance(acquired.species, invalidProvenance, {
      levelCap: expedition.rules.levelCap,
    })).toThrow("species, level, and experience modifier");

    const beforeExperience = acquired.experience!;
    expedition = apply(expedition, legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "useItem" && candidate.item === "tea" && candidate.target === 1
    )!);
    expect(expedition.team[1]!.experience).toBe(beforeExperience + 1_500);

    // Select only the captured member for the next encounter. This exercises
    // the battle-construction seam as well as provenance reconstruction.
    expedition.partyHp[0] = 0;
    expect(checkExpeditionConservation(expedition)).toEqual([]);
    expedition = apply(expedition, action(expedition, "explore"));
    expect(expedition.encounter!.battle.core.parties[0]).toHaveLength(1);
    expect(expedition.encounter!.battle.core.parties[0][0]).toMatchObject({
      slug: "pairagrin",
      experienceModifier: 3,
    });
    const beforeBattleExperience = expedition.team[1]!.experience!;
    expedition = apply(expedition, legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    )!);
    const battleExperience = [...expedition.team[1]!.provenance].reverse().find((event) =>
      event.type === "experience" && event.source.kind === "battle"
    );
    if (battleExperience?.type !== "experience") throw new Error("battle experience fixture missing");
    expect(battleExperience.amount).toBe(12);
    expect(expedition.team[1]!.experience).toBe(beforeBattleExperience + battleExperience.amount * 3);
    expect(validateTeam(expedition.team, {
      levelCap: expedition.rules.levelCap,
      requiredKind: "expedition",
    })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("auto battle uses real encounters and preserves a valid progression record", () => {
    let expedition = createExpedition({
      seed: SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 10,
        starter: { species: "rockitten", level: 50 },
      },
    });
    expedition = apply(expedition, action(expedition, "explore"));
    const beforeExperience = expedition.team[0]!.experience!;
    expedition = apply(expedition, legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    )!);
    expect(expedition.encounter).toBeNull();
    expect(expedition.team[0]!.experience).toBeGreaterThan(beforeExperience);
    expect(expedition.team[0]!.provenance.some((event) => event.type === "experience")).toBe(true);
    const transition = observeExpedition(expedition).lastTransition;
    expect(transition).toMatchObject({ type: "battle", mode: "auto" });
    if (transition?.type !== "battle") throw new Error("auto battle transition fixture missing");
    expect(transition.turns.length).toBeGreaterThan(0);
    expect(transition.turns.at(-1)!.observation.result).toMatchObject({ winner: 0 });
    expect(transition.turns.map(({ observation }) => observation.turn)).toEqual(
      transition.turns.map((_, index) => index + 1),
    );
    expect(collectKeys(transition).has("seed")).toBe(false);
    expect(collectKeys(transition).has("rng")).toBe(false);
    expect(validateTeam(expedition.team, {
      levelCap: expedition.rules.levelCap,
      requiredKind: "expedition",
    })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("ranked runs cannot continue while persistent runs retain authoritative progress", () => {
    const ranked = apply(createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 3 },
    }), { type: "end", sequence: 1 });
    expect(ranked.endReason).toBe("voluntary");
    expect(() => createExpedition({
      seed: NEXT_SEED,
      rules: { cycle: "ranked", stepBudget: 3, continuation: ranked },
    })).toThrow("ranked expeditions cannot continue prior state");

    let persistent = createExpedition({
      seed: SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 5,
        levelCap: 20,
        initialMoney: 777,
        initialItems: { raise_melee: 1 },
      },
    });
    persistent = apply(persistent, action(persistent, "useItem"));
    persistent = apply(persistent, action(persistent, "end"));
    const previousTeam = JSON.parse(JSON.stringify(persistent.team)) as ArenaTeamRecord[];
    const continued = createExpedition({
      seed: NEXT_SEED,
      rules: { cycle: "persistent", stepBudget: 7, levelCap: 20, continuation: persistent },
    });
    expect(continued.run).toBe(2);
    expect(continued.team).toEqual(previousTeam);
    expect(continued.team).not.toBe(persistent.team);
    expect(continued.partyHp).toEqual(persistent.partyHp);
    expect(continued.partyStatus).toEqual(persistent.partyStatus);
    expect(continued.inventory).toEqual(persistent.inventory);
    expect(continued.money).toBe(persistent.money);
    expect(continued.remainingSteps).toBe(7);
    expect(continued.nextAction).toBe(persistent.nextAction);
    expect(continued.nextEventSeq).toBe(persistent.nextEventSeq);
    expect(continued.ended).toBe(false);
    expect(continued.endReason).toBeNull();
    expect(validateTeam(continued.team, {
      levelCap: continued.rules.levelCap,
      requiredKind: "expedition",
    })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(continued)).toEqual([]);
    const lowered = createExpedition({
      seed: "3".repeat(64),
      rules: { cycle: "persistent", stepBudget: 7, levelCap: 10, continuation: persistent },
    });
    expect(lowered.rules.levelCap).toBe(10);
    expect(checkExpeditionConservation(lowered)).toEqual([]);
    expect(() => createExpedition({
      seed: "4".repeat(64),
      rules: { cycle: "persistent", stepBudget: 7, levelCap: 21, continuation: persistent },
    })).toThrow("persistent continuation cannot raise the level cap");
    expect(() => createExpedition({
      seed: NEXT_SEED,
      rules: { cycle: "persistent", stepBudget: 7, continuation: createExpedition({
        seed: SEED,
        rules: { cycle: "persistent", stepBudget: 2 },
      }) },
    })).toThrow("requires an ended persistent expedition");
  });

  test("a defeated persistent expedition recovers into an actionable continuation", () => {
    let defeated = createExpedition({
      seed: "1".padStart(64, "0"),
      rules: {
        cycle: "persistent",
        stepBudget: 6,
        starter: { species: "rockitten", level: 1 },
      },
    });
    defeated = apply(defeated, legalExpeditionActions(defeated).find((candidate) =>
      candidate.type === "travel" && candidate.area === "spyder_route2"
    )!);
    defeated = apply(defeated, action(defeated, "explore"));
    defeated = apply(defeated, legalExpeditionActions(defeated).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    )!);
    expect(defeated.endReason).toBe("defeated");
    expect(defeated.partyHp).toEqual([0]);

    // A persistent condition is legal on a fainted member and must be cleared
    // by the same recovery boundary that restores HP.
    defeated.partyStatus[0] = "poison";
    expect(checkExpeditionConservation(defeated)).toEqual([]);
    const previousTeam = JSON.parse(JSON.stringify(defeated.team)) as ArenaTeamRecord[];
    const previousInventory = JSON.parse(JSON.stringify(defeated.inventory)) as Record<string, number>;
    const previousMoney = defeated.money;
    const continued = createExpedition({
      seed: "2".padStart(64, "0"),
      rules: { cycle: "persistent", stepBudget: 6, levelCap: 50, continuation: defeated },
    });

    expect(continued.run).toBe(2);
    expect(continued.area).toBe("spyder_route2");
    expect(continued.team).toEqual(previousTeam);
    expect(continued.inventory).toEqual(previousInventory);
    expect(continued.money).toBe(previousMoney);
    expect(continued.nextAction).toBe(defeated.nextAction);
    expect(continued.nextEventSeq).toBe(defeated.nextEventSeq);
    expect(continued.partyStatus).toEqual([null]);
    expect(observeExpedition(continued).team.every(({ hp }) => hp.current === hp.max)).toBe(true);
    expect(checkExpeditionConservation(continued)).toEqual([]);

    const traveled = apply(continued, action(continued, "travel"));
    expect(traveled.ended).toBe(false);
    const stopped = apply(continued, action(continued, "end"));
    expect(stopped).toMatchObject({ ended: true, endReason: "voluntary" });

    // Recovery is defeat-specific: a wounded voluntary ending carries its HP.
    let wounded = createExpedition({
      seed: "1".padStart(64, "0"),
      rules: { cycle: "persistent", stepBudget: 40 },
    });
    wounded = apply(wounded, action(wounded, "explore"));
    wounded = apply(wounded, legalExpeditionActions(wounded).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    )!);
    expect(wounded.ended).toBe(false);
    expect(wounded.partyHp[0]).toBeGreaterThan(0);
    expect(wounded.partyHp[0]).toBeLessThan(observeExpedition(wounded).team[0]!.hp.max);
    wounded = apply(wounded, action(wounded, "end"));
    const woundedContinuation = createExpedition({
      seed: "3".padStart(64, "0"),
      rules: { cycle: "persistent", stepBudget: 6, continuation: wounded },
    });
    expect(woundedContinuation.partyHp).toEqual(wounded.partyHp);
  });
});

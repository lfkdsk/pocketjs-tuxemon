import { describe, expect, test } from "bun:test";

import battleDbJson from "../data/battle-db.json";
import { validateBattleDb } from "../importer/battle-schema.ts";
import {
  defaultAction,
  isOver,
  submit,
  validateTeam,
  type ArenaBattle,
  type ArenaProvenanceEvent,
} from "../battle/arena.ts";
import {
  appendArenaExperience,
  appendArenaItem,
  arenaTeamRecordFromProvenance,
  buildValidatedArenaTeam,
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
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { defeatExperienceAwards } from "../battle/tuxemon.ts";

const SEED = "0123456789abcdef".repeat(4);
const CAPTURE_SEED = "3".padStart(64, "0");
const DAMAGED_CAPTURE_SEED = "1".padStart(64, "0");
const BATTLE_REWARD_SEED = "0".repeat(64);
const SOURCE_DB = validateBattleDb(battleDbJson);
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function legalAction(expedition: Expedition, type: ExpeditionAction["type"]): ExpeditionAction {
  const found = legalExpeditionActions(expedition).find((candidate) => candidate.type === type);
  if (!found) throw new Error(`expected legal expedition action '${type}'`);
  return found;
}

function apply(expedition: Expedition, action: ExpeditionAction): Expedition {
  const result = applyExpeditionAction(expedition, action);
  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  if (!result.ok) throw new Error(`expedition action failed: ${result.error}`);
  return result.expedition;
}

function finishWithDefaultActions(initial: ArenaBattle): ArenaBattle {
  let battle = clone(initial);
  while (!isOver(battle)) {
    const player = submit(battle, 0, defaultAction(battle, 0));
    if (!player.ok) throw new Error(`player action failed: ${player.error}`);
    const opponent = submit(player.battle, 1, defaultAction(player.battle, 1));
    if (!opponent.ok) throw new Error(`opponent action failed: ${opponent.error}`);
    battle = opponent.battle;
  }
  return battle;
}

function starterExpedition(): Expedition {
  return createExpedition({
    seed: SEED,
    rules: { cycle: "persistent", stepBudget: 5 },
  });
}

describe("expedition provenance adversarial regressions", () => {
  test("a captured record reconstructs the exact generated encounter snapshot", () => {
    let expedition = createExpedition({
      seed: CAPTURE_SEED,
      rules: { cycle: "persistent", stepBudget: 10, initialItems: { tuxeball: 5 } },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const encounter = expedition.encounter;
    expect(encounter).not.toBeNull();
    if (!encounter) return;

    const target = clone(encounter.battle.core.parties[1][0]!);
    expect({ slug: target.slug, level: target.level }).toEqual({ slug: "pairagrin", level: 2 });
    expedition = apply(expedition, legalAction(expedition, "catch"));

    const captured = expedition.team[1]!;
    const rebuilt = buildValidatedArenaTeam([captured], {
      minSize: 1,
      maxSize: 1,
      levelCap: expedition.rules.levelCap,
    })[0]!;
    expect(captured.provenance[0]).toMatchObject({
      seq: encounter.acquireSeq,
      seed: encounter.acquireSeed,
      origin: { capture: { result: "caught", item: "tuxeball", success: true, shakes: 4, status: null } },
    });
    expect({
      iid: rebuilt.iid,
      slug: rebuilt.slug,
      level: rebuilt.level,
      stage: rebuilt.stage,
      gender: rebuilt.gender,
      tasteCold: rebuilt.tasteCold,
      tasteWarm: rebuilt.tasteWarm,
      height: rebuilt.height,
      weight: rebuilt.weight,
      individualValues: rebuilt.individualValues,
      birthdate: rebuilt.birthdate,
      base: rebuilt.base,
      moves: rebuilt.moves,
      types: rebuilt.types,
      totalExperience: rebuilt.totalExperience,
      bond: rebuilt.bond,
      trainingPoints: rebuilt.trainingPoints,
    }).toEqual({
      iid: target.iid,
      slug: target.slug,
      level: target.level,
      stage: target.stage,
      gender: target.gender,
      tasteCold: target.tasteCold,
      tasteWarm: target.tasteWarm,
      height: target.height,
      weight: target.weight,
      individualValues: target.individualValues,
      birthdate: target.birthdate,
      base: target.base,
      moves: target.moves.map(({ slug }) => slug),
      types: target.types,
      totalExperience: target.totalExperience,
      bond: target.bond,
      trainingPoints: target.trainingPoints,
    });
    expect(expedition.partyHp[1]).toBe(Math.min(target.currentHp, rebuilt.base.hp));
    expect(validateTeam([captured], { levelCap: expedition.rules.levelCap })).toEqual({ ok: true, errors: [] });
  });

  test("capturing after damage preserves current HP instead of healing to maximum", () => {
    let expedition = createExpedition({
      seed: DAMAGED_CAPTURE_SEED,
      rules: { cycle: "persistent", stepBudget: 10, initialItems: { tuxeball: 5 } },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const manual = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "manual" &&
      candidate.action.type === "move" && candidate.action.slot === 0
    );
    if (!manual) throw new Error("expected the deterministic damaging manual action");
    expedition = apply(expedition, manual);

    const target = expedition.encounter?.battle.core.parties[1][0];
    expect(target).toMatchObject({ slug: "aardorn", level: 2, currentHp: 27 });
    if (!target) return;
    expect(target.currentHp).toBeGreaterThan(0);
    expect(target.currentHp).toBeLessThan(target.base.hp);

    expedition = apply(expedition, legalAction(expedition, "catch"));
    const captured = expedition.team[1]!;
    const rebuilt = buildValidatedArenaTeam([captured], {
      minSize: 1,
      maxSize: 1,
      levelCap: expedition.rules.levelCap,
    })[0]!;
    expect(rebuilt.base.hp).toBe(57);
    expect(expedition.partyHp[1]).toBe(target.currentHp);
    expect(expedition.partyHp[1]).toBeLessThan(rebuilt.base.hp);
    expect(validateTeam([captured], { levelCap: expedition.rules.levelCap })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("persistent capture status is current expedition state and can be restored", () => {
    let expedition = createExpedition({
      seed: CAPTURE_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 6,
        initialItems: { tuxeball: 1, restoration: 1 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const target = expedition.encounter!.battle.core.parties[1][0]!;
    target.status = {
      slug: "burn",
      turn: 0,
      stack: 1,
      uses: 0,
      linked: null,
      appliedEffects: [],
    };
    expedition = apply(expedition, legalAction(expedition, "catch"));
    expect(expedition.partyStatus).toEqual([null, "burn"]);
    const capture = expedition.team[1]!.provenance[0]!;
    expect(capture.type).toBe("acquire");
    if (capture.type !== "acquire") return;
    expect(capture.origin?.capture).toMatchObject({ status: "burn" });
    expect(observeExpedition(expedition).team[1]!.status).toBe("burn");

    const restore = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "useItem" && candidate.item === "restoration" && candidate.target === 1
    );
    if (!restore) throw new Error("expected restoration for the persistently burned capture");
    expedition = apply(expedition, restore);
    expect(expedition.partyStatus).toEqual([null, null]);
    expect(expedition.inventory.restoration).toBe(0);
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("capture-device persistence and taste effects survive the expedition ledger", () => {
    let hardened = createExpedition({
      seed: DAMAGED_CAPTURE_SEED,
      rules: { cycle: "persistent", stepBudget: 5, initialItems: { tuxeball_hardened: 1 } },
    });
    hardened = apply(hardened, legalAction(hardened, "explore"));
    hardened = apply(hardened, legalAction(hardened, "catch"));
    expect(hardened.team).toHaveLength(1);
    expect(hardened.encounter).not.toBeNull();
    expect(hardened.inventory.tuxeball_hardened).toBe(1);
    expect(hardened.ledger.consumedItems.tuxeball_hardened ?? 0).toBe(0);
    expect(checkExpeditionConservation(hardened)).toEqual([]);

    for (const [item, tasteWarm] of [
      ["tuxeball_hearty", "hearty"],
      ["tuxeball_peppy", "peppy"],
      ["tuxeball_refined", "refined"],
      ["tuxeball_salty", "salty"],
      ["tuxeball_zesty", "zesty"],
    ] as const) {
      let expedition = createExpedition({
        seed: CAPTURE_SEED,
        rules: { cycle: "persistent", stepBudget: 5, initialItems: { [item]: 1 } },
      });
      expedition = apply(expedition, legalAction(expedition, "explore"));
      const target = clone(expedition.encounter!.battle.core.parties[1][0]!);
      const action = legalExpeditionActions(expedition).find((candidate) =>
        candidate.type === "catch" && candidate.item === item
      );
      if (!action) throw new Error(`expected legal capture action for '${item}'`);
      expedition = apply(expedition, action);
      const rebuilt = buildValidatedArenaTeam([expedition.team[1]], {
        minSize: 1,
        maxSize: 1,
        levelCap: expedition.rules.levelCap,
      })[0]!;
      expect(rebuilt.tasteWarm, item).toBe(tasteWarm);
      expect(rebuilt.base, item).toEqual(target.base);
      expect(rebuilt.acquisition, item).toBe("captured");
      expect(rebuilt.captureDevice, item).toBe(item);
      expect(rebuilt.status, item).toBeNull();
      expect(rebuilt.bond, item).toBe(25);
      expect(expedition.inventory[item], item).toBe(0);
      expect(expedition.ledger.consumedItems[item], item).toBe(1);
      expect(checkExpeditionConservation(expedition), item).toEqual([]);
    }
  });

  test("the upstream-broken level capture device is never advertised", () => {
    let expedition = createExpedition({
      seed: CAPTURE_SEED,
      rules: { cycle: "persistent", stepBudget: 5, initialItems: { tuxeball_candy: 1 } },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    expect(legalExpeditionActions(expedition).some((candidate) =>
      candidate.type === "catch" && candidate.item === "tuxeball_candy"
    )).toBe(false);
    expect(expedition.inventory.tuxeball_candy).toBe(1);
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("a caught origin requires every successful capture shake", () => {
    const provenance = (shakes: number, status: string | null = null): ArenaProvenanceEvent[] => [{
      seq: 1,
      type: "acquire",
      seed: "a".repeat(64),
      species: "pairagrin",
      level: 2,
      origin: {
        kind: "expedition",
        area: "spyder_route1",
        step: 1,
        capture: { result: "caught", item: "tuxeball", success: true, shakes, status },
      },
    }];

    expect(() => arenaTeamRecordFromProvenance("pairagrin", provenance(4))).not.toThrow();
    expect(() => arenaTeamRecordFromProvenance("pairagrin", provenance(3))).toThrow(
      "caught origin has an invalid capture result",
    );
    const burned = arenaTeamRecordFromProvenance("pairagrin", provenance(4, "burn"));
    const acquire = burned.provenance[0]!;
    expect(acquire.type).toBe("acquire");
    if (acquire.type !== "acquire") return;
    expect(acquire.origin?.capture).toMatchObject({ status: "burn" });
    expect(buildValidatedArenaTeam([burned], { minSize: 1, maxSize: 1 })[0]!.status).toBeNull();
    expect(() => arenaTeamRecordFromProvenance("pairagrin", provenance(4, "faint"))).toThrow(
      "caught origin has an invalid capture result",
    );
  });

  test("BigInt in later provenance fails closed without escaping validateTeam", () => {
    const record = starterExpedition().team[0]!;
    const malformed = {
      ...record,
      provenance: [
        ...record.provenance,
        { seq: 2, type: "item", item: "raise_melee", step: 1, extra: 1n },
      ],
    };
    let result: ReturnType<typeof validateTeam> | undefined;

    expect(() => { result = validateTeam([malformed]); }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test("cyclic later provenance fails closed without escaping validateTeam", () => {
    const record = starterExpedition().team[0]!;
    const cyclicEvent: Record<string, unknown> = {
      seq: 2,
      type: "item",
      item: "raise_melee",
      step: 1,
    };
    cyclicEvent.extra = cyclicEvent;
    const malformed = { ...record, provenance: [...record.provenance, cyclicEvent] };
    let result: ReturnType<typeof validateTeam> | undefined;

    expect(() => { result = validateTeam([malformed]); }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test("expedition records cannot be downgraded by stripping their mode or authoritative claims", () => {
    const attacks: Array<{
      label: string;
      mutate: (record: Record<string, unknown>) => void;
    }> = [
      {
        label: "missing kind",
        mutate: (record) => { Reflect.deleteProperty(record, "kind"); },
      },
      {
        label: "legacy kind",
        mutate: (record) => { record.kind = "legacy"; },
      },
      {
        label: "missing expedition origin",
        mutate: (record) => {
          const provenance = record.provenance as Array<Record<string, unknown>>;
          Reflect.deleteProperty(provenance[0]!, "origin");
        },
      },
      {
        label: "missing provenance hash",
        mutate: (record) => { Reflect.deleteProperty(record, "provenanceHash"); },
      },
      {
        label: "missing experience claim",
        mutate: (record) => { Reflect.deleteProperty(record, "experience"); },
      },
    ];

    for (const attack of attacks) {
      const expedition = clone(starterExpedition());
      attack.mutate(expedition.team[0] as unknown as Record<string, unknown>);
      const teamValidation = validateTeam(expedition.team, { levelCap: expedition.rules.levelCap });
      expect(teamValidation.ok, attack.label).toBe(false);
      expect(checkExpeditionConservation(expedition).length, attack.label).toBeGreaterThan(0);
      expect(
        applyExpeditionAction(expedition, { type: "end", sequence: expedition.nextAction }),
        attack.label,
      ).toMatchObject({ ok: false, error: "CORRUPT_STATE" });
    }

    const reclassified = clone(starterExpedition().team[0]!) as unknown as Record<string, unknown>;
    reclassified.kind = "legacy";
    Reflect.deleteProperty(reclassified, "experience");
    Reflect.deleteProperty(reclassified, "bond");
    Reflect.deleteProperty(reclassified, "provenanceHash");
    Reflect.deleteProperty((reclassified.provenance as Array<Record<string, unknown>>)[0]!, "origin");
    expect(validateTeam([reclassified], { requiredKind: "expedition" }).ok).toBe(false);

    const exactRecord = starterExpedition().team[0]!;
    const symbolRecord = { ...exactRecord } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol("extra")] = true;
    const hiddenRecord = { ...exactRecord };
    Object.defineProperty(hiddenRecord, "extra", { value: true, enumerable: false });
    const inheritedRecord = Object.create(exactRecord) as Record<string, unknown>;
    for (const malformed of [symbolRecord, hiddenRecord, inheritedRecord]) {
      expect(validateTeam([malformed], { requiredKind: "expedition" }).ok).toBe(false);
    }
  });

  test("two root item transactions cannot reuse one expedition step", () => {
    const expedition = createExpedition({
      seed: SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 5,
        initialItems: { raise_melee: 2 },
      },
    });
    const first = appendArenaItem(
      expedition.team[0]!,
      { type: "item", item: "raise_melee", step: 1 },
      expedition.nextEventSeq,
      { levelCap: expedition.rules.levelCap },
    );

    expect(() => appendArenaItem(
      first.record,
      { type: "item", item: "raise_melee", step: 1 },
      first.nextSeq,
      { levelCap: expedition.rules.levelCap },
    )).toThrow("step must be newer than the preceding expedition transaction");
  });

  test("legal action lookalikes with undefined, symbol, or non-enumerable fields are rejected unchanged", () => {
    const expedition = starterExpedition();
    const legal = legalAction(expedition, "end");
    const undefinedExtra = { ...legal, extra: undefined };
    const symbolExtra = { ...legal } as Record<PropertyKey, unknown>;
    symbolExtra[Symbol("extra")] = true;
    const hiddenExtra = { ...legal };
    Object.defineProperty(hiddenExtra, "extra", { value: true, enumerable: false });

    for (const malformed of [undefinedExtra, symbolExtra, hiddenExtra]) {
      const before = JSON.stringify(expedition);
      const result = applyExpeditionAction(expedition, malformed);
      expect(result).toMatchObject({ ok: false, error: "ILLEGAL_ACTION" });
      expect(result.expedition).toBe(expedition);
      expect(JSON.stringify(expedition)).toBe(before);
    }
  });

  test("a cyclic action is rejected without throwing or mutating expedition state", () => {
    let expedition = starterExpedition();
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const manual = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "manual"
    );
    if (!manual) throw new Error("expected a legal manual battle action");
    const cyclic = { ...manual } as Record<string, unknown>;
    cyclic.action = cyclic;
    const before = JSON.stringify(expedition);
    let result: ReturnType<typeof applyExpeditionAction> | undefined;

    expect(() => { result = applyExpeditionAction(expedition, cyclic); }).not.toThrow();
    expect(result).toMatchObject({ ok: false, error: "ILLEGAL_ACTION" });
    expect(result?.expedition).toBe(expedition);
    expect(JSON.stringify(expedition)).toBe(before);
  });

  test("rules cannot be rewritten to conceal money, inventory, or step-budget tampering", () => {
    const cases: Array<{
      label: string;
      mutate: (expedition: Expedition) => void;
      error: string;
    }> = [
      {
        label: "initial money",
        mutate: (expedition) => { expedition.rules.initialMoney++; },
        error: "base money does not match rules",
      },
      {
        label: "initial inventory",
        mutate: (expedition) => { expedition.rules.initialItems.potion++; },
        error: "base inventory does not match rules",
      },
      {
        label: "step budget",
        mutate: (expedition) => { expedition.rules.stepBudget++; },
        error: "step budget is out of range",
      },
      {
        label: "paired base and current money",
        mutate: (expedition) => {
          expedition.ledger.baseMoney++;
          expedition.money++;
        },
        error: "base money does not match rules",
      },
      {
        label: "paired base and current inventory",
        mutate: (expedition) => {
          expedition.ledger.baseItems.potion++;
          expedition.inventory.potion++;
        },
        error: "base inventory does not match rules",
      },
    ];

    for (const scenario of cases) {
      const expedition = clone(starterExpedition());
      scenario.mutate(expedition);
      expect(checkExpeditionConservation(expedition).join("\n"), scenario.label).toContain(scenario.error);
      const result = applyExpeditionAction(expedition, { type: "end", sequence: expedition.nextAction });
      expect(result, scenario.label).toMatchObject({ ok: false, error: "CORRUPT_STATE" });
      expect(result.expedition).toBe(expedition);
    }
  });

  test("action-budget and RNG cursors cannot be independently rewritten", () => {
    const cases: Array<{
      label: string;
      mutate: (expedition: Expedition) => void;
      error: string;
    }> = [
      {
        label: "next action",
        mutate: (expedition) => { expedition.nextAction++; },
        error: "step budget is out of range",
      },
      {
        label: "remaining steps",
        mutate: (expedition) => { expedition.remainingSteps--; },
        error: "step budget is out of range",
      },
      {
        label: "run start action",
        mutate: (expedition) => { expedition.runStartAction = 0; },
        error: "step budget is out of range",
      },
      {
        label: "RNG cursor",
        mutate: (expedition) => { expedition.rng = (expedition.rng + 1) >>> 0; },
        error: "RNG cursor does not match its draw count",
      },
      {
        label: "RNG draw count",
        mutate: (expedition) => { expedition.rngDraws++; },
        error: "RNG cursor does not match its draw count",
      },
      {
        label: "invalid RNG range",
        mutate: (expedition) => { expedition.rng = -1; },
        error: "RNG state is invalid",
      },
    ];

    for (const scenario of cases) {
      const expedition = clone(starterExpedition());
      scenario.mutate(expedition);
      expect(checkExpeditionConservation(expedition).join("\n"), scenario.label).toContain(scenario.error);
      expect(
        applyExpeditionAction(expedition, { type: "end", sequence: expedition.nextAction }),
        scenario.label,
      ).toMatchObject({ ok: false, error: "CORRUPT_STATE" });
    }
  });

  test("malformed authoritative envelopes fail closed before public apply", () => {
    const cases: Array<{
      label: string;
      mutate: (expedition: Expedition & Record<string, unknown>) => void;
    }> = [
      { label: "missing ledger", mutate: (expedition) => { Reflect.deleteProperty(expedition, "ledger"); } },
      { label: "unknown area", mutate: (expedition) => { expedition.area = "not_real"; } },
      { label: "wrong version", mutate: (expedition) => { expedition.v = 2 as 1; } },
      { label: "invalid run", mutate: (expedition) => { expedition.run = 0; } },
      { label: "missing normalized rule", mutate: (expedition) => {
        Reflect.deleteProperty(expedition.rules, "initialItems");
      } },
      { label: "unknown terminal reason", mutate: (expedition) => {
        expedition.ended = true;
        expedition.endReason = "forged" as "voluntary";
      } },
      { label: "false defeat", mutate: (expedition) => {
        expedition.ended = true;
        expedition.endReason = "defeated";
      } },
      { label: "provenance sequence gap", mutate: (expedition) => { expedition.nextEventSeq = 999; } },
      { label: "extra BigInt", mutate: (expedition) => { expedition.extra = 1n; } },
      { label: "cyclic extra", mutate: (expedition) => { expedition.extra = expedition; } },
    ];

    for (const scenario of cases) {
      const expedition = clone(starterExpedition()) as Expedition & Record<string, unknown>;
      scenario.mutate(expedition);
      let errors: string[] | undefined;
      let result: ReturnType<typeof applyExpeditionAction> | undefined;
      expect(() => { errors = checkExpeditionConservation(expedition); }, scenario.label).not.toThrow();
      expect(errors?.length, scenario.label).toBeGreaterThan(0);
      expect(() => {
        result = applyExpeditionAction(expedition, { type: "end", sequence: expedition.nextAction });
      }, scenario.label).not.toThrow();
      expect(result, scenario.label).toMatchObject({ ok: false, error: "CORRUPT_STATE" });
      expect(result?.expedition, scenario.label).toBe(expedition);
    }
  });

  test("provenance root transactions must belong to one accepted global action", () => {
    const future = createExpedition({
      seed: SEED,
      rules: { cycle: "persistent", stepBudget: 5, initialItems: { raise_melee: 1 } },
    });
    const fabricated = appendArenaItem(future.team[0]!, {
      type: "item",
      item: "raise_melee",
      step: future.nextAction,
    }, future.nextEventSeq, { levelCap: future.rules.levelCap });
    future.team[0] = fabricated.record;
    future.nextEventSeq = fabricated.nextSeq;
    future.inventory.raise_melee = 0;
    future.ledger.consumedItems.raise_melee = 1;
    expect(checkExpeditionConservation(future).join("\n")).toContain("outside the accepted action prefix");

    let doubled = createExpedition({
      seed: CAPTURE_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 10,
        initialItems: { tuxeball: 1, raise_melee: 2 },
      },
    });
    doubled = apply(doubled, legalAction(doubled, "explore"));
    doubled = apply(doubled, legalAction(doubled, "catch"));
    expect(doubled.team).toHaveLength(2);
    const step = doubled.nextAction;
    const first = appendArenaItem(doubled.team[0]!, {
      type: "item", item: "raise_melee", step,
    }, doubled.nextEventSeq, { levelCap: doubled.rules.levelCap });
    const second = appendArenaItem(doubled.team[1]!, {
      type: "item", item: "raise_melee", step,
    }, first.nextSeq, { levelCap: doubled.rules.levelCap });
    doubled.team = [first.record, second.record];
    doubled.nextEventSeq = second.nextSeq;
    doubled.inventory.raise_melee = 0;
    doubled.ledger.consumedItems.raise_melee = 2;
    doubled.nextAction++;
    doubled.remainingSteps--;
    expect(checkExpeditionConservation(doubled).join("\n")).toContain(
      "contains more than one item or capture transaction",
    );
  });

  test("battle XP, training points, and bond match an independent Arena replay", () => {
    let expedition = createExpedition({
      seed: BATTLE_REWARD_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 10,
        starter: { species: "rockitten", level: 5 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const encounter = expedition.encounter;
    expect(encounter).not.toBeNull();
    if (!encounter) return;

    const before = buildValidatedArenaTeam(expedition.team, {
      levelCap: expedition.rules.levelCap,
    })[0]!;
    const beforeExperience = before.totalExperience;
    if (beforeExperience === undefined) throw new Error("validated Arena snapshot omitted experience");
    const independent = finishWithDefaultActions(encounter.battle);
    const reward = independent.core.rewards.at(-1);
    const winnerReward = reward?.winners[0];
    expect(independent.terminal).toMatchObject({ winner: 0, reason: "knockout" });
    expect(winnerReward).toBeDefined();
    if (!reward || !winnerReward) return;

    const winner = independent.core.parties[0].find(({ uid }) => uid === winnerReward.uid)!;
    const loser = clone(independent.core.parties[1][0]!);
    loser.experienceModifier = encounter.experienceModifier;
    const rewardState = clone(independent.core);
    rewardState.parties[1][0] = loser;
    const participants = reward.participants ?? reward.winners.map(({ uid }) => uid);
    rewardState.damageByDefender[String(loser.uid)] = [...participants];
    const expectedExperience = defeatExperienceAwards(RULES_DB, rewardState, loser).get(winner.uid)!;

    const auto = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    );
    if (!auto) throw new Error("expected legal automatic battle action");
    expedition = apply(expedition, auto);
    const record = expedition.team[0]!;
    const rebuilt = buildValidatedArenaTeam([record], {
      minSize: 1,
      maxSize: 1,
      levelCap: expedition.rules.levelCap,
    })[0]!;
    const event = record.provenance.find((candidate) => candidate.type === "experience");
    expect(event?.type).toBe("experience");
    if (!event || event.type !== "experience" || event.source.kind !== "battle") return;

    expect(event).toMatchObject({
      amount: expectedExperience,
      source: {
        kind: "battle",
        opponentSeed: encounter.acquireSeed,
        opponentSeq: encounter.acquireSeq,
        participants: participants.length,
        trainingPoints: winnerReward.trainingPoints,
      },
    });
    expect(rebuilt.totalExperience).toBe(beforeExperience + expectedExperience);
    expect(rebuilt.trainingPoints).toEqual(winner.trainingPoints);
    expect(rebuilt.base).toEqual(winner.base);
    expect(rebuilt.bond).toBe(winner.bond);
    expect(record.bond).toBe(winner.bond);
    expect(validateTeam([record], { levelCap: expedition.rules.levelCap })).toEqual({ ok: true, errors: [] });
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("battle settlement keeps production HP after TP and a level gain", () => {
    let expedition = createExpedition({
      seed: DAMAGED_CAPTURE_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 5,
        starter: { species: "rockitten", level: 1 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const encounter = expedition.encounter;
    if (!encounter) throw new Error("expected deterministic level-up encounter");
    const independent = finishWithDefaultActions(encounter.battle);
    const winner = independent.core.parties[0][0]!;
    expect(independent.terminal).toMatchObject({ winner: 0, reason: "knockout" });
    expect(independent.core.rewards.at(-1)?.winners[0]).toMatchObject({
      levelsGained: 1,
      trainingPoints: ["armour", "hp", "ranged"],
    });

    const automatic = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    );
    if (!automatic) throw new Error("expected automatic battle action");
    expedition = apply(expedition, automatic);
    const rebuilt = buildValidatedArenaTeam(expedition.team, {
      levelCap: expedition.rules.levelCap,
      requiredKind: "expedition",
    })[0]!;
    expect(expedition.team[0]).toMatchObject({ level: 2, bond: 28 });
    expect(rebuilt.base).toEqual(winner.base);
    expect(expedition.partyHp[0]).toBe(winner.currentHp);
    expect(expedition.partyHp[0]).toBe(11);
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("a max-level victory still records TP and bond even when XP is zero", () => {
    let expedition = createExpedition({
      seed: BATTLE_REWARD_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 5,
        levelCap: 100,
        starter: { species: "rockitten", level: 100 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const automatic = legalExpeditionActions(expedition).find((candidate) =>
      candidate.type === "battle" && candidate.mode === "auto"
    );
    if (!automatic) throw new Error("expected automatic max-level battle action");
    expedition = apply(expedition, automatic);
    const record = expedition.team[0]!;
    const reward = record.provenance.find((event) => event.type === "experience");
    expect(reward).toMatchObject({ type: "experience", amount: 0 });
    expect(record).toMatchObject({ level: 100, experience: 1_000_000, bond: 28 });
    expect(validateTeam([record], { levelCap: 100, requiredKind: "expedition" })).toEqual({
      ok: true,
      errors: [],
    });
    expect(checkExpeditionConservation(expedition)).toEqual([]);
  });

  test("battle-source validation binds participant count to the real divided reward", () => {
    let expedition = createExpedition({
      seed: BATTLE_REWARD_SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 10,
        starter: { species: "rockitten", level: 5 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "explore"));
    const encounter = expedition.encounter;
    if (!encounter) throw new Error("expected deterministic reward encounter");
    const source = {
      kind: "battle" as const,
      area: encounter.area,
      species: encounter.species,
      level: encounter.level,
      experienceModifier: encounter.experienceModifier,
      participants: 2,
      opponentSeed: encounter.acquireSeed,
      opponentSeq: encounter.acquireSeq,
      trainingPoints: ["armour" as const],
    };
    const appended = appendArenaExperience(expedition.team[0]!, {
      type: "experience",
      step: 2,
      amount: 24,
      source,
    }, expedition.nextEventSeq, { levelCap: expedition.rules.levelCap });

    expect(appended.record).toMatchObject({ experience: 149, bond: 28 });
    expect(validateTeam([appended.record], { levelCap: expedition.rules.levelCap })).toEqual({
      ok: true,
      errors: [],
    });
    expect(() => appendArenaExperience(expedition.team[0]!, {
      type: "experience",
      step: 2,
      amount: 48,
      source,
    }, expedition.nextEventSeq, { levelCap: expedition.rules.levelCap })).toThrow("amount does not match source");
    expect(() => appendArenaExperience(expedition.team[0]!, {
      type: "experience",
      step: 2,
      amount: 24,
      source: { ...source, participants: 7 },
    }, expedition.nextEventSeq, { levelCap: expedition.rules.levelCap })).toThrow("invalid battle reward fields");
  });

  test("large XP gains emit sequential level and learn audits with the exact forget transition", () => {
    let expedition = createExpedition({
      seed: SEED,
      rules: {
        cycle: "persistent",
        stepBudget: 5,
        starter: { species: "rockitten", level: 1 },
        initialItems: { imperial_tea: 1 },
      },
    });
    expedition = apply(expedition, legalAction(expedition, "useItem"));
    const record = expedition.team[0]!;

    expect(record.provenance.slice(1)).toEqual([
      { seq: 2, type: "item", item: "imperial_tea", step: 1 },
      { seq: 3, type: "experience", step: 1, amount: 10_000,
        source: { kind: "item", item: "imperial_tea" } },
      ...Array.from({ length: 20 }, (_, index) => ({
        seq: index + 4,
        type: "level" as const,
        level: index + 2,
        step: 1,
      })),
      { seq: 24, type: "learn", move: "mudslide", step: 1 },
      { seq: 25, type: "learn", move: "assault", step: 1 },
      { seq: 26, type: "learn", move: "thunderball", forget: "ram", step: 1 },
    ]);
    expect(record).toMatchObject({
      level: 21,
      experience: 10_001,
      moves: ["boulder", "mudslide", "assault", "thunderball"],
    });
    expect(validateTeam([record], { levelCap: expedition.rules.levelCap })).toEqual({ ok: true, errors: [] });

    const reordered = clone(record.provenance);
    reordered[23] = { ...reordered[23]!, move: "assault" } as ArenaProvenanceEvent;
    reordered[24] = { ...reordered[24]!, move: "mudslide" } as ArenaProvenanceEvent;

    const movedForget = clone(record.provenance) as Array<ArenaProvenanceEvent & { forget?: string }>;
    movedForget[23]!.forget = "ram";
    delete movedForget[25]!.forget;

    const missingForget = clone(record.provenance) as Array<ArenaProvenanceEvent & { forget?: string }>;
    delete missingForget[25]!.forget;

    for (const malformed of [reordered, movedForget, missingForget]) {
      expect(() => arenaTeamRecordFromProvenance("rockitten", malformed, {
        levelCap: expedition.rules.levelCap,
      })).toThrow("does not match the derived learn audit");
    }
  });
});

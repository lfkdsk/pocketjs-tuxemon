import { describe, expect, test } from "bun:test";

import {
  EXPEDITION_JOURNAL_CHECKPOINT_INTERVAL,
  EXPEDITION_JOURNAL_FORMAT,
  MAX_EXPEDITION_JOURNAL_BYTES,
  MAX_EXPEDITION_JOURNAL_ENTRIES,
  appendExpeditionJournal,
  startExpeditionJournal,
  validateExpeditionJournal,
  type ExpeditionJournal,
  type ExpeditionJournalPublicRules,
  type ValidatedExpeditionJournal,
} from "../battle/expedition-journal.ts";
import {
  applyExpeditionAction,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type Expedition,
  type ExpeditionAction,
  type ExpeditionObservation,
} from "../battle/expedition.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const SEED = "0123456789abcdef".repeat(4);
type ExpeditionActionBody = ExpeditionAction extends infer Action
  ? Action extends unknown ? Omit<Action, "sequence"> : never
  : never;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function publicRules(expedition: Expedition): ExpeditionJournalPublicRules {
  return {
    cycle: expedition.rules.cycle,
    stepBudget: expedition.rules.stepBudget,
    levelCap: expedition.rules.levelCap,
    // A continuation starts at the retained public area, regardless of the
    // private continuation config's unused default startingArea.
    startingArea: expedition.area,
  };
}

function apply(expedition: Expedition, action: ExpeditionAction): Expedition {
  const result = applyExpeditionAction(expedition, action);
  if (!result.ok) throw new Error(`advertised action was rejected: ${result.error}`);
  return result.expedition;
}

function append(
  expedition: Expedition,
  journal: ExpeditionJournal,
  action: ExpeditionAction,
): { expedition: Expedition; journal: ExpeditionJournal } {
  const next = apply(expedition, action);
  return {
    expedition: next,
    journal: appendExpeditionJournal(journal, action, observeExpedition(next)),
  };
}

function expanded(journal: unknown): ValidatedExpeditionJournal {
  const checked = validateExpeditionJournal(journal);
  if (!checked.ok) throw new Error(`expected a valid journal: ${checked.error}`);
  return checked.journal;
}

function replaceEncodedObservation(
  journal: ExpeditionJournal,
  index: number,
  mutate: (observation: any) => void,
): void {
  const observation = clone(expanded(journal).entries[index]!.observation) as any;
  mutate(observation);
  const entry = journal.entries[index]!;
  entry.observation = entry.step % EXPEDITION_JOURNAL_CHECKPOINT_INTERVAL === 0
    ? { kind: "full", value: observation }
    : { kind: "delta", changes: [{ path: [], value: observation }] };
}

function allKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, output);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      output.add(key);
      allKeys(entry, output);
    }
  }
  return output;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomJson(random: () => number, depth: number): unknown {
  const choice = Math.floor(random() * (depth > 0 ? 7 : 5));
  if (choice === 0) return null;
  if (choice === 1) return random() < 0.5;
  if (choice === 2) return Math.floor(random() * 100) - 50;
  if (choice === 3) return `fuzz-${Math.floor(random() * 1_000)}`;
  if (choice === 4) return random() < 0.5 ? Number.NaN : Number.POSITIVE_INFINITY;
  if (choice === 5) {
    return Array.from({ length: Math.floor(random() * 5) }, () => randomJson(random, depth - 1));
  }
  const output: Record<string, unknown> = {};
  for (let index = 0; index < Math.floor(random() * 5); index++) {
    output[`key${Math.floor(random() * 8)}`] = randomJson(random, depth - 1);
  }
  return output;
}

describe("public expedition journal v1", () => {
  test("starts and appends immutable compact observations with exact continuity", () => {
    let expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 8 },
    });
    const initial = observeExpedition(expedition);
    let journal = startExpeditionJournal(publicRules(expedition), initial);
    const emptyBytes = canonicalJson(journal);
    expect(journal).toEqual({
      format: EXPEDITION_JOURNAL_FORMAT,
      rules: publicRules(expedition),
      initialObservation: initial,
      entries: [],
    });

    const explore = legalExpeditionActions(expedition).find((action) => action.type === "explore");
    if (!explore) throw new Error("expected explore action");
    ({ expedition, journal } = append(expedition, journal, explore));
    expect(canonicalJson(startExpeditionJournal(publicRules(createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 8 },
    })), initial))).toBe(emptyBytes);
    expect(journal.entries[0]!.step).toBe(1);
    expect(journal.entries[0]!.action).toEqual(explore);
    expect(journal.entries[0]!.observation.kind).toBe("delta");
    expect(expanded(journal).entries[0]!.observation).toEqual(observeExpedition(expedition));

    const battle = legalExpeditionActions(expedition).find((action) =>
      action.type === "battle" && action.mode === "auto");
    if (!battle) throw new Error("expected automatic battle action");
    const prior = journal;
    ({ expedition, journal } = append(expedition, journal, battle));
    expect(prior.entries).toHaveLength(1);
    expect(journal.entries[1]!.step).toBe(2);
    expect(journal.entries[1]!.action.sequence)
      .toBe(expanded(prior).entries[0]!.observation.nextAction);
    const checked = expanded(journal);
    expect(checked.entries[1]!.observation.nextAction).toBe(journal.entries[1]!.action.sequence + 1);
    expect(checked.entries[1]!.observation).toEqual(observeExpedition(expedition));

    const forbidden = [
      "seed", "rng", "rngDraws", "provenance", "ledger", "nextEventSeq",
      "shopPurchases", "acquireSeed", "partyIndices",
    ];
    const keys = allKeys(journal);
    for (const key of forbidden) expect(keys.has(key), `${key} leaked`).toBe(false);
    expect(JSON.stringify(journal)).not.toContain(SEED);
  });

  test("accepts every exact public action variant and clones caller-owned values", () => {
    const expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 20 },
    });
    let journal = startExpeditionJournal(publicRules(expedition), observeExpedition(expedition));
    const actionBodies: ExpeditionActionBody[] = [
      { type: "travel", area: "spyder_route2" },
      { type: "explore" },
      { type: "battle", mode: "auto" },
      { type: "battle", mode: "manual", action: { type: "move", slot: 0 } },
      { type: "catch", item: "tuxeball" },
      { type: "flee" },
      { type: "useItem", item: "potion", target: 0 },
      { type: "learnMove", item: "tm", move: "pound", target: 0, forget: "scratch" },
      { type: "heal" },
      { type: "shop", shop: "spyder_cotton_scoop", item: "potion", quantity: 1 },
      { type: "end" },
    ];
    let previous = journal.initialObservation;
    for (const [index, body] of actionBodies.entries()) {
      const action = { ...body, sequence: previous.nextAction } as ExpeditionAction;
      const observation: ExpeditionObservation = {
        ...clone(previous),
        remainingSteps: previous.remainingSteps - 1,
        nextAction: previous.nextAction + 1,
        ...(body.type === "end" ? { status: "ended", result: { reason: "voluntary" } } : {}),
      };
      journal = appendExpeditionJournal(journal, action, observation);
      (action as { sequence: number }).sequence = 999;
      observation.money = 999;
      expect(journal.entries[index]!.action.sequence).toBe(previous.nextAction);
      previous = expanded(journal).entries[index]!.observation;
      expect(previous.money).not.toBe(999);
    }
    expect(validateExpeditionJournal(journal).ok).toBe(true);
  });

  test("emits full checkpoints and resumes appends from a JSON round trip", () => {
    let expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 66, startingArea: "spyder_citypark" },
    });
    let journal = startExpeditionJournal(publicRules(expedition), observeExpedition(expedition));
    const expected: ExpeditionObservation[] = [];
    for (let index = 0; index < 65; index++) {
      const action = legalExpeditionActions(expedition).find((candidate) => candidate.type === "travel");
      if (!action) throw new Error("expected a connected travel action");
      ({ expedition, journal } = append(expedition, journal, action));
      expected.push(observeExpedition(expedition));
      if (index === 63) journal = clone(journal);
    }

    expect(journal.entries[62]!.observation.kind).toBe("delta");
    expect(journal.entries[63]!.observation.kind).toBe("full");
    expect(journal.entries[64]!.observation.kind).toBe("delta");
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.entries)).toBe(true);
    expect(Object.isFrozen(journal.entries[64]!.observation)).toBe(true);
    expect(expanded(journal).entries.map((entry) => canonicalJson(entry.observation)))
      .toEqual(expected.map(canonicalJson));
  });

  test("rejects extra fields at every public boundary, including nested battle state", () => {
    let expedition = createExpedition({ seed: SEED, rules: { cycle: "ranked", stepBudget: 4 } });
    let journal = startExpeditionJournal(publicRules(expedition), observeExpedition(expedition));
    const explore = legalExpeditionActions(expedition).find((action) => action.type === "explore");
    if (!explore) throw new Error("expected explore action");
    ({ expedition, journal } = append(expedition, journal, explore));
    expect(expanded(journal).entries[0]!.observation.encounter).not.toBeNull();

    const mutations: Array<(value: any) => void> = [
      (value) => { value.seed = SEED; },
      (value) => { value.rules.initialMoney = 1_000; },
      (value) => { value.initialObservation.team[0].species.provenance = []; },
      (value) => { value.entries[0].ledger = {}; },
      (value) => { value.entries[0].action.rng = 0; },
    ];
    for (const mutate of mutations) {
      const changed = clone(journal);
      mutate(changed);
      const checked = validateExpeditionJournal(changed);
      expect(checked.ok, checked.ok ? "unexpectedly accepted" : checked.error).toBe(false);
    }

    const observationMutations: Array<(value: any) => void> = [
      (value) => { value.nextEventSeq = 2; },
      (value) => { value.encounter.battle.pending = [null, null]; },
      (value) => { value.encounter.battle.own.party[0].base.seed = "hidden"; },
    ];
    for (const mutate of observationMutations) {
      const changed = clone(journal);
      replaceEncodedObservation(changed, 0, mutate);
      const checked = validateExpeditionJournal(changed);
      expect(checked.ok, checked.ok ? "unexpectedly accepted" : checked.error).toBe(false);
    }
  });

  test("rejects gaps, stale nonces, broken observations, and post-terminal entries", () => {
    const expedition = createExpedition({ seed: SEED, rules: { cycle: "ranked", stepBudget: 3 } });
    const initial = observeExpedition(expedition);
    const action = legalExpeditionActions(expedition).find((candidate) => candidate.type === "end")!;
    const ended = apply(expedition, action);
    const valid = appendExpeditionJournal(
      startExpeditionJournal(publicRules(expedition), initial),
      action,
      observeExpedition(ended),
    );
    expect(validateExpeditionJournal(valid).ok).toBe(true);

    const envelopeCases = [
      (value: any) => { value.entries[0].step = 2; },
      (value: any) => { value.entries[0].action.sequence++; },
      (value: any) => { value.entries.push(clone(value.entries[0])); value.entries[1].step = 2; },
    ];
    for (const mutate of envelopeCases) {
      const changed = clone(valid);
      mutate(changed);
      expect(validateExpeditionJournal(changed).ok).toBe(false);
    }
    const observationCases = [
      (value: any) => { value.nextAction++; },
      (value: any) => { value.remainingSteps++; },
      (value: any) => { value.run++; },
    ];
    for (const mutate of observationCases) {
      const changed = clone(valid);
      replaceEncodedObservation(changed, 0, mutate);
      expect(validateExpeditionJournal(changed).ok).toBe(false);
    }
    expect(() => appendExpeditionJournal(valid, { type: "end", sequence: ended.nextAction }, observeExpedition(ended)))
      .toThrow();
  });

  test("bounds a maximum-budget compact journal and rejects entries beyond the engine cap", () => {
    const expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: MAX_EXPEDITION_JOURNAL_ENTRIES, startingArea: "spyder_citypark" },
    });
    const initial = observeExpedition(expedition);
    const entries: ExpeditionJournal["entries"] = Array.from(
      { length: MAX_EXPEDITION_JOURNAL_ENTRIES },
      (_, index) => {
        const step = index + 1;
        const observation: ExpeditionObservation = {
        ...initial,
        nextAction: initial.nextAction + index + 1,
        remainingSteps: MAX_EXPEDITION_JOURNAL_ENTRIES - index - 1,
        ...(index === MAX_EXPEDITION_JOURNAL_ENTRIES - 1
          ? { status: "ended" as const, result: { reason: "budget" as const } }
          : {}),
        };
        const changes = [
          { path: ["nextAction"], value: observation.nextAction },
          { path: ["remainingSteps"], value: observation.remainingSteps },
          ...(step === MAX_EXPEDITION_JOURNAL_ENTRIES
            ? [
              { path: ["result"], value: observation.result },
              { path: ["status"], value: observation.status },
            ]
            : []),
        ];
        return {
          step,
          action: { type: "explore", sequence: initial.nextAction + index } as ExpeditionAction,
          observation: step % EXPEDITION_JOURNAL_CHECKPOINT_INTERVAL === 0
            ? { kind: "full", value: observation }
            : { kind: "delta", changes },
        };
      },
    );
    const atLimit: ExpeditionJournal = {
      format: EXPEDITION_JOURNAL_FORMAT,
      rules: publicRules(expedition),
      initialObservation: initial,
      entries,
    };
    const checked = validateExpeditionJournal(atLimit);
    expect(checked.ok, checked.ok ? undefined : checked.error).toBe(true);
    if (!checked.ok) return;
    const bytes = new TextEncoder().encode(JSON.stringify(atLimit)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_EXPEDITION_JOURNAL_BYTES);
    expect(checked.journal.entries).toHaveLength(MAX_EXPEDITION_JOURNAL_ENTRIES);
    expect(atLimit.entries[62]!.observation.kind).toBe("delta");
    expect(atLimit.entries[63]!.observation.kind).toBe("full");

    const tooMany = { ...atLimit, entries: [...entries, entries.at(-1)!] };
    expect(validateExpeditionJournal(tooMany)).toEqual({
      ok: false,
      error: expect.stringContaining(`${MAX_EXPEDITION_JOURNAL_ENTRIES}-entry limit`),
    });
    const longName = clone(atLimit);
    longName.entries = [];
    longName.initialObservation.area.name = "x".repeat(1_025);
    expect(validateExpeditionJournal(longName).ok).toBe(false);
  }, 30_000);

  test("rejects an otherwise valid journal whose encoded UTF-8 exceeds 64 MiB", () => {
    const stepBudget = 8_000;
    const expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget },
    });
    const initial = observeExpedition(expedition);
    const alternatingNames = [
      String.fromCharCode(0).repeat(700),
      String.fromCharCode(1).repeat(700),
    ];
    let previous = initial;
    const entries: ExpeditionJournal["entries"] = [];

    for (let index = 0; index < stepBudget; index++) {
      const step = index + 1;
      const name = alternatingNames[index % alternatingNames.length]!;
      const observation: ExpeditionObservation = {
        ...previous,
        remainingSteps: stepBudget - step,
        nextAction: initial.nextAction + step,
        team: previous.team.map((member, memberIndex) => memberIndex === 0
          ? { ...member, species: { ...member.species, en_US: name, zh_CN: name } }
          : member),
      };
      entries.push({
        step,
        action: { type: "explore", sequence: initial.nextAction + index },
        observation: step % EXPEDITION_JOURNAL_CHECKPOINT_INTERVAL === 0
          ? { kind: "full", value: observation }
          : {
              kind: "delta",
              changes: [
                { path: ["nextAction"], value: observation.nextAction },
                { path: ["remainingSteps"], value: observation.remainingSteps },
                { path: ["team", 0, "species", "en_US"], value: name },
                { path: ["team", 0, "species", "zh_CN"], value: name },
              ],
            },
      });
      previous = observation;
    }

    const oversized: ExpeditionJournal = {
      format: EXPEDITION_JOURNAL_FORMAT,
      rules: {
        cycle: expedition.rules.cycle,
        stepBudget,
        levelCap: expedition.rules.levelCap,
        startingArea: expedition.area,
      },
      initialObservation: initial,
      entries,
    };
    const encodedBytes = new TextEncoder().encode(JSON.stringify(oversized)).byteLength;
    expect(encodedBytes).toBeGreaterThan(MAX_EXPEDITION_JOURNAL_BYTES);
    expect(validateExpeditionJournal(oversized)).toEqual({
      ok: false,
      error: expect.stringContaining(`${MAX_EXPEDITION_JOURNAL_BYTES}-byte limit`),
    });
  }, 30_000);

  test("malformed fuzz, exotic objects, cycles, sparse arrays, and accessors never throw", () => {
    const random = lcg(0xdecafbad);
    for (let index = 0; index < 2_000; index++) {
      const value = randomJson(random, 5);
      let checked: ReturnType<typeof validateExpeditionJournal> | undefined;
      expect(() => { checked = validateExpeditionJournal(value); }).not.toThrow();
      expect(checked?.ok, `malformed sample ${index} was accepted`).toBe(false);
    }

    const expedition = createExpedition({ seed: SEED, rules: { cycle: "ranked", stepBudget: 2 } });
    const journal = startExpeditionJournal(publicRules(expedition), observeExpedition(expedition));
    const malformed: unknown[] = [];
    const cyclic = clone(journal) as any;
    cyclic.initialObservation.area = cyclic;
    malformed.push(cyclic);
    const sparse = clone(journal) as any;
    sparse.entries = new Array(1);
    malformed.push(sparse);
    const symbol = clone(journal) as any;
    symbol[Symbol("hidden")] = true;
    malformed.push(symbol);
    const inherited = Object.create({ seed: SEED });
    Object.assign(inherited, journal);
    malformed.push(inherited);
    let getterRead = false;
    const accessor = clone(journal) as any;
    Object.defineProperty(accessor, "format", {
      enumerable: true,
      get() { getterRead = true; return EXPEDITION_JOURNAL_FORMAT; },
    });
    malformed.push(accessor);
    malformed.push(new Proxy({}, { ownKeys() { throw new Error("proxy trap"); } }));
    for (const value of malformed) {
      expect(() => validateExpeditionJournal(value)).not.toThrow();
      expect(validateExpeditionJournal(value).ok).toBe(false);
    }
    expect(getterRead).toBe(false);
  });

  test("1,000 randomized journals preserve every reducer observation byte-for-byte", () => {
    const random = lcg(0x8badf00d);
    for (let run = 0; run < 1_000; run++) {
      let expedition = createExpedition({
        seed: (run + 1).toString(16).padStart(64, "0"),
        rules: { cycle: "ranked", stepBudget: 4 },
      });
      let journal = startExpeditionJournal(publicRules(expedition), observeExpedition(expedition));
      const expected: ExpeditionObservation[] = [];
      while (!expedition.ended) {
        const actions = legalExpeditionActions(expedition);
        const action = actions[Math.floor(random() * actions.length)]!;
        const next = apply(expedition, action);
        const observation = observeExpedition(next);
        expected.push(observation);
        journal = appendExpeditionJournal(journal, action, observation);
        expedition = next;
      }
      const checked = validateExpeditionJournal(JSON.parse(JSON.stringify(journal)));
      expect(checked.ok, checked.ok ? undefined : checked.error).toBe(true);
      if (!checked.ok) continue;
      expect(checked.journal.entries.map((entry) => canonicalJson(entry.observation)))
        .toEqual(expected.map(canonicalJson));
    }
  }, 30_000);

  test("accepts forged but schema-consistent observations without applying game rules", () => {
    const expedition = createExpedition({
      seed: SEED,
      rules: { cycle: "ranked", stepBudget: 2 },
    });
    const initial = observeExpedition(expedition);
    const journal = startExpeditionJournal(publicRules(expedition), initial);
    const action = legalExpeditionActions(expedition).find((candidate) => candidate.type === "travel")!;
    const actual = observeExpedition(apply(expedition, action));
    const forged = clone(actual);
    forged.team[0]!.level++;

    const forgedJournal = appendExpeditionJournal(journal, action, forged);
    const checked = validateExpeditionJournal(forgedJournal);
    expect(forged.team[0]!.level).toBe(actual.team[0]!.level + 1);
    expect(checked.ok, checked.ok ? undefined : checked.error).toBe(true);
  });

  test("identical public continuation prefixes neither expose nor determine a fresh seed", () => {
    let previous = createExpedition({
      seed: SEED,
      rules: { cycle: "persistent", stepBudget: 2 },
    });
    previous = apply(previous, legalExpeditionActions(previous).find((action) => action.type === "end")!);

    const continuation = (seed: string) => createExpedition({
      seed,
      rules: { cycle: "persistent", stepBudget: 3, continuation: previous },
    });
    const leftStart = continuation("1".padStart(64, "0"));
    const leftInitial = observeExpedition(leftStart);
    const leftPrefix = startExpeditionJournal(publicRules(leftStart), leftInitial);
    const leftAfter = apply(leftStart,
      legalExpeditionActions(leftStart).find((action) => action.type === "explore")!);
    let rightStart: Expedition | undefined;
    let rightAfter: Expedition | undefined;
    for (let candidate = 2; candidate < 100; candidate++) {
      const possible = continuation(candidate.toString(16).padStart(64, "0"));
      const possibleAfter = apply(possible,
        legalExpeditionActions(possible).find((action) => action.type === "explore")!);
      const leftEncounter = observeExpedition(leftAfter).encounter;
      const rightEncounter = observeExpedition(possibleAfter).encounter;
      if (canonicalJson(leftEncounter) !== canonicalJson(rightEncounter)) {
        rightStart = possible;
        rightAfter = possibleAfter;
        break;
      }
    }
    if (!rightStart || !rightAfter) throw new Error("expected two fresh seeds to produce different encounters");
    const rightInitial = observeExpedition(rightStart);
    expect(rightStart.seed).not.toBe(leftStart.seed);
    expect(rightInitial.v).toBe(leftInitial.v);
    expect(rightInitial.cycle).toBe(leftInitial.cycle);
    expect(rightInitial.run).toBe(leftInitial.run);
    expect(rightInitial.status).toBe(leftInitial.status);
    expect(rightInitial.area).toEqual(leftInitial.area);
    expect(rightInitial.destinations).toEqual(leftInitial.destinations);
    expect(rightInitial.team).toEqual(leftInitial.team);
    expect(rightInitial.backpack).toEqual(leftInitial.backpack);
    expect(rightInitial.money).toBe(leftInitial.money);
    expect(rightInitial.remainingSteps).toBe(leftInitial.remainingSteps);
    expect(rightInitial.nextAction).toBe(leftInitial.nextAction);
    expect(rightInitial.encounter).toEqual(leftInitial.encounter);
    expect(rightInitial.shop).toEqual(leftInitial.shop);
    expect(rightInitial.lastTransition).toEqual(leftInitial.lastTransition);
    expect(rightInitial.result).toEqual(leftInitial.result);

    const rightPrefix = startExpeditionJournal(publicRules(rightStart), rightInitial);
    expect(canonicalJson(rightPrefix)).toBe(canonicalJson(leftPrefix));
    expect(canonicalJson(observeExpedition(rightAfter).encounter))
      .not.toBe(canonicalJson(observeExpedition(leftAfter).encounter));
    expect(allKeys(leftPrefix).has("seed")).toBe(false);
  });
});

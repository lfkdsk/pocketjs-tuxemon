import { describe, expect, test } from "bun:test";

import {
  MAX_EXPEDITION_TEAM,
  applyExpeditionAction,
  checkExpeditionConservation,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type Expedition,
  type ExpeditionAction,
  type ExpeditionObservation,
} from "../battle/expedition.ts";
import { validateTeam } from "../battle/arena-team.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const CORPUS_RUNS = 1_000;
const PERSISTENT_CHAINS = 100;
const PERSISTENT_RUNS_PER_CHAIN = 3;
const FUZZ_CASES = 1_000;
const CORPUS_RANDOM_SEED = 0x6a09_e667;
const FUZZ_RANDOM_SEED = 0xbb67_ae85;

interface CorpusSummary {
  digest: string;
  totalSteps: number;
  actions: Record<string, number>;
  endings: Record<string, number>;
  continuations: number;
  defeatedContinuations: number;
  maxRun: number;
}

function mulberry32(seed: number): () => number {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor + 0x6d2b_79f5) >>> 0;
    let value = cursor;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(values: readonly T[], random: () => number): T {
  if (values.length === 0) throw new Error("random test attempted to pick from an empty array");
  return values[Math.floor(random() * values.length)]!;
}

function expeditionSeed(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

function privateObservationKeys(value: unknown, path = "$", leaks: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      privateObservationKeys(value[index], `${path}[${index}]`, leaks);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const child = `${path}.${key}`;
      if (/seed|rng/i.test(key)) leaks.push(child);
      privateObservationKeys(entry, child, leaks);
    }
  }
  return leaks;
}

function assertState(expedition: Expedition, at: string): ExpeditionObservation {
  const conservation = checkExpeditionConservation(expedition);
  if (conservation.length > 0) {
    throw new Error(`${at}: conservation failed: ${conservation.join("; ")}`);
  }
  const validation = validateTeam(expedition.team, {
    minSize: 1,
    maxSize: MAX_EXPEDITION_TEAM,
    levelCap: expedition.rules.levelCap,
  });
  if (!validation.ok) throw new Error(`${at}: team failed validation: ${validation.errors.join("; ")}`);

  const observation = observeExpedition(expedition);
  const leaks = privateObservationKeys(observation);
  if (leaks.length > 0) throw new Error(`${at}: private observation keys leaked: ${leaks.join(", ")}`);
  if (canonicalJson(observation).includes(expedition.seed)) {
    throw new Error(`${at}: master seed leaked in observation values`);
  }
  if (expedition.encounter === null && observation.encounter !== null) {
    throw new Error(`${at}: observation predicted an encounter before explore resolved`);
  }
  return observation;
}

function applyLegal(expedition: Expedition, action: ExpeditionAction, at: string): Expedition {
  // The caller checked this boundary when it was created; observe once more
  // only where the pre-explore null disclosure is itself the invariant.
  const observation = observeExpedition(expedition);
  if (action.type === "explore" && observation.encounter !== null) {
    throw new Error(`${at}: explore was advertised after an encounter was already visible`);
  }
  const originalBytes = canonicalJson(expedition);
  const result = applyExpeditionAction(expedition, action);
  if (!result.ok) throw new Error(`${at}: advertised legal action was rejected as ${result.error}`);
  if (canonicalJson(expedition) !== originalBytes) throw new Error(`${at}: reducer mutated its input state`);
  assertState(result.expedition, `${at}:after`);
  return result.expedition;
}

function actionKey(action: ExpeditionAction): string {
  return action.type === "battle" ? `battle:${action.mode}` : action.type;
}

function chooseAction(
  actions: readonly ExpeditionAction[],
  random: () => number,
  localStep: number,
): ExpeditionAction {
  const automatic = actions.find((action) => action.type === "battle" && action.mode === "auto");
  const captures = actions.filter((action) => action.type === "catch");
  if (automatic && random() < 0.15) return automatic;
  if (captures.length > 0 && random() < 0.25) return pick(captures, random);

  // Keep most runs alive long enough to exercise the budget boundary while
  // retaining voluntary endings as part of the corpus.
  const withoutEnd = actions.filter((action) => action.type !== "end");
  if (withoutEnd.length > 0 && (localStep < 3 || random() >= 0.04)) {
    return pick(withoutEnd, random);
  }
  return pick(actions, random);
}

function runCorpus(): CorpusSummary {
  const random = mulberry32(CORPUS_RANDOM_SEED);
  const hasher = new Bun.CryptoHasher("sha256");
  const actions: Record<string, number> = {};
  const endings: Record<string, number> = {};
  let totalSteps = 0;
  let completedRuns = 0;
  let continuations = 0;
  let defeatedContinuations = 0;
  let maxRun = 1;

  const finish = (initial: Expedition, label: string): Expedition => {
    let expedition = initial;
    assertState(expedition, `${label}:initial`);

    // Every corpus member crosses the pre-explore disclosure boundary once;
    // the remaining choices are driven entirely by the fixed harness RNG.
    const first = legalExpeditionActions(expedition).find((action) => action.type === "explore");
    if (!first) throw new Error(`${label}: initial explore was not legal`);
    expedition = applyLegal(expedition, first, `${label}:step 0`);
    actions.explore = (actions.explore ?? 0) + 1;
    totalSteps++;

    let localStep = 1;
    while (!expedition.ended) {
      const legal = legalExpeditionActions(expedition);
      const action = chooseAction(legal, random, localStep);
      expedition = applyLegal(expedition, action, `${label}:step ${localStep}`);
      const key = actionKey(action);
      actions[key] = (actions[key] ?? 0) + 1;
      totalSteps++;
      localStep++;
    }
    const reason = expedition.endReason ?? "missing";
    endings[reason] = (endings[reason] ?? 0) + 1;
    const bytes = canonicalJson(expedition);
    hasher.update(`${bytes.length}:`);
    hasher.update(bytes);
    completedRuns++;
    maxRun = Math.max(maxRun, expedition.run);
    return expedition;
  };

  const persistentRuns = PERSISTENT_CHAINS * PERSISTENT_RUNS_PER_CHAIN;
  for (let index = 0; index < CORPUS_RUNS - persistentRuns; index++) {
    finish(createExpedition({
      seed: expeditionSeed(index),
      rules: { cycle: "ranked", stepBudget: 6, levelCap: 20 },
    }), `ranked ${index}`);
  }

  let seedIndex = CORPUS_RUNS - persistentRuns;
  for (let chain = 0; chain < PERSISTENT_CHAINS; chain++) {
    let expedition = createExpedition({
      seed: expeditionSeed(seedIndex++),
      rules: {
        cycle: "persistent",
        stepBudget: 6,
        levelCap: 20,
        starter: { species: "rockitten", level: 1 },
      },
    });
    for (let cycle = 0; cycle < PERSISTENT_RUNS_PER_CHAIN; cycle++) {
      if (cycle > 0) {
        if (expedition.endReason === "defeated") defeatedContinuations++;
        expedition = createExpedition({
          seed: expeditionSeed(seedIndex++),
          rules: { cycle: "persistent", stepBudget: 6, levelCap: 20, continuation: expedition },
        });
        continuations++;
        assertState(expedition, `persistent ${chain}.${cycle}:continued`);
      }
      expedition = finish(expedition, `persistent ${chain}.${cycle}`);
    }
  }

  if (completedRuns !== CORPUS_RUNS || seedIndex !== CORPUS_RUNS) {
    throw new Error(`random corpus accounting mismatch: runs=${completedRuns}, seeds=${seedIndex}`);
  }
  hasher.update(canonicalJson({ totalSteps, actions, endings, continuations, defeatedContinuations, maxRun }));
  return {
    digest: hasher.digest("hex"),
    totalSteps,
    actions,
    endings,
    continuations,
    defeatedContinuations,
    maxRun,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function malformedAction(
  expedition: Expedition,
  index: number,
  random: () => number,
): unknown {
  const legal = legalExpeditionActions(expedition);
  const base = clone(pick(legal, random)) as ExpeditionAction & Record<string, unknown>;
  let value: unknown;
  switch (index % 10) {
    case 0: value = null; break;
    case 1: value = [base, index]; break;
    case 2: value = `action-${index}`; break;
    case 3: value = { type: "explore" }; break;
    case 4: value = { ...base, sequence: expedition.nextAction - 1 }; break;
    case 5: value = { ...base, sequence: expedition.nextAction + 1 }; break;
    case 6: value = { ...base, unexpected: index }; break;
    case 7: value = {
      type: "battle",
      mode: "manual",
      action: { type: "move", slot: -1 - index },
      sequence: expedition.nextAction,
    }; break;
    case 8: value = {
      type: "shop",
      shop: "__missing__",
      item: "__missing__",
      quantity: Math.floor(random() * 7) - 3,
      sequence: expedition.nextAction,
    }; break;
    default: value = {
      type: `unknown-${Math.floor(random() * 16)}`,
      sequence: expedition.nextAction,
      nested: { values: [index, false, null] },
    };
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const legalBytes = new Set(legal.map((action) => canonicalJson(action)));
    if (legalBytes.has(canonicalJson(value))) value = { value, fuzz: index };
  }
  return value;
}

describe("expedition randomized state machine", () => {
  test("1,000 fixed-seed legal expeditions include persistent defeat recovery and preserve invariants", () => {
    const summary = runCorpus();
    expect((summary.endings.budget ?? 0) + (summary.endings.defeated ?? 0) +
      (summary.endings.voluntary ?? 0)).toBe(CORPUS_RUNS);
    expect(summary.actions.explore).toBeGreaterThanOrEqual(CORPUS_RUNS);
    expect(summary.actions["battle:manual"]).toBeGreaterThan(0);
    expect(summary.actions["battle:auto"]).toBeGreaterThan(0);
    expect(summary.actions.catch).toBeGreaterThan(0);
    expect(summary.continuations).toBe(200);
    expect(summary.defeatedContinuations).toBeGreaterThan(0);
    expect(summary.maxRun).toBe(PERSISTENT_RUNS_PER_CHAIN);
    expect(summary.digest).toBe("12bede256640357a1b37048c8b8347ec25764e78dd4b3767652062c76807f4ba");
  }, 30_000);

  test("1,000 malformed and illegal JSON-like actions never throw or mutate authoritative bytes", () => {
    const random = mulberry32(FUZZ_RANDOM_SEED);
    const world = createExpedition({
      seed: "f".repeat(64),
      rules: { cycle: "ranked", stepBudget: 20, levelCap: 20 },
    });
    const explore = legalExpeditionActions(world).find((action) => action.type === "explore");
    if (!explore) throw new Error("fuzz fixture has no explore action");
    const explored = applyExpeditionAction(world, explore);
    if (!explored.ok) throw new Error(`fuzz fixture explore failed as ${explored.error}`);
    const encounter = explored.expedition;
    assertState(world, "fuzz world fixture");
    assertState(encounter, "fuzz encounter fixture");

    for (let index = 0; index < FUZZ_CASES; index++) {
      const expedition = index % 2 === 0 ? world : encounter;
      const before = canonicalJson(expedition);
      const value = malformedAction(expedition, index, random);
      let result: ReturnType<typeof applyExpeditionAction>;
      try {
        result = applyExpeditionAction(expedition, value);
      } catch (error) {
        throw new Error(`fuzz case ${index} threw: ${String(error)}`);
      }
      if (result.ok) throw new Error(`fuzz case ${index} unexpectedly applied`);
      if (canonicalJson(expedition) !== before) throw new Error(`fuzz case ${index} mutated its input state`);
      if (canonicalJson(result.expedition) !== before) {
        throw new Error(`fuzz case ${index} returned changed authoritative bytes`);
      }
    }
    expect(FUZZ_CASES).toBe(1_000);
  });
});

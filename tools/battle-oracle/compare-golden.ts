/** Compare a gzip NDJSON golden produced by generate_spyder.py. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { runPolicyBattle } from "../../battle/index.ts";
import type {
  BattleEvent,
  BattleStart,
  TuxemonBattleDb,
  TuxemonBattleState,
} from "../../battle/index.ts";

export interface BattleGoldenHeader {
  version: 1;
  source: string;
  definitions: number;
  seedsPerDefinition: number;
  policies: string[];
  cases: number;
  exemptions: string[];
}

export interface BattleGoldenCase {
  id: string;
  definition: number;
  seed: number;
  policy: "first" | "cycle";
  start: BattleStart;
  expected: {
    rngDraws: number;
    outcome: string;
    trace: Array<Record<string, unknown>>;
    techniqueGold: number;
  };
}

/** JSON.stringify's view of a value inside an array: what it would drop
 *  from an object is written as null there. */
function omitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Whether `a` and `b` serialise to the same JSON once object keys are
 *  sorted, without building either string. The corpora compare half a
 *  million events per run; sorting and stringifying both sides of each one
 *  used to cost more than replaying the battles. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b || (omitted(a) && omitted(b))) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      const left = omitted(a[index]) ? null : a[index];
      const right = omitted(b[index]) ? null : b[index];
      if (!sameJson(left, right)) return false;
    }
    return true;
  }
  if (a !== null && typeof a === "object") {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    let keys = 0;
    for (const key of Object.keys(left)) {
      if (omitted(left[key])) continue;
      keys++;
      if (!Object.hasOwn(right, key) || !sameJson(left[key], right[key])) return false;
    }
    for (const key of Object.keys(right)) if (!omitted(right[key])) keys--;
    return keys === 0;
  }
  // Distinct primitives agree only where JSON maps both to null.
  const isNull = (value: unknown) => value === null || (typeof value === "number" && !Number.isFinite(value));
  return isNull(a) && isNull(b);
}

export function readBattleGolden(path: string): {
  header: BattleGoldenHeader;
  cases: BattleGoldenCase[];
} {
  const lines = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n");
  const header = JSON.parse(lines.shift()!) as BattleGoldenHeader;
  return { header, cases: lines.map((line) => JSON.parse(line) as BattleGoldenCase) };
}

function remapKeys<T>(
  values: Record<string, T>,
  labels: Record<string, string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).map(([uid, value]) => [labels[uid]!, value]),
  );
}

export function goldenTrace(state: TuxemonBattleState): Array<Record<string, unknown>> {
  const labels: Record<string, string> = {};
  state.parties[0].forEach((monster, index) => { labels[String(monster.uid)] = `p${index}`; });
  state.parties[1].forEach((monster, index) => { labels[String(monster.uid)] = `e${index}`; });
  const label = (uid: unknown): string => labels[String(uid)]!;

  return state.events.map((raw) => {
    const event = raw as BattleEvent & Record<string, unknown>;
    switch (event.type) {
      case "sendOut":
        return { ...event, monster: label(event.monster) };
      case "round":
        return { ...event, hit: remapKeys(event.hit as Record<string, number>, labels) };
      case "decision":
        return { ...event, user: label(event.user), target: label(event.target) };
      case "technique":
        return {
          ...event,
          user: label(event.user),
          target: label(event.target),
          hpBefore: remapKeys(event.hpBefore as Record<string, number>, labels),
          hp: remapKeys(event.hp as Record<string, number>, labels),
          statuses: remapKeys(event.statuses as Record<string, string | null>, labels),
        };
      case "status":
        return {
          ...event,
          target: label(event.target),
          hp: remapKeys(event.hp as Record<string, number>, labels),
        };
      case "faint":
        return { ...event, monster: label(event.monster) };
      case "end":
        return { ...event };
      default:
        throw new Error(`unmapped reducer event '${event.type}'`);
    }
  });
}

export function compareGoldenCase(
  db: TuxemonBattleDb,
  golden: BattleGoldenCase,
): string | null {
  // The GB2 trace generator deliberately did not execute RewardSystem. Run
  // this legacy corpus through the reducer's matching compatibility mode;
  // GB3's separate progression corpus covers the production reward path.
  const state = runPolicyBattle(
    { ...db, progression: undefined },
    golden.start,
    Math.max(100, golden.expected.trace.length * 2),
  );
  const actual = goldenTrace(state);
  const expected = golden.expected.trace;
  const count = Math.max(expected.length, actual.length);
  for (let index = 0; index < count; index++) {
    if (!sameJson(expected[index], actual[index])) {
      return `event ${index}\n  py: ${JSON.stringify(expected[index])}\n  ts: ${JSON.stringify(actual[index])}`;
    }
  }
  if (state.rngDraws !== golden.expected.rngDraws) {
    return `RNG draws ${state.rngDraws} != ${golden.expected.rngDraws}`;
  }
  if (state.outcome !== golden.expected.outcome) {
    return `outcome ${state.outcome} != ${golden.expected.outcome}`;
  }
  if (state.techniqueGold !== golden.expected.techniqueGold) {
    return `technique gold ${state.techniqueGold} != ${golden.expected.techniqueGold}`;
  }
  return null;
}

if (import.meta.main) {
  const goldenPath = process.argv[2];
  const dbPath = process.argv[3];
  if (!goldenPath || !dbPath) {
    throw new Error("usage: bun tools/battle-oracle/compare-golden.ts GOLDEN.json.gz DB.json");
  }
  const db = JSON.parse(readFileSync(dbPath, "utf8")) as TuxemonBattleDb;
  const golden = readBattleGolden(goldenPath);
  const from = Number(process.env.GB2_FROM ?? 0);
  const limit = Number(process.env.GB2_LIMIT ?? golden.cases.length);
  const selectedCases = golden.cases.slice(from, from + limit);
  let identical = 0;
  let different = 0;
  for (const testCase of selectedCases) {
    let difference: string | null;
    try {
      difference = compareGoldenCase(db, testCase);
    } catch (error) {
      difference = `reducer error: ${String(error)}`;
    }
    if (difference === null) {
      identical++;
    } else {
      different++;
      if (different <= 20) console.error(`DIFF ${testCase.id}: ${difference}`);
    }
  }
  console.log(JSON.stringify({
    cases: selectedCases.length,
    from,
    identical,
    different,
    metadata: golden.header,
  }));
  if (different > 0) process.exitCode = 1;
}

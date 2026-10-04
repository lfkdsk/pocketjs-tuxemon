import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import type { TuxemonBattleDb } from "../battle/index.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import {
  compareGoldenCase,
  readBattleGolden,
} from "../tools/battle-oracle/compare-golden.ts";

const ROOT = join(import.meta.dir, "..");

const GB1 = validateBattleDb(
  JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")),
);
const RUNTIME_DB = JSON.parse(
  readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8"),
) as BattleDb;
const ADAPTED = battleDbToTuxemonBattleDb(RUNTIME_DB);
const ORACLE = JSON.parse(
  readFileSync(join(ROOT, "tools/battle-oracle/tuxemon-battle.json"), "utf8"),
) as TuxemonBattleDb;
const GOLDEN = readBattleGolden(join(ROOT, "tests/goldens/gb2-spyder-traces.ndjson.gz"));

/** Projects an object down to the fields the reducer actually reads. */
function pick<T extends object>(value: T, fields: readonly (keyof T)[]): Partial<T> {
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as Partial<T>;
}

function sortedElementTypes(element: { types: Array<{ against: string; multiplier: number }> }) {
  return [...element.types].sort((a, b) => a.against.localeCompare(b.against));
}

/**
 * Oracle rule dumps carry a `name` field (Pydantic's rule-parser label,
 * e.g. "unnamed_rule") that `DbRule` doesn't declare and the reducer never
 * reads; strip it so effect/condition arrays compare on rule-used content.
 */
function normalizeRules(rules: Array<{ type: string; parameters: string[]; operator?: string }>) {
  return rules.map((rule) => ({
    type: rule.type,
    parameters: rule.parameters,
    ...(rule.operator === undefined ? {} : { operator: rule.operator }),
  }));
}

/** Oracle status-modifier dumps carry the same kind of parser-only noise. */
function normalizeStatusModifiers(modifiers: Array<{ attribute: string; values: string[]; multiplier: number }>) {
  return modifiers.map(({ attribute, values, multiplier }) => ({ attribute, values, multiplier }));
}

function normalizeEntity<T extends { effects: any; conditions: any; modifiers?: any }>(value: T): T {
  return {
    ...value,
    effects: normalizeRules(value.effects),
    conditions: normalizeRules(value.conditions),
    ...(value.modifiers === undefined ? {} : { modifiers: normalizeStatusModifiers(value.modifiers) }),
  };
}

/** Projects a moveset entry down to the fields both sources agree on. */
function moveKey(move: { technique: string; learning_method: string; level_learned: number }): string {
  return JSON.stringify({ technique: move.technique, learning_method: move.learning_method, level_learned: move.level_learned });
}

describe("GB1 battle-db, adapted, drives the GB2 reducer", () => {
  test("runtime projection preserves the canonical reducer database", () => {
    expect(ADAPTED).toEqual(battleDbToTuxemonBattleDb(GB1));
  });

  test("passes the full Spyder differential corpus (8,560 cases)", () => {
    const differences: string[] = [];
    for (const golden of GOLDEN.cases) {
      const difference = compareGoldenCase(ADAPTED, golden);
      if (difference !== null) differences.push(`${golden.id}: ${difference}`);
    }
    expect(differences).toEqual([]);
    // About 7 s alone; a busy shared host has stretched it past 30 s, so the
    // limit only guards against a hang, not against slow CPU time.
  }, 180_000);

  // GB1's `spyder` scope is a curated subset of the oracle's full upstream
  // export (which the Python exporter dumps unfiltered: 411 monsters vs
  // GB1's 214, 274 techniques vs GB1's 230). Elements, tastes, shapes and
  // statuses are complete tables in both, regardless of scope. This checks
  // that every field the reducer reads is equal between the two sources for
  // every slug GB1 actually ships — not just that the differential corpus
  // (which only exercises a fraction of the database) happens to agree.
  describe("field-level equivalence against the oracle export", () => {
    test("elements: complete table, every affinity multiplier equal", () => {
      expect(Object.keys(ADAPTED.element).sort()).toEqual(Object.keys(ORACLE.element).sort());
      for (const slug of Object.keys(ADAPTED.element)) {
        expect(sortedElementTypes(ADAPTED.element[slug]!)).toEqual(sortedElementTypes(ORACLE.element[slug]!));
      }
      expect(ADAPTED.element_order).toEqual(ORACLE.element_order);
    });

    test("shapes: complete table, stat attributes equal", () => {
      expect(Object.keys(ADAPTED.shape).sort()).toEqual(Object.keys(ORACLE.shape).sort());
      for (const slug of Object.keys(ADAPTED.shape)) {
        expect(ADAPTED.shape[slug]).toEqual(ORACLE.shape[slug]);
      }
    });

    test("tastes: complete table, the one rule-relevant modifier is equal", () => {
      expect(Object.keys(ADAPTED.taste).sort()).toEqual(Object.keys(ORACLE.taste).sort());
      for (const slug of Object.keys(ADAPTED.taste)) {
        // GB1 keeps only the first taste modifier; every taste in the pinned
        // source has exactly one, so this is not a data loss in practice.
        expect(ORACLE.taste[slug]!.modifiers).toHaveLength(1);
        expect(pick(ADAPTED.taste[slug]!.modifiers[0]!, ["values", "multiplier"]))
          .toEqual(pick(ORACLE.taste[slug]!.modifiers[0]!, ["values", "multiplier"]));
      }
    });

    test("statuses: complete table, every rule-used field is equal", () => {
      const fields = [
        "category", "effects", "conditions", "stat_modifiers",
        "on_positive_status", "on_negative_status", "on_tech_use",
        "duration", "max_stacks", "bond", "modifiers",
      ] as const;
      expect(Object.keys(ADAPTED.status).sort()).toEqual(Object.keys(ORACLE.status).sort());
      for (const slug of Object.keys(ADAPTED.status)) {
        expect(normalizeEntity(pick(ADAPTED.status[slug]!, fields) as any))
          .toEqual(normalizeEntity(pick(ORACLE.status[slug]!, fields) as any));
      }
    });

    test("monsters: shape/types equal; moveset is the reachable subset of the oracle's", () => {
      for (const slug of Object.keys(ADAPTED.monster)) {
        const adapted = ADAPTED.monster[slug]!;
        const oracle = ORACLE.monster[slug];
        expect(oracle, `oracle is missing monster ${slug}`).toBeDefined();
        expect(adapted.shape).toBe(oracle!.shape);
        expect(adapted.types).toEqual(oracle!.types);
        const oracleMoveset = new Set(oracle!.moveset.map(moveKey));
        for (const move of adapted.moveset) {
          expect(oracleMoveset.has(moveKey(move)), `moveset entry ${moveKey(move)} of ${slug} is not in the oracle`).toBe(true);
        }
      }
    });

    test("techniques common to both sources have identical rule-used fields", () => {
      const fields = [
        "sort", "range", "speed", "accuracy", "potency", "power",
        "healing_power", "recharge", "types", "target", "stat_modifiers",
        "effects", "conditions",
      ] as const;
      for (const slug of Object.keys(ADAPTED.technique)) {
        const oracle = ORACLE.technique[slug];
        expect(oracle, `oracle is missing technique ${slug}`).toBeDefined();
        expect(normalizeEntity(pick(ADAPTED.technique[slug]!, fields) as any))
          .toEqual(normalizeEntity(pick(oracle!, fields) as any));
      }
    });

    test("technique_speed matches for every technique GB1 ships", () => {
      for (const slug of Object.keys(ADAPTED.technique)) {
        expect(ADAPTED.technique_speed[slug]).toBe(ORACLE.technique_speed[slug]);
      }
    });
  });
});

// compareGoldenCase decides event equality with sameJson instead of
// sorting and stringifying both sides. sameJson must agree with that
// reference on every event shape the corpora contain and on the edge cases
// JSON flattens (key order, dropped undefined keys, -0, non-finite numbers),
// and must still notice any single changed, added or removed field.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readBattleGolden, sameJson } from "../tools/battle-oracle/compare-golden.ts";

const ROOT = join(import.meta.dir, "..");

/** The comparison compareGoldenCase used before sameJson. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        canonical((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}
const reference = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function agree(a: unknown, b: unknown): boolean {
  const expected = reference(a, b);
  expect([sameJson(a, b), sameJson(b, a)]).toEqual([expected, expected]);
  return expected;
}

/** The same value with every object's keys in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed((value as any)[key])]));
  }
  return value;
}

/** Every copy of `value` with one leaf changed, one key removed or one key added. */
function* mutations(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) {
    yield [...value, 0];
    if (value.length > 0) yield value.slice(1);
    for (let index = 0; index < value.length; index++) {
      for (const changed of mutations(value[index])) {
        const copy = [...value];
        copy[index] = changed;
        yield copy;
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    yield { ...record, extra: 1 };
    for (const key of Object.keys(record)) {
      const { [key]: _, ...rest } = record;
      yield rest;
      for (const changed of mutations(record[key])) yield { ...record, [key]: changed };
    }
    return;
  }
  if (typeof value === "number") yield value + 1;
  else if (typeof value === "string") yield `${value}?`;
  else if (typeof value === "boolean") yield !value;
  else yield 0;
}

describe("sameJson", () => {
  test("agrees with sorted-key JSON on the edge cases JSON flattens", () => {
    const cases: Array<[unknown, unknown]> = [
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      [{ a: 1, b: undefined }, { a: 1 }],
      [{ a: 1, f: () => 1 }, { a: 1 }],
      [{ a: undefined }, { b: undefined }],
      [[undefined], [null]],
      [[1, undefined], [1]],
      [0, -0],
      [{ hp: -0 }, { hp: 0 }],
      [NaN, null],
      [Infinity, null],
      [[NaN], [-Infinity]],
      [NaN, 0],
      [null, 0],
      [null, {}],
      [[], {}],
      ["1", 1],
      [true, 1],
      [undefined, null],
      [undefined, () => 1],
      [{ a: [1, 2] }, { a: [2, 1] }],
      [{ a: { b: { c: 1 } } }, { a: { b: { c: 1, d: null } } }],
      [{ a: null }, {}],
      [JSON.parse('{"__proto__": 1}'), {}],
    ];
    const verdicts = cases.map(([a, b]) => agree(a, b));
    expect(verdicts).toEqual([
      true, true, true, true, true, false, true, true, true, true, true, false,
      false, false, false, false, false, false, true, false, false, false, false,
    ]);
  });

  test("agrees with sorted-key JSON on corpus events and every single-field mutation", () => {
    const shapes = new Map<string, Record<string, unknown>>();
    for (const file of ["gb2-spyder-traces", "gb3-double-traces"]) {
      for (const entry of readBattleGolden(join(ROOT, `tests/goldens/${file}.ndjson.gz`)).cases) {
        for (const event of entry.expected.trace) {
          const shape = `${file}:${event.type}:${Object.keys(event).sort().join(",")}`;
          if (!shapes.has(shape)) shapes.set(shape, event);
        }
      }
    }
    expect(shapes.size).toBeGreaterThanOrEqual(7);
    let mutated = 0;
    for (const event of shapes.values()) {
      expect(agree(event, structuredClone(event))).toBe(true);
      expect(agree(event, reversed(event))).toBe(true);
      for (const changed of mutations(event)) {
        expect(agree(event, changed)).toBe(false);
        mutated++;
      }
    }
    expect(mutated).toBeGreaterThan(100);
  });
});

// Exact build-time projection of Tuxemon's RandomMonsterAction eligibility
// rules. Title Battle consumes the emitted slug lists at runtime, so the
// packaged game does not need the complete upstream database just to filter
// a random draw.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

type Raw = Record<string, unknown>;

interface RandomMonsterRow {
  slug: string;
  txmnId: number;
  randomly: boolean;
  evolutions: Array<{ monsterSlug: string; atLevel: number | null }>;
  history: Array<{ slug: string; evolvesFrom: string[] }>;
}

function record(value: unknown, at: string): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Raw;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${at} must be a non-empty string`);
  }
  return value;
}

function nullableLevel(value: unknown, at: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${at} must be null or a positive integer`);
  }
  return value;
}

function rows(value: unknown, at: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
  return value;
}

function stringList(value: unknown, at: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
  return value.map((entry, index) => string(entry, `${at}[${index}]`));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Load only the fields consulted by upstream RandomMonsterAction and
 * MonsterModel.can_evolve_at_level/is_underleveled_for_form. */
function loadRows(sourceRoot: string): Map<string, RandomMonsterRow> {
  const root = join(sourceRoot, "mods/tuxemon/db/monster");
  const result = new Map<string, RandomMonsterRow>();
  const files = readdirSync(root).filter((file) => file.endsWith(".yaml")).sort(compareStrings);
  for (const file of files) {
    const at = `db/monster/${file}`;
    const raw = record(Bun.YAML.parse(readFileSync(join(root, file), "utf8")), at);
    const slug = string(raw.slug, `${at}.slug`);
    if (basename(file, ".yaml") !== slug) throw new Error(`${at}.slug must match its filename`);
    if (result.has(slug)) throw new Error(`duplicate monster slug '${slug}'`);
    if (typeof raw.txmn_id !== "number" || !Number.isInteger(raw.txmn_id)) {
      throw new Error(`${at}.txmn_id must be an integer`);
    }
    if (raw.randomly !== undefined && typeof raw.randomly !== "boolean") {
      throw new Error(`${at}.randomly must be boolean when present`);
    }
    const evolutions = rows(raw.evolutions, `${at}.evolutions`).map((value, index) => {
      const row = record(value, `${at}.evolutions[${index}]`);
      return {
        monsterSlug: string(row.monster_slug, `${at}.evolutions[${index}].monster_slug`),
        atLevel: nullableLevel(row.at_level, `${at}.evolutions[${index}].at_level`),
      };
    });
    const history = rows(raw.history, `${at}.history`).map((value, index) => {
      const row = record(value, `${at}.history[${index}]`);
      return {
        slug: string(row.slug, `${at}.history[${index}].slug`),
        evolvesFrom: stringList(row.evolves_from, `${at}.history[${index}].evolves_from`),
      };
    });
    result.set(slug, {
      slug,
      txmnId: raw.txmn_id,
      randomly: raw.randomly !== false,
      evolutions,
      history,
    });
  }
  return result;
}

function candidatesAtLevel(monsters: ReadonlyMap<string, RandomMonsterRow>, level: number): string[] {
  const result: string[] = [];
  for (const monster of monsters.values()) {
    const evolvesAtOrBeforeLevel = monster.evolutions.some((evolution) =>
      evolution.atLevel !== null && evolution.atLevel <= level
    );
    const current = monster.history.find((entry) => entry.slug === monster.slug);
    const underleveledForForm = current?.evolvesFrom.some((parentSlug) => {
      const parent = monsters.get(parentSlug);
      // Upstream catches a missing parent and continues.
      return parent?.evolutions.some((evolution) =>
        evolution.monsterSlug === monster.slug
        && evolution.atLevel !== null
        && level < evolution.atLevel
      ) ?? false;
    }) ?? false;
    if (
      monster.txmnId > 0
      && monster.randomly
      && !evolvesAtOrBeforeLevel
      && !underleveledForForm
    ) result.push(monster.slug);
  }
  return result.sort(compareStrings);
}

/** Sorted eligible slugs by level, matching RandomMonsterAction's four
 * predicates while loading the upstream monster table only once. */
export function randomMonsterCandidatePools(
  sourceRoot: string,
  levels: readonly number[],
): Map<number, string[]> {
  if (levels.some((level) => !Number.isInteger(level) || level < 1)) {
    throw new Error("random monster levels must be positive integers");
  }
  const monsters = loadRows(sourceRoot);
  return new Map([...new Set(levels)].map((level) => [level, candidatesAtLevel(monsters, level)]));
}

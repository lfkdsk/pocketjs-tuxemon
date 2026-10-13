// Deterministic, build-time projection of Tuxemon's economy database for
// Arena expeditions. Only item goods are emitted; monster goods and visual
// shop metadata remain upstream concerns.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Raw = Record<string, unknown>;

export type ExpeditionShopConditionValue =
  | null
  | boolean
  | number
  | string
  | ExpeditionShopConditionValue[]
  | { [key: string]: ExpeditionShopConditionValue };

export interface ExpeditionShopVariableCondition {
  key: string;
  value: ExpeditionShopConditionValue;
  scope?: "player" | "world" | null;
  description?: string | null;
}

export interface ExpeditionShopItem {
  slug: string;
  /** Authored economy purchase price, not the intrinsic item DB cost. */
  price: number;
  /** Authored economy resale cost. */
  cost: number;
  /** Omitted for Tuxemon's default/unlimited inventory of -1. */
  stock?: number;
  variables?: ExpeditionShopVariableCondition[];
}

export interface ExpeditionShop {
  slug: string;
  items: ExpeditionShopItem[];
}

const ECONOMY_FIELDS = new Set(["background", "items", "monsters", "resale_multiplier", "slug"]);
const ITEM_FIELDS = new Set(["cost", "inventory", "price", "slug", "variables"]);
const VARIABLE_FIELDS = new Set(["description", "key", "scope", "value"]);

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function record(value: unknown, at: string): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Raw;
}

function exactFields(value: Raw, allowed: ReadonlySet<string>, required: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${at}.${key} is not a supported field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} is required`);
  }
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${at} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${at} must be a non-negative safe integer`);
  }
  return value;
}

function inventory(value: unknown, at: string): number | undefined {
  if (value === undefined || value === -1) return undefined;
  return nonNegativeInteger(value, at);
}

function jsonValue(value: unknown, at: string): ExpeditionShopConditionValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${at} must be JSON-compatible`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${at}[${index}]`));
  if (typeof value === "object") {
    const output: Record<string, ExpeditionShopConditionValue> = {};
    for (const key of Object.keys(value as Raw).sort(compareStrings)) {
      output[key] = jsonValue((value as Raw)[key], `${at}.${key}`);
    }
    return output;
  }
  throw new Error(`${at} must be JSON-compatible`);
}

function optionalNullableString(value: unknown, at: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, at);
}

function variableCondition(value: unknown, at: string): ExpeditionShopVariableCondition {
  const raw = record(value, at);
  exactFields(raw, VARIABLE_FIELDS, ["key", "value"], at);
  const output: ExpeditionShopVariableCondition = {
    key: nonEmptyString(raw.key, `${at}.key`),
    value: jsonValue(raw.value, `${at}.value`),
  };
  if (Object.hasOwn(raw, "scope")) {
    const scope = raw.scope;
    if (scope !== null && scope !== "player" && scope !== "world") {
      throw new Error(`${at}.scope must be 'player', 'world', or null`);
    }
    output.scope = scope;
  }
  if (Object.hasOwn(raw, "description")) {
    output.description = optionalNullableString(raw.description, `${at}.description`);
  }
  return output;
}

function conditionIdentity(condition: ExpeditionShopVariableCondition): string {
  return `${condition.scope ?? ""}\u0000${condition.key}`;
}

function compareConditions(a: ExpeditionShopVariableCondition, b: ExpeditionShopVariableCondition): number {
  return compareStrings(conditionIdentity(a), conditionIdentity(b))
    || compareStrings(JSON.stringify(a.value), JSON.stringify(b.value));
}

function item(value: unknown, at: string): ExpeditionShopItem {
  const raw = record(value, at);
  exactFields(raw, ITEM_FIELDS, ["slug", "price", "cost"], at);
  const output: ExpeditionShopItem = {
    slug: nonEmptyString(raw.slug, `${at}.slug`),
    price: nonNegativeInteger(raw.price, `${at}.price`),
    cost: nonNegativeInteger(raw.cost, `${at}.cost`),
  };
  const stock = inventory(raw.inventory, `${at}.inventory`);
  if (stock !== undefined) output.stock = stock;
  if (raw.variables !== undefined) {
    if (!Array.isArray(raw.variables)) throw new Error(`${at}.variables must be an array`);
    const variables = raw.variables
      .map((entry, index) => variableCondition(entry, `${at}.variables[${index}]`))
      .sort(compareConditions);
    const seen = new Set<string>();
    for (const condition of variables) {
      const identity = conditionIdentity(condition);
      if (seen.has(identity)) {
        throw new Error(`${at}.variables repeats condition '${condition.key}' for the same scope`);
      }
      seen.add(identity);
    }
    if (variables.length > 0) output.variables = variables;
  }
  return output;
}

function economy(value: unknown, at: string): ExpeditionShop {
  const raw = record(value, at);
  exactFields(raw, ECONOMY_FIELDS, ["slug", "background", "resale_multiplier", "items", "monsters"], at);
  nonEmptyString(raw.background, `${at}.background`);
  if (typeof raw.resale_multiplier !== "number" || !Number.isFinite(raw.resale_multiplier) || raw.resale_multiplier < 0) {
    throw new Error(`${at}.resale_multiplier must be a non-negative finite number`);
  }
  if (!Array.isArray(raw.items)) throw new Error(`${at}.items must be an array`);
  if (!Array.isArray(raw.monsters)) throw new Error(`${at}.monsters must be an array`);

  const items = raw.items.map((entry, index) => item(entry, `${at}.items[${index}]`));
  const seenItems = new Set<string>();
  for (const entry of items) {
    if (seenItems.has(entry.slug)) throw new Error(`${at}.items repeats item slug '${entry.slug}'`);
    seenItems.add(entry.slug);
  }
  items.sort((a, b) => compareStrings(a.slug, b.slug));
  return { slug: nonEmptyString(raw.slug, `${at}.slug`), items };
}

/**
 * Import every mods/tuxemon/db/economy/*.yaml document under sourceRoot into
 * a canonical item-shop catalog. The result contains only JSON-compatible
 * values and is independent of directory enumeration and authored row order.
 */
export function importExpeditionShops(sourceRoot: string): ExpeditionShop[] {
  const root = join(sourceRoot, "mods/tuxemon/db/economy");
  const files = readdirSync(root)
    .filter((file) => file.endsWith(".yaml"))
    .sort(compareStrings);
  if (files.length === 0) throw new Error("mods/tuxemon/db/economy contains no .yaml files");

  const shops: ExpeditionShop[] = [];
  const seenShops = new Set<string>();
  for (const file of files) {
    const source = `mods/tuxemon/db/economy/${file}`;
    const document = Bun.YAML.parse(readFileSync(join(root, file), "utf8")) as unknown;
    const rows = Array.isArray(document) ? document : [document];
    if (rows.length === 0) throw new Error(`${source} must contain at least one economy`);
    for (let index = 0; index < rows.length; index++) {
      const at = rows.length === 1 ? source : `${source}[${index}]`;
      const shop = economy(rows[index], at);
      if (seenShops.has(shop.slug)) throw new Error(`duplicate economy slug '${shop.slug}'`);
      seenShops.add(shop.slug);
      shops.push(shop);
    }
  }
  return shops.sort((a, b) => compareStrings(a.slug, b.slug));
}

/**
 * Pure server replacement for battle/battle-names.ts.
 *
 * The shared game module also follows the active scene language and lazy
 * zh_CN UI store. Arena reconstruction only needs explicit-language lookup,
 * so the server artifact aliases that module to this host-neutral subset.
 */

import enNamesJson from "../data/battle-names.json";

export type GameLang = "en_US" | "zh_CN";

export interface BattleNames {
  monsters: Record<string, string>;
  techniques: Record<string, string>;
  items: Record<string, string>;
  npcs: Record<string, string>;
  tastes?: Record<string, string>;
}

export type BattleNameKind = "monster" | "technique" | "item" | "npc" | "taste";

const EN_NAMES = enNamesJson as unknown as BattleNames;
const TABLE_KEY: Record<BattleNameKind, keyof BattleNames> = {
  monster: "monsters",
  technique: "techniques",
  item: "items",
  npc: "npcs",
  taste: "tastes",
};

const titleCase = (slug: string): string => slug
  .split("_")
  .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
  .join(" ");

export function battleDisplayNameFor(
  lang: GameLang,
  kind: BattleNameKind,
  slug: string,
  localized?: BattleNames,
): string {
  const names = lang === "zh_CN" ? localized : EN_NAMES;
  return names?.[TABLE_KEY[kind]]?.[slug] || titleCase(slug);
}

/** Server code has no mutable scene locale; the implicit form is English. */
export function battleDisplayName(kind: BattleNameKind, slug: string): string {
  return battleDisplayNameFor("en_US", kind, slug);
}

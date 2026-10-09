// Per-language text catalogs for the importer.
//
// en_US reads the upstream English catalog only (the historical behavior).
// zh_CN merges five sources, in priority order:
//   1. reviewed corrections to upstream zh_CN (l10n/zh_CN/overrides.po)
//   2. the upstream zh_CN community catalog (Weblate, ~37% of strings)
//   3. this project's machine-translated supplement (l10n/zh_CN/supplement.po)
//   4. the importer's own strings that have no .po entry
//   5. the en_US catalog as fallback (counted and reported)
//
// Upstream zh translations ship half-width punctuation; the merged catalog
// normalizes the punctuation that sits next to CJK text to full-width forms.
// Placeholders and template tokens (${{...}}, {...}) are never altered.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePo, TUXEMON_SRC } from "./source.ts";
import type { UiTextTable } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";

export type ImportLang = "en_US" | "zh_CN";

export const IMPORT_LANGS: readonly ImportLang[] = ["en_US", "zh_CN"];

const EN_PO = join(TUXEMON_SRC, "mods/tuxemon/l18n/en_US/LC_MESSAGES/base.po");
const ZH_UPSTREAM_PO = join(TUXEMON_SRC, "mods/tuxemon/l18n/zh_CN/LC_MESSAGES/base.po");
const ZH_SUPPLEMENT_PO = join(import.meta.dir, "../l10n/zh_CN/supplement.po");
const ZH_OVERRIDES_PO = join(import.meta.dir, "../l10n/zh_CN/overrides.po");
const ZH_UI_TEXT_JSON = join(import.meta.dir, "../l10n/zh_CN/ui-text.json");
const KIT_SCHEMA_JSON = new URL("../vendor/pocket-rpgkit/src/data/schema.json", import.meta.url);

const isCjk = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
};

/** Template tokens the engine substitutes at runtime: ${{...}} and {...}.
 *  Punctuation normalization must not touch their insides. */
const TOKEN_RE = /\$\{\{[^{}]*\}\}|\{[^{}]*\}/g;

/** Upstream zh entries whose token shape is corrupted relative to the engine
 *  contract (the engine substitutes ${{name}} / ${{currency}}, so the
 *  single-brace forms would render literally). Repaired verbatim. */
const ZH_TOKEN_REPAIRS: Record<string, ReadonlyArray<[string, string]>> = {
  spyder_papertown_grannypiper1: [["${name}", "${{name}}"]],
  spyder_cottonart_shopkeeper: [["${currency}", "${{currency}}"]],
};

const PAIR_OPEN: Record<string, string> = { "(": "（", "[": "［" };
const PAIR_CLOSE: Record<string, string> = { ")": "）", "]": "］" };
const FULLWIDTH: Record<string, string> = {
  ",": "，",
  ".": "。",
  "!": "！",
  "?": "？",
  ":": "：",
  ";": "；",
};

/** Normalize the punctuation of a zh translation to Chinese convention.
 *  ASCII punctuation becomes full-width only when it sits next to CJK text
 *  (so thousands separators, version numbers and code stay ASCII); paired
 *  quotes become “ ”; tokens are protected. */
export function normalizeZhPunctuation(input: string): string {
  // Split into text runs and protected tokens; normalize the text runs only.
  const parts: string[] = [];
  let last = 0;
  for (const match of input.matchAll(TOKEN_RE)) {
    parts.push(normalizeRun(input.slice(last, match.index)));
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  parts.push(normalizeRun(input.slice(last)));
  return parts.join("");
}

function normalizeRun(run: string): string {
  // -- is the upstream zh convention for an em dash.
  run = run.replace(/--/g, "——");
  const chars = [...run];
  const cjkNear = (i: number, delta: -1 | 1): boolean => {
    for (let j = i + delta; j >= 0 && j < chars.length; j += delta) {
      const ch = chars[j]!;
      if (ch === " " || ch === " ") continue;
      return isCjk(ch);
    }
    return false;
  };
  let quoteOpen = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '"') {
      if (cjkNear(i, -1) || cjkNear(i, 1)) {
        chars[i] = quoteOpen ? "“" : "”";
        quoteOpen = !quoteOpen;
      }
      continue;
    }
    if (ch === "'") {
      if (cjkNear(i, -1) && cjkNear(i, 1)) {
        chars[i] = "’";
      }
      continue;
    }
    if (PAIR_OPEN[ch] && cjkNear(i, 1)) {
      chars[i] = PAIR_OPEN[ch]!;
      continue;
    }
    if (PAIR_CLOSE[ch] && cjkNear(i, -1)) {
      chars[i] = PAIR_CLOSE[ch]!;
      continue;
    }
    const full = FULLWIDTH[ch];
    if (full && (cjkNear(i, -1) || cjkNear(i, 1))) {
      // Keep decimal points and thousands separators (digits on both sides).
      const betweenDigits = ch === "." || ch === ","
        ? /[0-9]/.test(chars[i - 1] ?? "") && /[0-9]/.test(chars[i + 1] ?? "")
        : false;
      if (!betweenDigits) chars[i] = full;
    }
  }
  return chars.join("");
}

/** Extra zh keys that exist in no .po catalog (the en build falls back to
 *  hardcoded English for them). */
export const ZH_BUILTIN_STRINGS: Readonly<Record<string, string>> = {
  name: "姓名",
  menu_rename: "选择一只精灵",
};

export interface TextCatalog {
  readonly lang: ImportLang;
  get(key: string): string | undefined;
  /** Look up a key WITHOUT recording it in the fallback/missing gap sets.
   *  For metadata lookups (e.g. map descriptions) that are not dialog text
   *  and must not pollute the l10n gap report. Returns the en_US fallback
   *  for a zh build, like get() does. */
  peek(key: string): string | undefined;
  /** Non-empty keys looked up in a zh build that fell back to en_US. */
  readonly fallbackKeys: Set<string>;
  /** Non-empty keys looked up but absent from every catalog. */
  readonly missingKeys: Set<string>;
}

class Catalog implements TextCatalog {
  readonly fallbackKeys = new Set<string>();
  readonly missingKeys = new Set<string>();
  constructor(
    readonly lang: ImportLang,
    private readonly resolved: ReadonlyMap<string, string>,
    private readonly en: ReadonlyMap<string, string> | undefined,
  ) {}
  get(key: string): string | undefined {
    if (key === "") return undefined;
    const hit = this.resolved.get(key);
    if (hit !== undefined) return hit;
    if (this.en) {
      const en = this.en.get(key);
      if (en !== undefined) {
        this.fallbackKeys.add(key);
        return en;
      }
    }
    this.missingKeys.add(key);
    return undefined;
  }
  peek(key: string): string | undefined {
    if (key === "") return undefined;
    const hit = this.resolved.get(key);
    if (hit !== undefined) return hit;
    if (this.en) return this.en.get(key);
    return undefined;
  }
}

let enCache: ReadonlyMap<string, string> | undefined;

export function enCatalog(): ReadonlyMap<string, string> {
  if (!enCache) enCache = parsePo(EN_PO);
  return enCache;
}

/** Build the merged zh catalog in the documented priority order. */
export function buildZhCatalog(): Map<string, string> {
  const merged = new Map<string, string>();
  if (existsSync(ZH_OVERRIDES_PO)) {
    for (const [key, value] of parsePo(ZH_OVERRIDES_PO)) {
      merged.set(key, normalizeZhPunctuation(value));
    }
  }
  const upstream = parsePo(ZH_UPSTREAM_PO);
  for (const [key, value] of upstream) {
    if (merged.has(key)) continue;
    const repairs = ZH_TOKEN_REPAIRS[key];
    let text = value;
    if (repairs) for (const [from, to] of repairs) text = text.split(from).join(to);
    merged.set(key, normalizeZhPunctuation(text));
  }
  if (existsSync(ZH_SUPPLEMENT_PO)) {
    for (const [key, value] of parsePo(ZH_SUPPLEMENT_PO)) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(ZH_BUILTIN_STRINGS)) {
    if (!merged.has(key)) merged.set(key, value);
  }
  return merged;
}

export function createTextCatalog(lang: ImportLang): TextCatalog {
  if (lang === "en_US") return new Catalog(lang, enCatalog(), undefined);
  return new Catalog(lang, buildZhCatalog(), enCatalog());
}

let zhUiTextCache: Readonly<UiTextTable> | undefined;

/**
 * Read the game's reviewable translation of every key in the pinned kit's
 * UiTextTable. The kit schema is the runtime source of truth for the key set:
 * an added, missing, or misspelled key makes the import fail instead of
 * silently falling back to English in the Chinese project.
 */
export function loadZhUiText(): Readonly<UiTextTable> {
  if (zhUiTextCache) return zhUiTextCache;
  const value = JSON.parse(readFileSync(ZH_UI_TEXT_JSON, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("l10n/zh_CN/ui-text.json must contain one object");
  }
  const table = value as Record<string, unknown>;
  const schema = JSON.parse(readFileSync(KIT_SCHEMA_JSON, "utf8")) as {
    properties?: { uiText?: { properties?: Record<string, { maxLength?: number }> } };
  };
  const properties = schema.properties?.uiText?.properties;
  if (!properties) throw new Error("pinned kit schema has no uiText key table");
  const wanted = Object.keys(properties).sort();
  const actual = Object.keys(table).sort();
  const missing = wanted.filter((key) => !(key in table));
  const unknown = actual.filter((key) => !(key in properties));
  if (missing.length || unknown.length) {
    throw new Error(
      `l10n/zh_CN/ui-text.json does not match the pinned UiTextTable` +
      `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
      `${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`,
    );
  }
  for (const key of wanted) {
    const text = table[key];
    const limit = properties[key]?.maxLength ?? 200;
    if (typeof text !== "string" || text.length === 0 || text.length > limit) {
      throw new Error(`l10n/zh_CN/ui-text.json: ${key} must be a non-empty string of at most ${limit} characters`);
    }
  }
  zhUiTextCache = Object.freeze(table) as unknown as Readonly<UiTextTable>;
  return zhUiTextCache;
}

/** Per-language variants of the importer's own hardcoded English strings
 *  (placeholder labels, pagination rows). Keys absent from every catalog. */
export interface ImportUiStrings {
  nextPage: string;
  paren: (text: string) => string;
  battleLabel: (name: string) => string;
  battlePlaceholderReason: string;
  battleNpcSkippedReason: string;
  shopLabel: (name: string) => string;
  shopStock: (items: string) => string;
  shopMore: (count: number) => string;
  shopEmpty: string;
  shopEconomyUnavailable: string;
  shopMenu: Readonly<Record<string, string>>;
  shopPlaceholderNote: string;
  itemRemoved: (slug: string, sprite: string) => string;
  radioTuning: string;
  radioBack: string;
  radioNext: string;
  chooseMonsterPrompt: string;
  dojoDevolvePrompt: string;
  dojoForgetPrompt: string;
  dojoLearnPrompt: string;
}

export const IMPORT_UI: Record<ImportLang, ImportUiStrings> = {
  en_US: {
    nextPage: "Next >",
    paren: (text) => `(${text})`,
    battleLabel: (name) => `[BATTLE] ${name}`,
    battlePlaceholderReason: "P1 placeholder: the player wins",
    battleNpcSkippedReason: "NPC-versus-NPC battles are not supported yet; skipped",
    shopLabel: (name) => `[SHOP] ${name}`,
    shopStock: (items) => `Stock: ${items}`,
    shopMore: (count) => `, +${count} more`,
    shopEmpty: "Stock: none",
    shopEconomyUnavailable: "economy unavailable",
    shopMenu: {
      buy_item: "Buy items",
      sell_item: "Sell items",
      both_item: "Buy/sell items",
      buy_monster: "Buy monsters",
      sell_monster: "Sell monsters",
      both_monster: "Buy/sell monsters",
      train_monster: "Train monsters",
      heal_monster: "Heal monsters",
    },
    shopPlaceholderNote: "(P1 placeholder; trading is unavailable.)",
    itemRemoved: (slug, sprite) => `${slug} removed ${sprite}.`,
    radioTuning: "Tuning: {station}",
    radioBack: "Return",
    radioNext: "Continue",
    chooseMonsterPrompt: "Choose a monster",
    dojoDevolvePrompt: "Return to which form?",
    dojoForgetPrompt: "Forget which technique?",
    dojoLearnPrompt: "Learn which technique?",
  },
  zh_CN: {
    nextPage: "下一页 >",
    paren: (text) => `（${text}）`,
    battleLabel: (name) => `【战斗】${name}`,
    battlePlaceholderReason: "P1 占位：玩家获胜",
    battleNpcSkippedReason: "NPC 对战暂不支持，已跳过",
    shopLabel: (name) => `【商店】${name}`,
    shopStock: (items) => `商品：${items}`,
    shopMore: (count) => `，等 ${count} 种`,
    shopEmpty: "商品：无",
    shopEconomyUnavailable: "经济数据不可用",
    shopMenu: {
      buy_item: "购买道具",
      sell_item: "出售道具",
      both_item: "购买/出售道具",
      buy_monster: "购买精灵",
      sell_monster: "出售精灵",
      both_monster: "购买/出售精灵",
      train_monster: "训练精灵",
      heal_monster: "治疗精灵",
    },
    shopPlaceholderNote: "（P1 占位：暂不支持交易。）",
    itemRemoved: (slug, sprite) => `${slug} 移除了 ${sprite}。`,
    radioTuning: "正在调谐：{station}",
    radioBack: "返回",
    radioNext: "继续",
    chooseMonsterPrompt: "选择一只精灵",
    dojoDevolvePrompt: "要退回到哪种形态？",
    dojoForgetPrompt: "要遗忘哪个招式？",
    dojoLearnPrompt: "要学会哪个招式？",
  },
};

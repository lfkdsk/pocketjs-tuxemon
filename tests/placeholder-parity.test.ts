// Placeholder parity (B3): the importer's format() only fills a handful of
// templates (name, NAME, currency, map_name, the four directions) and prints
// text variables (${{var:name}}) through the kit's {v:id} token; every
// other ${{...}} template becomes "???" in BOTH language builds. That is a
// known importer limitation, not a zh_CN regression.
//
// This test compares the two generated projects per entry:
//   - per (map, event, page): dialog groups (consecutive text ops) keep the
//     same ordered placeholder counts in both languages. Chinese pagination
//     can split one logical dialog into more text ops, so the comparison is
//     over dialog groups, not raw command indices;
//   - per entry: the full JSON path of every placeholder-bearing string is
//     identical between the languages (a pagination guard proves no command
//     index shifted, so the path comparison is exact on the current data);
//   - the 30 occurrences split into 28 dynamic-template placeholders and
//     2 upstream literal anonymous-speaker markers ("???: ..." in
//     cotton_town), which Chinese punctuation normalization renders as
//     "？？？：...".
// It also asserts neither project contains broken template fragments (a half
// "${{", a bare "}}", a bare "${" — including one at the very end of a
// string — or a "{{" not preceded by "$").

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildZhCatalog, enCatalog } from "../importer/l10n.ts";

const ROOT = resolve(import.meta.dir, "..");

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function readProject(lang: "en" | "zh"): Json {
  const suffix = lang === "zh" ? ".zh_CN" : "";
  return JSON.parse(readFileSync(join(ROOT, `dist/project${suffix}.json`), "utf8")) as Json;
}

/** Total formatter/literal unknown-marker occurrences under a JSON value.
 * Chinese punctuation normalization correctly turns a literal speaker label
 * like "???: ..." into "？？？：..."; count that as the same marker so the
 * parity check does not mistake localization for a dropped template. */
function countPlaceholders(value: Json): number {
  if (typeof value === "string") return value.match(/\?\?\?|？？？/g)?.length ?? 0;
  if (Array.isArray(value)) {
    return (value as Json[]).reduce<number>((n, v) => n + countPlaceholders(v), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((n, v) => n + countPlaceholders(v), 0);
  }
  return 0;
}

/** Every string under a JSON value. */
function collectStrings(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/** A broken template fragment: an unreplaced ${{...}} start, a bare "}}",
 *  a bare "${" (not followed by "{", including one ending the string), or a
 *  "{{" not preceded by "$". */
function findFragment(s: string): string | null {
  if (s.includes("${{")) return "${{";
  if (s.includes("}}")) return "}}";
  // "$" before a {v:id} variable token is the currency sign.
  if (/\$\{(?!\{|v:)/.test(s)) return "${";
  if (/(^|[^$])\{\{/.test(s)) return "{{";
  return null;
}

/** A literal upstream anonymous-speaker marker: the line OPENS with "???:"
 *  (or the full-width Chinese form). Dynamic templates replaced mid-string
 *  never carry the colon, so this isolates the two cotton_town lines. */
function isLiteralSpeaker(s: string): boolean {
  return /^\s*[?？]{3}[:：]/.test(s);
}

type FlatItem =
  | { kind: "text"; path: string; lines: string[] }
  | { kind: "sep" };

/** Depth-first flatten of a page's command tree into the commands in
 *  execution order: text ops carry their lines, every other command is a
 *  separator that closes a dialog group. The command shape is
 *  language-independent (only the wrapped line contents differ), so en and
 *  zh flatten identically. */
function flattenCommands(commands: Json, prefix: (string | number)[], out: FlatItem[]): void {
  if (!Array.isArray(commands)) return;
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i] as Json;
    if (c !== null && typeof c === "object" && !Array.isArray(c)) {
      const op = (c as { op?: unknown }).op;
      if (op === "text") {
        const lines = (c as { lines?: Json }).lines;
        if (Array.isArray(lines)) {
          out.push({
            kind: "text",
            path: [...prefix, i, "lines"].join("."),
            lines: lines.filter((l): l is string => typeof l === "string"),
          });
        } else out.push({ kind: "sep" });
        continue;
      }
      out.push({ kind: "sep" });
      for (const [key, value] of Object.entries(c as { [key: string]: Json })) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
          flattenCommands(value, [...prefix, i, key], out);
        }
      }
    }
  }
}

/** Placeholder counts of consecutive text-op groups (one logical dialog
 *  each, possibly split across several text ops by pagination). */
function dialogGroupCounts(items: FlatItem[]): number[] {
  const groups: number[] = [];
  let open = false;
  for (const item of items) {
    if (item.kind === "sep") {
      open = false;
      continue;
    }
    if (!open) {
      groups.push(0);
      open = true;
    }
    groups[groups.length - 1]! += countPlaceholders(item.lines);
  }
  return groups;
}

interface PageRef {
  mapId: string;
  eventId: string;
  pageIndex: number;
  items: FlatItem[];
}

function pageRefs(project: Json): PageRef[] {
  const maps = (project as { maps: Json[] }).maps;
  const pages: PageRef[] = [];
  for (const map of maps) {
    const mapId = (map as { id?: string }).id ?? "?";
    for (const ev of (map as { events?: Json[] }).events ?? []) {
      const eventId = (ev as { id?: string }).id ?? "?";
      const evPages = (ev as { pages?: Json[] }).pages ?? [];
      for (let pi = 0; pi < evPages.length; pi++) {
        const commands = (evPages[pi] as { commands?: Json }).commands;
        const items: FlatItem[] = [];
        flattenCommands(commands ?? [], ["commands"], items);
        if (items.some((it) => it.kind === "text")) {
          pages.push({ mapId, eventId, pageIndex: pi, items });
        }
      }
    }
  }
  return pages;
}

describe("??? placeholder parity between en_US and zh_CN projects", () => {
  const en = readProject("en");
  const zh = readProject("zh");

  test("total placeholder counts match", () => {
    expect(countPlaceholders(zh)).toBe(countPlaceholders(en));
    expect(countPlaceholders(en)).toBeGreaterThan(0);
  });

  test("a localized literal unknown-speaker marker stays parity-neutral", () => {
    expect(countPlaceholders("???: What do you want?")).toBe(1);
    expect(countPlaceholders("？？？：你想干什么？")).toBe(1);
  });

  test("the 30 occurrences split into 28 dynamic templates and 2 literal speakers", () => {
    const strings = collectStrings(en).filter((s) => countPlaceholders(s) > 0);
    const literal = strings.filter(isLiteralSpeaker);
    const dynamic = strings.filter((s) => !isLiteralSpeaker(s));
    expect(literal.length).toBe(2);
    expect(countPlaceholders(literal)).toBe(2);
    // Both literal markers are the anonymous doorman in cotton_town.
    expect(literal.every((s) => s.startsWith("???:"))).toBe(true);
    expect(dynamic.length).toBe(27);
    expect(countPlaceholders(dynamic)).toBe(28);
    expect(strings.length).toBe(29);
    expect(countPlaceholders(strings)).toBe(30);
    // The zh_CN build renders the same two lines as speaker labels; upstream
    // punctuation varies (half- or full-width), so only the label form is
    // asserted, not the exact glyphs.
    const zhStrings = collectStrings(zh).filter((s) => countPlaceholders(s) > 0);
    const zhLiteral = zhStrings.filter(isLiteralSpeaker);
    expect(zhLiteral.length).toBe(2);
    expect(zhLiteral.every((s) => isLiteralSpeaker(s))).toBe(true);
  });

  // The two literal anonymous-speaker markers are not generic "any ???:"
  // strings: they trace to two specific upstream dialog keys (Tuxemon
  // base.po msgids) at specific commands. This pins both the key and the
  // command location in BOTH projects, so a new literal speaker (or a moved
  // one) fails here instead of hiding in the count-based assertion above.
  const LITERAL_SOURCES = [
    { key: "hellothere", mapId: "cotton_town", eventId: "e005_teleport_to_omnichannel_hq_almos_r023", pageIndex: 0, commandIndex: 1 },
    { key: "mwah", mapId: "cotton_town", eventId: "npc_allie", pageIndex: 1, commandIndex: 1 },
  ] as const;

  for (const [lang, project, catalog] of [
    ["en_US", en, enCatalog()],
    ["zh_CN", zh, buildZhCatalog()],
  ] as const) {
    for (const src of LITERAL_SOURCES) {
      test(`the literal ??? speaker from ${src.key} is pinned in ${lang} at ${src.mapId}/${src.eventId}/p${src.pageIndex}/c${src.commandIndex}`, () => {
        const map = (project as { maps: { id: string }[] }).maps.find((m) => m.id === src.mapId);
        expect(map, `${lang} map ${src.mapId}`).toBeDefined();
        const ev = (map as { events?: { id: string }[] }).events?.find((e) => e.id === src.eventId);
        expect(ev, `${lang} event ${src.eventId}`).toBeDefined();
        const page = (ev as { pages?: { commands?: unknown[] }[] }).pages?.[src.pageIndex];
        expect(page, `${lang} page ${src.pageIndex}`).toBeDefined();
        const cmd = page!.commands?.[src.commandIndex] as { op?: string; lines?: string[] } | undefined;
        expect(cmd, `${lang} command ${src.commandIndex}`).toBeDefined();
        expect(cmd!.op).toBe("text");
        const lines = cmd!.lines ?? [];
        expect(lines.length).toBeGreaterThan(0);
        // The first line opens with the anonymous-speaker marker.
        expect(isLiteralSpeaker(lines[0]!)).toBe(true);
        // The content is exactly the catalog entry for this key: the
        // importer cuts a dialog into consecutive text boxes (paragraphs at
        // "\\n", 52-column wrap, <=4 lines per box), so the text commands
        // from this one onward, joined and whitespace-squashed, must equal
        // the whole catalog text squashed the same way.
        const catalogText = catalog.get(src.key);
        expect(catalogText, `${lang} catalog key ${src.key}`).toBeDefined();
        const squash = (s: string) => s.replace(/\s+/g, "");
        // The importer's formatter turns ${{name}} into the kit's {name} token.
        const full = squash(catalogText!.split("\\n").join("").replace(/\$\{\{name\}\}/g, "{name}"));
        let dialog = "";
        for (let i = src.commandIndex; i < page!.commands!.length && dialog.length < full.length; i++) {
          const next = page!.commands![i] as { op?: string; lines?: string[] };
          if (next.op !== "text") break;
          dialog += squash((next.lines ?? []).join(""));
        }
        expect(dialog, `${lang} ${src.key}: imported dialog differs from the catalog entry`).toBe(full);
        // Squashing whitespace cannot see a dropped or moved space, so every
        // displayed line must also appear verbatim, in order, in the catalog
        // text (wrapping only ever breaks at the spaces it drops).
        const flat = catalogText!.split("\\n").join(" ").replace(/\$\{\{name\}\}/g, "{name}");
        let cursor = 0;
        for (let i = src.commandIndex, seen = 0; i < page!.commands!.length && seen < full.length; i++) {
          const next = page!.commands![i] as { op?: string; lines?: string[] };
          if (next.op !== "text") break;
          for (const line of next.lines ?? []) {
            const text = line.trim();
            const at = flat.indexOf(text, cursor);
            expect(at, `${lang} ${src.key}: line "${text}" is not verbatim catalog text`).toBeGreaterThanOrEqual(0);
            cursor = at + text.length;
            seen += squash(text).length;
          }
        }
      });
    }
  }

  test("per-dialog-group placeholder counts match one-to-one (pagination-robust)", () => {
    const enPages = pageRefs(en);
    const zhPages = pageRefs(zh);
    expect(zhPages.length).toBe(enPages.length);
    let compared = 0;
    for (let i = 0; i < enPages.length; i++) {
      const a = enPages[i]!;
      const b = zhPages[i]!;
      expect(`${b.mapId}/${b.eventId}/${b.pageIndex}`).toBe(`${a.mapId}/${a.eventId}/${a.pageIndex}`);
      // Pagination guard: if Chinese wrapping ever shifts a command index,
      // the text-op counts per page diverge and this fails first with a
      // precise location instead of a silent aggregate match.
      const textCount = (items: FlatItem[]) => items.filter((it) => it.kind === "text").length;
      expect(textCount(b.items)).toBe(textCount(a.items));
      expect(dialogGroupCounts(b.items)).toEqual(dialogGroupCounts(a.items));
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
  });

  test("every placeholder string sits at the same JSON path in both languages", () => {
    const pathCounts = (project: Json) => {
      const counts = new Map<string, number>();
      const walk = (value: Json, path: (string | number)[]): void => {
        if (typeof value === "string") {
          const n = countPlaceholders(value);
          if (n > 0) counts.set(path.join("."), n);
        } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
        else if (value !== null && typeof value === "object") {
          for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
        }
      };
      walk(project, []);
      return counts;
    };
    const enPaths = pathCounts(en);
    const zhPaths = pathCounts(zh);
    expect([...zhPaths.keys()].sort()).toEqual([...enPaths.keys()].sort());
    for (const [path, count] of enPaths) expect(zhPaths.get(path)).toBe(count);
    expect(enPaths.size).toBe(29);
  });

  test("neither project contains broken template fragments", () => {
    for (const [label, project] of [["en_US", en], ["zh_CN", zh]] as const) {
      const fragments = collectStrings(project)
        .map((s) => ({ s, frag: findFragment(s) }))
        .filter((x) => x.frag !== null);
      expect(fragments.map((x) => `${label}: ${x.frag} in ${x.s.slice(0, 60)}`)).toEqual([]);
    }
  });

  test("fragment detection catches a bare ${ at the end of a string", () => {
    expect(findFragment("the price is ${")).toBe("${");
    expect(findFragment("${")).toBe("${");
    expect(findFragment("costs ${} today")).toBe("${");
    expect(findFragment("costs ${{x}}")).toBe("${{");
    expect(findFragment("plain text")).toBeNull();
    expect(findFragment("use {name} here")).toBeNull();
  });
});

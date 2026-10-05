// Game-side resolver for the {x:<key>} text tokens the importer emits for
// Tuxemon's dialog templates (see importer/project.ts format()). The kit
// calls this once per token when a text or choices box opens; it must be a
// pure function of the view (no clock, no randomness, no mutation) so the
// expanded text survives saves, rewind and host-rate changes.
//
// Token semantics, matched to upstream Tuxemon (tuxemon/ui/text_formatter.py):
//   today           -> "{Month} {day}" in every language: the translated
//                      month name + ASCII space + day (tuxemon/time_handler.py
//                      today_string). The month names come from the generated
//                      data/month-names(.zh_CN).json table (the catalog's
//                      month_* keys), never a hardcoded layout. For zh_CN the
//                      catalog is the merged one (importer/l10n.ts
//                      buildZhCatalog: overrides -> upstream Weblate ->
//                      machine-translated supplement -> importer strings ->
//                      en_US fallback); the supplement supplies the twelve
//                      month names, so a zh_CN date renders e.g. "六月 15",
//                      the same merge order every other missing zh_CN string
//                      uses — not an en_US fallback. The format (month name
//                      + space + day) is still upstream's.
//                      From the deterministic in-session clock (ext.clock),
//                      never the host wall clock — upstream uses the wall
//                      clock, but the game's clock is sampled once at boot
//                      and then advanced only by world ticks, so it is the
//                      deterministic source.
//   map_desc        -> the current map's description. Upstream stores it as
//                      the <slug>_description translation; the kit project
//                      format has no description field, so the importer emits
//                      dist/map-descriptions(.zh_CN).json and the resolver
//                      looks the current map id up in it.
//   monster_0_name  -> the lead party monster's display name (nickname, else
//                      the localized species name), matching player.monsters[0].
//   monster_0_level -> the lead party monster's level as a plain integer.
//   money           -> "$" + the party's money right-aligned to width 4
//                      (e.g. "$ 100"), matching Tuxemon's CurrencyFormatter.
// An unanswered key (or a state that cannot supply one, e.g. an empty party)
// returns undefined and the kit shows "???".

import type { TextTokenResolver, TextTokenView } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { tuxemonExtensionState, type GameLang, type TuxemonExtensionState } from "./extension.ts";
import { snapshotFromClock } from "./time-weather.ts";
import { battleDisplayNameFor, type BattleNames } from "./battle-names.ts";

/** Static tables the resolver needs beyond the session view. */
export interface TuxemonTextTokenTables {
  /** Kit map id -> localized map description (dist/map-descriptions*.json). */
  mapDescriptions: Record<string, string>;
  /** The 12 translated month names (data/month-names*.json), index 0 = Jan. */
  monthNames: string[];
  /** Optional localized names for headless/lazy-loaded zh_CN sessions. */
  battleNames?: BattleNames;
}

/** Decode the session's extension state (the packed wire string the kit
 *  snapshots into view.ext). Returns null when the state is absent or cannot
 *  be decoded, so a resolver never throws into the dialog pipeline. */
function decodeExt(view: TextTokenView): TuxemonExtensionState | null {
  if (view.ext === undefined || view.ext === null) return null;
  if (typeof view.ext !== "string") return null;
  try {
    return tuxemonExtensionState(view.ext);
  } catch {
    return null;
  }
}

function todayToken(view: TextTokenView, tables: TuxemonTextTokenTables): string | undefined {
  const ext = decodeExt(view);
  if (!ext) return undefined;
  const { month, day } = snapshotFromClock(ext.clock);
  const name = tables.monthNames[month - 1];
  if (name === undefined) return undefined;
  return `${name} ${day}`;
}

function leadMonster(view: TextTokenView): { slug: string; nickname?: string; level: number } | undefined {
  const ext = decodeExt(view);
  const lead = ext?.party[0];
  if (!lead) return undefined;
  return { slug: lead.slug, nickname: lead.nickname, level: lead.level };
}

/** Tuxemon's CurrencyFormatter: "$" + amount right-aligned to width 4. */
function formatMoney(gold: number): string {
  return "$" + String(Math.trunc(gold)).padStart(4, " ");
}

/** Build the {x:} resolver for one content language. The EN bundle passes
 *  the EN map-descriptions table; the zh_CN bundle passes the zh_CN one. */
export function createTuxemonTextTokens(
  lang: GameLang,
  tables: TuxemonTextTokenTables,
): TextTokenResolver {
  return (key, view) => {
    switch (key) {
      case "today":
        return todayToken(view, tables);
      case "map_desc":
        return tables.mapDescriptions[view.mapId];
      case "monster_0_name": {
        const lead = leadMonster(view);
        if (!lead) return undefined;
        return lead.nickname ?? battleDisplayNameFor(lang, "monster", lead.slug, tables.battleNames);
      }
      case "monster_0_level": {
        const lead = leadMonster(view);
        return lead ? String(lead.level) : undefined;
      }
      case "money":
        return formatMoney(view.gold);
      default:
        return undefined;
    }
  };
}

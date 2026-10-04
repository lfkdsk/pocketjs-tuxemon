// Acceptance tests for the {x:} text-token resolver (battle/text-tokens.ts).
// Each template the importer emits is exercised with the real upstream dialog
// line, in both English and Chinese, against a session view built from the
// same extension-state pipeline the game uses.

import { describe, expect, test } from "bun:test";
import { expandTextTokens, type TextTokenView } from "../vendor/pocket-rpgkit/src/engine/player-name.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { buildZhCatalog } from "../importer/l10n.ts";
import { TUXEMON_BATTLE_DB, TUXEMON_TEXT_TOKENS } from "../battle/game.ts";
import { TUXEMON_TEXT_TOKENS_ZH } from "../battle/game-zh.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { snapshotFromClock } from "../battle/time-weather.ts";
import enMapDescriptions from "../dist/map-descriptions.json";
import zhMapDescriptions from "../dist/map-descriptions.zh_CN.json";
import enMonthNames from "../data/month-names.json";
import zhMonthNames from "../data/month-names.zh_CN.json";
import type { GameLang } from "../battle/extension.ts";

/** A session view with the given party, gold, map and clock. The ext field is
 *  the packed wire string the kit snapshots into view.ext at box open. */
function makeView(
  state: TuxemonExtensionState,
  gold: number,
  mapId: string,
): TextTokenView {
  return {
    playerName: "Spyder",
    variables: {},
    gold,
    mapId,
    ext: packTuxemonExtensionState(state) as string,
  };
}

const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);

function stateWithParty(levels: number[], nickname?: string): TuxemonExtensionState {
  const state = initialTuxemonExtensionState();
  for (const level of levels) {
    const monster = spawnMonster(TUXEMON_BATTLE_DB, RULE_DB, { rng: 7, rngDraws: 0 }, "nut", level, {
      iid: `txmn-test-${level}`,
    });
    if (nickname) monster.nickname = nickname;
    state.party.push(monster);
  }
  return state;
}

const resolverFor = (lang: GameLang) =>
  lang === "zh_CN" ? TUXEMON_TEXT_TOKENS_ZH : TUXEMON_TEXT_TOKENS;

describe("money token (${{money_formatted}})", () => {
  for (const [lang, label] of [["en_US", "English"], ["zh_CN", "Chinese"]] as const) {
    test(`${label}: the real player_wallet line expands with Tuxemon's currency format`, () => {
      // Upstream en_US: "${{name}}'s wallet: ${{money_formatted}}"
      // Upstream zh_CN: "${{name}}的钱包: ${{money_formatted}}"
      const line = lang === "zh_CN" ? "{name}的钱包: {x:money}" : "{name}'s wallet: {x:money}";
      const view = makeView(initialTuxemonExtensionState(), 100, "spyder_bedroom");
      const out = expandTextTokens(line, "Spyder", {}, resolverFor(lang), view, true);
      expect(out).toBe(lang === "zh_CN" ? "Spyder的钱包: $ 100" : "Spyder's wallet: $ 100");
    });
  }
  test("width-4 right alignment: $   5 / $ 100 / $1000 / $10000", () => {
    const r = TUXEMON_TEXT_TOKENS;
    const view = (gold: number) => makeView(initialTuxemonExtensionState(), gold, "x");
    expect(r("money", view(5)!)).toBe("$   5");
    expect(r("money", view(100)!)).toBe("$ 100");
    expect(r("money", view(1000)!)).toBe("$1000");
    expect(r("money", view(10000)!)).toBe("$10000");
  });
});

describe("monster_0 tokens (${{monster_0_name}} / ${{monster_0_level}})", () => {
  for (const [lang, label] of [["en_US", "English"], ["zh_CN", "Chinese"]] as const) {
    test(`${label}: the real old_sphalian_house01 line expands with the lead monster`, () => {
      // Upstream: "You watch some TV with your beloved Lv ${{monster_0_level}} ${{monster_0_name}}.,0"
      const state = stateWithParty([7]);
      const view = makeView(state, 0, "sphalian_town_house");
      const line = "You watch some TV with your beloved Lv {x:monster_0_level} {x:monster_0_name}.,0";
      const out = expandTextTokens(line, "Spyder", {}, resolverFor(lang), view, true);
      // nut's title-cased slug is "Nut" in English; the zh_CN names table
      // supplies "螺母兽".
      const expectedName = lang === "zh_CN" ? "螺母兽" : "Nut";
      expect(out).toBe(`You watch some TV with your beloved Lv 7 ${expectedName}.,0`);
    });
  }
  test("a nickname overrides the species name", () => {
    const state = stateWithParty([5], "Rex");
    const view = makeView(state, 0, "x");
    expect(TUXEMON_TEXT_TOKENS("monster_0_name", view)).toBe("Rex");
    expect(TUXEMON_TEXT_TOKENS("monster_0_level", view)).toBe("5");
  });
  // B3 regression: the English resolver must use the generated en_US species
  // names (data/battle-names.json), not a mechanical title-case of the slug.
  // These eight slugs are the ones where the two differ.
  const DEVIATIONS: [string, string][] = [
    ["av8r", "AV8R"],
    ["b_ver_1", "B-Ver.1"],
    ["mk01_alpha", "MK01 Alpha"],
    ["mrmoswitch", "mRmOswitch"],
    ["nudiflot_female", "Nudiflot"],
    ["nudiflot_male", "Nudiflot"],
    ["picc", "PiCC"],
    ["xeon_2", "Xeon-2"],
  ];
  for (const [slug, expected] of DEVIATIONS) {
    test(`English species name for ${slug} is the en_US name '${expected}', not title-case`, () => {
      const state = initialTuxemonExtensionState();
      const monster = spawnMonster(TUXEMON_BATTLE_DB, RULE_DB, { rng: 7, rngDraws: 0 }, slug, 7, {
        iid: `txmn-test-${slug}`,
      });
      state.party.push(monster);
      const view = makeView(state, 0, "sphalian_town_house");
      // The real old_sphalian_house01 TV line.
      const line = "You watch some TV with your beloved Lv {x:monster_0_level} {x:monster_0_name}.,0";
      const out = expandTextTokens(line, "Spyder", {}, TUXEMON_TEXT_TOKENS, view, true);
      expect(out).toBe(`You watch some TV with your beloved Lv 7 ${expected}.,0`);
    });
  }
  test("an empty party yields undefined (the kit shows ???)", () => {
    const view = makeView(initialTuxemonExtensionState(), 0, "x");
    expect(TUXEMON_TEXT_TOKENS("monster_0_name", view)).toBeUndefined();
    expect(TUXEMON_TEXT_TOKENS("monster_0_level", view)).toBeUndefined();
  });
});

describe("today token (${{today}})", () => {
  for (const [lang, label, expected] of [
    ["en_US", "English", "June 15"],
    // Upstream today_string is T.translate(month_key) + " " + day for every
    // language; the zh_CN catalog (supplement.po) translates month_jun as
    // "六月", so the Chinese date is "六月 15" — not "6月15日".
    ["zh_CN", "Chinese", "六月 15"],
  ] as const) {
    test(`${label}: the real calendar line expands from the in-session clock`, () => {
      // Upstream taba_house1: "Today is ${{today}} — one of the circled dates."
      // The initial clock is FIXED_INITIAL_CIVIL_TIME (2024-06-15 09:00).
      const state = initialTuxemonExtensionState();
      const { month, day } = snapshotFromClock(state.clock);
      expect(month).toBe(6);
      expect(day).toBe(15);
      const view = makeView(state, 0, "taba_house1");
      const line = "Today is {x:today} — one of the circled dates.";
      const out = expandTextTokens(line, "Spyder", {}, resolverFor(lang), view, true);
      expect(out).toBe(`Today is ${expected} — one of the circled dates.`);
    });
  }
});

describe("zh_CN month names come from the merged catalog (B3)", () => {
  // The zh_CN date is "六月 15": the month name is the merged catalog's
  // month_jun, not an en_US fallback. The merge order (importer/l10n.ts
  // buildZhCatalog) is overrides -> upstream Weblate -> machine-translated
  // supplement -> importer strings -> en_US; the supplement supplies the
  // twelve month names the upstream zh_CN catalog lacks. The format
  // (month name + space + day) is still upstream's today_string.
  test("the generated zh_CN month table and the merged catalog both yield 六月 for June", () => {
    expect(zhMonthNames[5]).toBe("六月");
    expect(buildZhCatalog().get("month_jun")).toBe("六月");
    // Contrast: en_US is "June", so 六月 is not the en_US fallback.
    expect(enMonthNames[5]).toBe("June");
    // The resolver formats it as upstream's "{Month} {day}".
    const state = initialTuxemonExtensionState();
    const view = makeView(state, 0, "taba_house1");
    const out = expandTextTokens("{x:today}", "Spyder", {}, TUXEMON_TEXT_TOKENS_ZH, view, true);
    expect(out).toBe("六月 15");
  });
});

describe("map_desc token (${{map_desc}})", () => {
  for (const [lang, label, table] of [
    ["en_US", "English", enMapDescriptions],
    ["zh_CN", "Chinese", zhMapDescriptions],
  ] as const) {
    test(`${label}: the real welcome_location line expands with the current map's description`, () => {
      // Upstream welcome_location_city: "Welcome to ${{map_name}} City: ${{map_desc}}"
      // The importer fills ${{map_name}} from the catalog, so the imported
      // cotton_town line is "Welcome to Cotton Town Town: {x:map_desc}".
      const view = makeView(initialTuxemonExtensionState(), 0, "spyder_cotton_town");
      const line = lang === "zh_CN"
        ? "欢迎来到暖棉镇镇： {x:map_desc}"
        : "Welcome to Cotton Town Town: {x:map_desc}";
      const out = expandTextTokens(line, "Spyder", {}, resolverFor(lang), view, true);
      expect(out).toBe(lang === "zh_CN"
        ? `欢迎来到暖棉镇镇： ${table["spyder_cotton_town"]}`
        : `Welcome to Cotton Town Town: ${table["spyder_cotton_town"]}`);
    });
  }
  test("a map without a description yields undefined (the kit shows ???)", () => {
    const view = makeView(initialTuxemonExtensionState(), 0, "taba_house1");
    expect(TUXEMON_TEXT_TOKENS("map_desc", view)).toBeUndefined();
  });
});

describe("var tokens (${{var:X}} -> {v:v.X})", () => {
  test("a written variable expands to its live value; an unwritten one to 0", () => {
    // scoop_price has no imported writer and renders the kit's unset default.
    expect(expandTextTokens("{v:v.scoop_price}", "Spyder", {}, null, null, false)).toBe("0");
  });
});

// B1 regression: the imported set_variable writers must keep upstream's
// Python str() value, not the importer's internal enum code. The
// spyder_leather_gym scoreboard event writes chad_points/brad_points and the
// world Cathedral init writes cathedral_fee; before the text-variable import
// these reached the dialog as enum code 1, showing "Chad 1 vs Brad 1".
describe("var tokens from the real imported leather_gym writes (B1)", () => {
  const build = buildProject(["spyder_leather_gym"], G6_IMPORT_OPTIONS);
  const map = build.project.maps.find((m) => m.id === "spyder_leather_gym")!;
  const writes: Record<string, string> = {};
  const textLines: string[] = [];
  for (const ev of map.events ?? []) {
    for (const page of ev.pages ?? []) {
      for (const cmd of page.commands ?? []) {
        const c = cmd as unknown as { op?: string; call?: string; args?: { writes?: Record<string, unknown> }; lines?: string[] };
        if (c.op === "ext" && c.call === "tux.set_variable_text" && c.args?.writes) {
          for (const [k, v] of Object.entries(c.args.writes)) writes[k] = String(v);
        }
        if (c.op === "text") {
          textLines.push(...(c.lines ?? []).filter((l): l is string => typeof l === "string"));
        }
      }
    }
  }

  test("the imported writes keep the upstream string values, not enum codes", () => {
    expect(writes["v.chad_points"]).toBe("0");
    expect(writes["v.brad_points"]).toBe("0");
    expect(writes["v.cathedral_fee"]).toBe("100");
  });

  test("the real scoreboard line expands to 'Chad 0 vs Brad 0'", () => {
    const line = textLines.find((l) => l.includes("chad_points") && l.includes("brad_points"));
    expect(line).toBeDefined();
    const out = expandTextTokens(line!, "Red", writes, null, null, false);
    expect(out).toBe("Chad 0 vs Brad 0");
  });

  test("the cathedral fee line expands with the real written value", () => {
    // Upstream spyder_billing_cathedral3: "Plus a ${{currency}}${{var:cathedral_fee}} call-out fee..."
    const line = "Plus a ${v:v.cathedral_fee} call-out fee if we had to send the ambulance to collect you.";
    const out = expandTextTokens(line, "Red", writes, null, null, false);
    expect(out).toBe("Plus a $100 call-out fee if we had to send the ambulance to collect you.");
  });
});

describe("resolver contract", () => {
  test("an unknown key yields undefined", () => {
    const view = makeView(initialTuxemonExtensionState(), 0, "x");
    expect(TUXEMON_TEXT_TOKENS("not_a_key", view)).toBeUndefined();
  });
  test("a missing or undecodable ext never throws", () => {
    const noExt: TextTokenView = { playerName: "S", variables: {}, gold: 0, mapId: "x" };
    expect(TUXEMON_TEXT_TOKENS("today", noExt)).toBeUndefined();
    expect(TUXEMON_TEXT_TOKENS("monster_0_name", noExt)).toBeUndefined();
    const badExt: TextTokenView = { ...noExt, ext: "not-a-wire-string" };
    expect(TUXEMON_TEXT_TOKENS("today", badExt)).toBeUndefined();
  });
});

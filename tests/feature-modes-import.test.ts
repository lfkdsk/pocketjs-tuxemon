import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadFeatureModes,
  loadOptions,
  loadStartMenu,
  loadTitleMinigame,
  parseNuPhoneMap,
  parseTitleBattle,
  type FeatureLocale,
} from "../importer/feature-modes.ts";
import { createTextCatalog, type TextCatalog } from "../importer/l10n.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { readYamlEvents, TUXEMON_SRC } from "../importer/source.ts";

function catalogs(): Record<FeatureLocale, TextCatalog> {
  return {
    en_US: createTextCatalog("en_US"),
    zh_CN: createTextCatalog("zh_CN"),
  };
}

describe("G12 out-of-map feature importer", () => {
  test("imports START and title copy from the real bilingual catalogs", () => {
    const menu = loadStartMenu();
    expect(menu.source).toBe("tuxemon/states/start.py");
    expect(menu.root).toMatchObject({
      party: { en_US: "Tuxemon", zh_CN: "精灵" },
      bag: { en_US: "Bag", zh_CN: "背包" },
      player: { en_US: "Player", zh_CN: "玩家" },
      save: { en_US: "Save", zh_CN: "保存" },
      load: { en_US: "Load", zh_CN: "加载" },
      exit: { en_US: "Exit", zh_CN: "退出" },
    });
    expect(menu.party).toMatchObject({
      techniques: { en_US: "Techniques", zh_CN: "技能" },
      unequip: { en_US: "Unequip", zh_CN: "卸下" },
      equip: { en_US: "Equip", zh_CN: "装备" },
      swapItem: { en_US: "Swap Item", zh_CN: "交换道具" },
      release: { en_US: "Release", zh_CN: "放生" },
      sortByHp: { en_US: "Sort by HP", zh_CN: "按HP排序" },
    });
    expect(menu.bag).toMatchObject({
      use: { en_US: "Use", zh_CN: "使用" },
      cannotUseHere: { en_US: "{name} cannot be used here!" },
    });
    expect(menu.title.newGame).toEqual({ en_US: "New Game", zh_CN: "新游戏" });
  });

  test("imports the complete Options copy from the real bilingual catalogs", () => {
    const options = loadOptions();
    expect(options.source).toBe("tuxemon/states/control_state.py");
    expect(options.controls).toEqual({
      up: { en_US: "Up Key", zh_CN: "上键" },
      left: { en_US: "Left Key", zh_CN: "左键" },
      right: { en_US: "Right Key", zh_CN: "右键" },
      down: { en_US: "Down Key", zh_CN: "下键" },
      primary: { en_US: "Action Key", zh_CN: "行动键" },
      secondary: { en_US: "Cancel Key", zh_CN: "取消键" },
      back: { en_US: "Back Key", zh_CN: "返回键" },
    });
    expect(options).toMatchObject({
      resetDefault: { en_US: "Reset Keys to Default", zh_CN: "恢复默认按键" },
      language: { en_US: "Language", zh_CN: "语言" },
      screenSize: { en_US: "Screen Size (EXPERIMENTAL)", zh_CN: "屏幕尺寸（实验）" },
      muteMusic: { en_US: "Mute Music", zh_CN: "音乐静音" },
      musicVolume: { en_US: "Music Volume", zh_CN: "音乐音量" },
      soundVolume: { en_US: "Sound Volume", zh_CN: "音效音量" },
      units: { en_US: "Unit", zh_CN: "单位" },
      metric: { en_US: "Metric", zh_CN: "公制" },
      hemisphere: { en_US: "Hemisphere", zh_CN: "半球" },
      northern: { en_US: "Northern", zh_CN: "北部" },
      capturePrompt: {
        en_US: "Press a key to set your new input key",
        zh_CN: "按下一个键来设置新的输入键",
      },
    });
  });

  test("imports the real NuPhone graph, menu items, bilingual labels, and art", () => {
    const imported = loadFeatureModes(TUXEMON_SRC);
    const map = imported.nuPhoneMap;

    expect(imported.format).toBe("pocket-tuxemon/feature-modes/v1");
    expect(map.source).toBe("mods/nu_phone_map.yaml");
    expect(map.points).toHaveLength(20);
    expect(map.points.filter((point) => point.core)).toHaveLength(14);
    expect(map.entry).toMatchObject({
      phoneItem: "nu_phone",
      appItem: "app_map",
      phoneLabel: { en_US: "Nu Phone", zh_CN: "Nu 手机" },
      appLabel: { en_US: "Map App", zh_CN: "手机地图" },
      noTrackers: { en_US: "GPS tracker not updating.", zh_CN: "GPS 追踪器未更新。" },
    });

    const leather = map.points.find((point) => point.key === "leather_town");
    expect(leather).toEqual({
      key: "leather_town",
      x: 155,
      y: 74,
      label: { en_US: "Leather Town", zh_CN: "皮革" },
      mapSlugs: [
        "spyder_leather_town",
        "spyder_leather_center",
        "spyder_leather_gym",
        "spyder_leather_house1",
        "spyder_leather_house2",
        "spyder_leather_museum",
        "spyder_leather_scoop",
        "spyder_leather_shaft1",
        "spyder_leather_shaft2",
      ],
      core: true,
      nav: { up: "route3", right: "citypark", down: "citypark", left: "routed" },
    });
    expect(map.mapToLocation.spyder_mansion_basement).toBe("mansion");
    expect(map.art).toMatchObject({
      map: { source: "gfx/ui/background/spyder_map.png", width: 112, height: 128 },
      cursor: { source: "gfx/ui/menu/map_cross.png", width: 12, height: 12 },
      player: { source: "gfx/ui/menu/map_player.png", width: 7, height: 7 },
      phoneIcon: { source: "gfx/items/nu_phone.png", width: 24, height: 24 },
      appIcon: { source: "gfx/items/app_map.png", width: 24, height: 24 },
    });
  });

  test("derives all five title-battle recipes from the real battle_menu script", () => {
    const battle = loadFeatureModes(TUXEMON_SRC).titleBattle;
    expect(battle.source).toBe("mods/tuxemon/maps/battle_menu.yaml");
    expect(battle.title).toEqual({ en_US: "Battle", zh_CN: "对战" });
    expect(battle.difficultyPrompt).toEqual({
      en_US: "Choose your difficulty level",
      zh_CN: "选择难度等级",
    });
    expect(battle.difficulties.map(({ id, level, partySize, candidates }) => ({
      id,
      level,
      partySize,
      candidates: candidates.length,
    }))).toEqual([
      { id: "beginner", level: 10, partySize: 1, candidates: 240 },
      { id: "easy", level: 15, partySize: 2, candidates: 243 },
      { id: "normal", level: 20, partySize: 3, candidates: 246 },
      { id: "hard", level: 25, partySize: 4, candidates: 247 },
      { id: "expert", level: 30, partySize: 5, candidates: 249 },
    ]);
    expect(battle.authored).toMatchObject({
      eventCount: 12,
      actionCount: 42,
      conditionCount: 29,
      actions: {
        create_npc: 1,
        quit_world: 3,
        random_monster: 30,
        set_environment: 1,
        set_variable: 5,
        start_battle: 1,
        update_time: 1,
      },
      conditions: {
        "is battle_outcome": 3,
        "is char_exists": 6,
        "is current_state": 4,
        "is party_size": 2,
        "is variable_set": 5,
        "not char_defeated": 2,
        "not char_exists": 1,
        "not environment_is": 1,
        "not variable_set": 5,
      },
    });
  });

  test("packages every real title-battle candidate plus its authored opponent and arena", () => {
    const feature = JSON.parse(readFileSync(join(import.meta.dir, "../data/feature-modes.json"), "utf8")) as
      ReturnType<typeof loadFeatureModes>;
    const battle = JSON.parse(readFileSync(join(import.meta.dir, "../data/battle-db.json"), "utf8")) as {
      monsters: Record<string, unknown>;
      npcs: Record<string, unknown>;
      environments: Record<string, unknown>;
    };
    const candidates = new Set(feature.titleBattle.difficulties.flatMap((difficulty) => difficulty.candidates));
    expect(candidates.size).toBe(332);
    expect([...candidates].filter((slug) => !(slug in battle.monsters))).toEqual([]);
    expect(feature.titleBattle.opponent in battle.npcs).toBeTrue();
    expect(feature.titleBattle.environment in battle.environments).toBeTrue();
  });

  test("imports the exact positive-id minigame cache with real bilingual PO text", () => {
    const minigame = loadTitleMinigame(TUXEMON_SRC);
    const monsterRoot = join(TUXEMON_SRC, "mods/tuxemon/db/monster");
    const upstream = readdirSync(monsterRoot)
      .filter((file) => /\.(?:yaml|json)$/.test(file))
      .flatMap((file) => {
        const value = Bun.YAML.parse(readFileSync(join(monsterRoot, file), "utf8")) as
          | { slug: string; txmn_id: number }
          | Array<{ slug: string; txmn_id: number }>;
        return Array.isArray(value) ? value : [value];
      });
    const eligible = upstream.filter((monster) => monster.txmn_id > 0).map((monster) => monster.slug).sort();
    const excluded = upstream.filter((monster) => monster.txmn_id === 0).map((monster) => monster.slug).sort();

    expect(upstream).toHaveLength(411);
    expect(eligible).toHaveLength(393);
    expect(excluded).toHaveLength(18);
    expect(minigame.monsters).toEqual(eligible);
    expect(minigame.monsters).toContain("dankush");
    expect(minigame.monsters).toContain("hotline");
    expect(minigame.monsters).not.toContain("mk01_gamma");
    expect(minigame).toMatchObject({
      source: "tuxemon/states/minigame.py",
      title: { en_US: "Minigame", zh_CN: "迷你游戏" },
      question: { en_US: "Name That Tuxemon", zh_CN: "猜猜这只精灵" },
      difficultyPrompt: { en_US: "Choose your difficulty level", zh_CN: "选择难度等级" },
      scoreLabel: { en_US: "Score", zh_CN: "得分" },
      streakLabel: { en_US: "Streak", zh_CN: "连击" },
      streakBonus: {
        en_US: "Streak Bonus! You're on fire!",
        zh_CN: "连击加成！你势不可挡！",
      },
      wrong: { en_US: "Wrong!", zh_CN: "猜错了！" },
      exit: { en_US: "Exit", zh_CN: "退出" },
      difficulties: [
        { id: "easy", choices: 3, points: 1, clue: "image", label: { en_US: "Easy", zh_CN: "简单" } },
        { id: "normal", choices: 5, points: 2, clue: "image", label: { en_US: "Normal", zh_CN: "普通" } },
        { id: "hard", choices: 5, points: 3, clue: "description", label: { en_US: "Hard", zh_CN: "困难" } },
      ],
    });

    const text = catalogs();
    for (const slug of minigame.monsters) {
      expect(text.en_US.get(slug)).not.toBeEmpty();
      expect(text.zh_CN.get(slug)).not.toBeEmpty();
      expect(text.en_US.get(`${slug}_description`)).not.toBeEmpty();
      expect(text.zh_CN.get(`${slug}_description`)).not.toBeEmpty();
    }
  });

  test("packages every minigame species as one existing lazy battle-art reference", () => {
    const feature = JSON.parse(readFileSync(join(import.meta.dir, "../data/feature-modes.json"), "utf8")) as
      ReturnType<typeof loadFeatureModes>;
    const battle = JSON.parse(readFileSync(join(import.meta.dir, "../data/battle-db.json"), "utf8")) as {
      monsters: Record<string, {
        txmnId: number;
        art: { sheet: { key: string } };
      }>;
    };
    const keys = feature.titleMinigame.monsters.map((slug) => {
      const monster = battle.monsters[slug];
      expect(monster, `missing packaged minigame monster ${slug}`).toBeDefined();
      expect(monster!.txmnId).toBeGreaterThan(0);
      expect(monster!.art.sheet.key).toStartWith("ui:tile.battle/gfx/sprites/battle/");
      return monster!.art.sheet.key;
    });
    expect(new Set(keys).size).toBe(feature.titleMinigame.monsters.length);
  });

  test("accounts for the complete validated battle_menu program as Native", () => {
    const battle = loadFeatureModes(TUXEMON_SRC).titleBattle;
    const coverage = buildProject(["spyder_bedroom"], G6_IMPORT_OPTIONS).report.coverage;
    const reason = "validated title Battle mode executes this out-of-map authored program";
    expect(coverage.externalMaterializations).toEqual([{
      source: "battle_menu.yaml",
      disposition: "native",
      events: 12,
      actions: 42,
      conditions: 29,
      reason,
    }]);

    for (const type of Object.keys(battle.authored.actions)) {
      const row = coverage.actions.rows.find((candidate) => candidate.type === type);
      expect(row, `missing action coverage row ${type}`).toBeDefined();
      expect(row!.reasons.native).toContain(reason);
    }
    for (const type of Object.keys(battle.authored.conditions)) {
      const row = coverage.conditions.rows.find((candidate) => candidate.type === type);
      expect(row, `missing condition coverage row ${type}`).toBeDefined();
      expect(row!.reasons.native).toContain(reason);
    }
  });

  test("rejects a real NuPhone document whose navigation is mutated to an unknown point", () => {
    const path = join(TUXEMON_SRC, "mods/nu_phone_map.yaml");
    const source = Bun.YAML.parse(readFileSync(path, "utf8")) as {
      nav: Record<string, Record<string, string | null>>;
    };
    source.nav.leather_town!.up = "missing_location";
    expect(() => parseNuPhoneMap(source, catalogs())).toThrow("references unknown 'missing_location'");
  });

  test("rejects coverage-signature drift when one real generated opponent is removed", () => {
    const path = join(TUXEMON_SRC, "mods/tuxemon/maps/battle_menu.yaml");
    const events = structuredClone(readYamlEvents(path, "loaded"));
    const expert = events.find((event) => event.name === "Difficulty expert")!;
    const index = expert.acts.findIndex((action) => action.raw === "random_monster 30,professor");
    expert.acts.splice(index, 1);
    expect(() => parseTitleBattle(events, catalogs(), TUXEMON_SRC)).toThrow("must generate equal non-empty parties");
  });
});

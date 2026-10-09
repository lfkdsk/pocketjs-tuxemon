import { describe, expect, test } from "bun:test";

import { TUXEMON_BATTLE_DB, TUXEMON_SESSION_OPTIONS, TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
import { TUXEMON_BATTLE_DB_ZH, TUXEMON_SESSION_OPTIONS_ZH } from "../battle/game-zh.ts";
import zhNamesJson from "../data/battle-names.zh_CN.json";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { calculateBaseStats } from "../battle/stats.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { buildProject, G6_IMPORT_OPTIONS, setImportLang } from "../importer/project.ts";
import { exportSaveCode, importSaveCode, restoreSave, takeSaveSnapshot } from "../ui/save-game.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { createSwitchState, type ChoiceModal } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

// The Spyder Dojo (mods/tuxemon/maps/spyder_dojo1.yaml): two students devolve
// (dojo_method <var>,monster), Xiang re-teaches (dojo_method <var>,technique)
// and Zhu changes a taste (change_taste <var>,<cold|warm>,random). Every case
// talks to the imported NPC and answers the imported dialogue.

const DB = TUXEMON_BATTLE_DB;
const RULES = battleDbToTuxemonBattleDb(DB);
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;
type Lang = "en_US" | "zh_CN";

const projects = new Map<Lang, Project>();
function dojoProject(lang: Lang): Project {
  const cached = projects.get(lang);
  if (cached) return structuredClone(cached);
  setImportLang(lang);
  try {
    projects.set(lang, buildProject(["spyder_dojo1"], G6_IMPORT_OPTIONS).project);
  } finally {
    setImportLang("en_US");
  }
  return structuredClone(projects.get(lang)!);
}

/** Enum code of `name:value`, as the importer writes it. */
function code(name: string, value: string): number {
  const values = TUXEMON_VARIABLE_ENUMS[name] as readonly string[] | undefined;
  const index = values?.indexOf(value) ?? -1;
  if (index < 0) throw new Error(`no enum code for ${name}:${value}`);
  return index + 1;
}

const NPC_TILES = {
  student1: { x: 1, y: 8 },
  student2: { x: 4, y: 6 },
  xiang: { x: 21, y: 3 },
  zhu: { x: 16, y: 3 },
} as const;

/** Answer for the next choice box: a key/label/index to pick, or cancel. */
type Answer = { key: string } | { label: string } | { index: number } | "cancel";

interface Choice {
  prompt: string;
  options: string[];
  keys?: string[];
  cancellable: boolean;
}

class Dojo {
  readonly session: Session;
  state: SessionState;
  readonly said: string[] = [];
  readonly choices: Choice[] = [];
  private previous = 0;

  constructor(
    readonly lang: Lang,
    npc: keyof typeof NPC_TILES,
    party: SpawnedMonsterSnapshot[],
    gold: number,
    variables: Record<string, number> = {},
    project = dojoProject(lang),
  ) {
    project.start = { map: project.maps[0]!.id, ...NPC_TILES[npc], dir: "up" } as Project["start"];
    this.session = createSession(project, 60, lang === "zh_CN" ? TUXEMON_SESSION_OPTIONS_ZH : TUXEMON_SESSION_OPTIONS);
    const ext = packTuxemonExtensionState({ ...initialTuxemonExtensionState(), party });
    this.state = startSession(project, this.session, createSwitchState({ variables }), ext);
    this.state.sw.gold = gold;
    this.idle(30);
  }

  tick(mask = 0): void {
    const edge = (bit: number) => Boolean((mask & bit) && !(this.previous & bit));
    const input: SessionInput = {
      buttons: mask,
      confirmEdge: edge(BTN_CONFIRM),
      cancelEdge: edge(BTN_CANCEL),
      upEdge: edge(BTN_BITS.UP),
      downEdge: edge(BTN_BITS.DOWN),
    };
    this.previous = mask;
    this.state = stepSession(this.session, this.state, input);
    expect(this.state.interp.error ?? null).toBeNull();
  }

  idle(frames: number): void {
    for (let frame = 0; frame < frames; frame++) this.tick();
  }

  /** Talk to the faced NPC, then read every box and answer every choice in
   *  order until the map has been quiet for a second. */
  talk(...answers: Answer[]): this {
    this.tick(BTN_CONFIRM);
    this.tick();
    let quiet = 0;
    for (let frame = 0; frame < 3000 && quiet < 60; frame++) {
      const modal = this.state.interp.modal;
      if (modal?.kind === "text") {
        quiet = 0;
        if (!modal.complete) { this.tick(); continue; }
        this.said.push(modal.lines.join(" "));
        this.tick(BTN_CONFIRM);
        this.tick();
        continue;
      }
      if (modal?.kind === "choices") {
        quiet = 0;
        this.answer(modal, answers.shift());
        continue;
      }
      quiet = this.state.scene ? 0 : quiet + 1;
      this.tick();
    }
    expect(answers).toEqual([]);
    return this;
  }

  private answer(modal: ChoiceModal, answer: Answer | undefined): void {
    this.choices.push({
      prompt: modal.prompt,
      options: [...modal.options],
      ...(modal.keys ? { keys: [...modal.keys] } : {}),
      cancellable: modal.cancellable,
    });
    if (answer === undefined) throw new Error(`unanswered choice: ${modal.prompt} ${modal.options.join(" / ")}`);
    if (answer === "cancel") {
      expect(modal.cancellable).toBeTrue();
      this.tick(BTN_CANCEL);
      this.tick();
      return;
    }
    const target = "index" in answer
      ? answer.index
      : "key" in answer
        ? (modal.keys ?? []).indexOf(answer.key)
        : modal.options.indexOf(answer.label);
    if (target < 0) throw new Error(`no option ${JSON.stringify(answer)} in ${modal.options.join(" / ")}`);
    for (let step = 0; step < 16 && (this.state.interp.modal as ChoiceModal).index !== target; step++) {
      this.tick(BTN_BITS.DOWN);
      this.tick();
    }
    expect((this.state.interp.modal as ChoiceModal).index).toBe(target);
    this.tick(BTN_CONFIRM);
    this.tick();
  }

  ext(): TuxemonExtensionState {
    return tuxemonExtensionState(this.state.ext, DB);
  }

  monster(iid: string): SpawnedMonsterSnapshot {
    const monster = this.ext().party.find((candidate) => candidate.iid === iid);
    if (!monster) throw new Error(`no party monster ${iid}`);
    return monster;
  }

  /** Save through the game's save code and load it into a fresh session. */
  reloaded(): TuxemonExtensionState {
    const snapshot = takeSaveSnapshot(this.session, this.state, 0);
    const code = exportSaveCode(this.session, snapshot);
    const project = dojoProject(this.lang);
    const fresh = createSession(project, 60, this.lang === "zh_CN" ? TUXEMON_SESSION_OPTIONS_ZH : TUXEMON_SESSION_OPTIONS);
    const restored = restoreSave(fresh, importSaveCode(fresh, code));
    return tuxemonExtensionState(restored.ext, DB);
  }
}

function monster(slug: string, level: number, iid: string, seed = 11): SpawnedMonsterSnapshot {
  return spawnMonster(DB, RULES, { rng: seed, rngDraws: 0 }, slug, level, { iid });
}

const YES = { index: 0 } as const;
const NO = { index: 1 } as const;

describe("Spyder Dojo taste change (change_taste) on the imported map", () => {
  const zhuMet = { "v.zhufirsttime": code("zhufirsttime", "yes") };

  test("a paid cold taste change rerolls once, recalculates stats, reports, and survives a save", () => {
    const lead = monster("aardart", 20, "zhu-lead");
    const dojo = new Dojo("en_US", "zhu", [lead], 1000, zhuMet).talk(YES, { key: "zhu-lead" }, { label: "Cold Taste" });
    const changed = dojo.monster("zhu-lead");
    expect(changed.tasteCold).not.toBe(lead.tasteCold);
    expect(changed.tasteWarm).toBe(lead.tasteWarm);
    expect(DB.tastes[changed.tasteCold]!.type).toBe("cold");
    expect(changed.base).toEqual(calculateBaseStats(
      RULES, changed.slug, changed.level, changed.individualValues, changed.tasteCold, changed.tasteWarm, changed.trainingPoints,
    ));
    expect(dojo.state.sw.gold).toBe(950);
    const name = (slug: string) => `${slug[0]!.toUpperCase()}${slug.slice(1)}`;
    const reports = dojo.said.filter((line) => line.includes("changed from"));
    expect(reports).toEqual([`Aardart's Cold Taste changed from ${name(lead.tasteCold)} to ${name(changed.tasteCold)}!`]);
    expect(dojo.choices.map((choice) => choice.options)).toEqual([["Yes", "No"], ["Aardart"], ["Cold Taste", "Warm Taste"]]);
    expect(dojo.reloaded().party[0]).toEqual(changed);
  });

  test("a warm taste change in Chinese names the monster and both tastes", () => {
    const lead = monster("aardart", 20, "zhu-zh", 5);
    const dojo = new Dojo("zh_CN", "zhu", [lead], 80, zhuMet).talk(YES, { key: "zhu-zh" }, { index: 1 });
    const changed = dojo.monster("zhu-zh");
    expect(changed.tasteWarm).not.toBe(lead.tasteWarm);
    expect(changed.tasteCold).toBe(lead.tasteCold);
    expect(changed.base).toEqual(calculateBaseStats(
      RULES, changed.slug, changed.level, changed.individualValues, changed.tasteCold, changed.tasteWarm, changed.trainingPoints,
    ));
    expect(dojo.state.sw.gold).toBe(30);
    const tastes = (zhNamesJson as { tastes: Record<string, string> }).tastes;
    expect(tastes[lead.tasteWarm]).toMatch(/^[^A-Za-z]+$/);
    const report = dojo.said.find((line) => line.includes("暖味"));
    expect(report).toBe(`${TUXEMON_BATTLE_DB_ZH.monsters.aardart!.name}的暖味从${tastes[lead.tasteWarm]}变成了${tastes[changed.tasteWarm]}！`);
    expect(report).not.toMatch(/[A-Za-z]/);
    expect(dojo.choices[1]).toMatchObject({
      prompt: "选择一只精灵",
      options: [TUXEMON_BATTLE_DB_ZH.monsters.aardart!.name],
      cancellable: false,
    });
  });

  test("no selectable monster stops before the taste menu and charge", () => {
    const dojo = new Dojo("en_US", "zhu", [], 100, zhuMet).talk(YES);
    expect(dojo.state.sw.gold).toBe(100);
    expect(dojo.choices.map((choice) => choice.options)).toEqual([["Yes", "No"]]);
    expect(dojo.said.some((line) => line.includes("changed from"))).toBeFalse();
    dojo.talk(NO);
    expect(dojo.choices.at(-1)!.options).toEqual(["Yes", "No"]);
  });

  test("declining or lacking the fee changes nothing and charges nothing", () => {
    const lead = monster("aardart", 20, "zhu-no");
    const declined = new Dojo("en_US", "zhu", [lead], 1000, zhuMet).talk(NO);
    expect(declined.state.sw.gold).toBe(1000);
    expect(declined.monster("zhu-no")).toEqual(lead);

    const poor = new Dojo("en_US", "zhu", [lead], 49, zhuMet).talk();
    expect(poor.state.sw.gold).toBe(49);
    expect(poor.monster("zhu-no")).toEqual(lead);
    expect(poor.said).toEqual(["I'm afraid you don't have enough funds to afford the Taste-Changer Potion."]);
  });
});

describe("Spyder Dojo technique re-learning (dojo_method technique) on the imported map", () => {
  const xiangMet = { "v.xiangfirsttime": code("xiangfirsttime", "yes") };

  test("forgetting one move and learning an earlier one charges once and survives a save", () => {
    const lead = monster("rockitten", 20, "xiang-lead");
    expect(lead.moves).toEqual(["boulder", "mudslide", "assault", "thunderball"]);
    const dojo = new Dojo("en_US", "xiang", [lead], 500, xiangMet)
      .talk(YES, { key: "xiang-lead" }, { key: "thunderball" }, { key: "ram" });
    const changed = dojo.monster("xiang-lead");
    expect(changed.moves).toEqual(["boulder", "mudslide", "assault", "ram"]);
    expect({ ...changed, moves: lead.moves }).toEqual(lead);
    expect(dojo.state.sw.gold).toBe(300);
    const [forget, learn] = dojo.choices.slice(2);
    expect(forget).toMatchObject({ prompt: "Forget which technique?", cancellable: true, keys: lead.moves });
    // Upstream offers every moveset row at or below the level that is not
    // known, including the fallback Struggle; the forgotten move is offered
    // back after it is removed.
    expect(learn).toMatchObject({ prompt: "Learn which technique?", cancellable: true, keys: ["struggle", "ram", "thunderball"] });
    expect(dojo.said).toContain("Rockitten learned technique Ram!");
    expect(dojo.said.at(-1)).toBe("The Re-Learner Potion has taken effect, your tuxemon's forgotten technique has been restored.");
    expect(dojo.reloaded().party[0]!.moves).toEqual(["boulder", "mudslide", "assault", "ram"]);
  });

  test("Chinese menus and report use translated technique names", () => {
    const lead = monster("rockitten", 20, "xiang-zh");
    const dojo = new Dojo("zh_CN", "xiang", [lead], 200, xiangMet)
      .talk(YES, { key: "xiang-zh" }, { key: "boulder" }, { key: "ram" });
    expect(dojo.monster("xiang-zh").moves).toEqual(["mudslide", "assault", "thunderball", "ram"]);
    expect(dojo.state.sw.gold).toBe(0);
    const [forget, learn] = dojo.choices.slice(2);
    expect(forget!.prompt).toBe("要遗忘哪个招式？");
    expect(learn!.prompt).toBe("要学会哪个招式？");
    for (const label of [...forget!.options, ...learn!.options]) expect(label).not.toMatch(/[A-Za-z]/);
    const report = dojo.said.find((line) => line.includes("学会了招式"));
    expect(report).toBeDefined();
    expect(report).not.toMatch(/[A-Za-z?]/);
  });

  test("cancelling either menu keeps the moves, charges nothing, and lets the player ask again", () => {
    const lead = monster("rockitten", 20, "xiang-cancel");
    const atForget = new Dojo("en_US", "xiang", [lead], 500, xiangMet).talk(YES, { key: "xiang-cancel" }, "cancel");
    expect(atForget.state.sw.gold).toBe(500);
    expect(atForget.monster("xiang-cancel")).toEqual(lead);
    expect(atForget.said.some((line) => line.includes("Re-Learner Potion has taken effect"))).toBeFalse();
    atForget.talk(NO);
    expect(atForget.choices.at(-1)!.options).toEqual(["Yes", "No"]);

    const atLearn = new Dojo("en_US", "xiang", [lead], 500, xiangMet)
      .talk(YES, { key: "xiang-cancel" }, { key: "assault" }, "cancel");
    expect(atLearn.state.sw.gold).toBe(500);
    expect(atLearn.monster("xiang-cancel")).toEqual(lead);
  });

  test("no selectable monster is not charged and gets no false success report", () => {
    const dojo = new Dojo("en_US", "xiang", [], 500, xiangMet).talk(YES);
    expect(dojo.state.sw.gold).toBe(500);
    expect(dojo.said.some((line) => /restored|side effect|learned technique/.test(line))).toBeFalse();
    dojo.talk(NO);
    expect(dojo.choices.at(-1)!.options).toEqual(["Yes", "No"]);
  });

  test("a monster with nothing to re-learn is not charged and gets no false report", () => {
    // Knows every moveset row at its level, including the fallback.
    const lead = { ...monster("rockitten", 1, "xiang-full"), moves: ["struggle", "ram", "boulder"] };
    const dojo = new Dojo("en_US", "xiang", [lead], 500, xiangMet).talk(YES, { key: "xiang-full" });
    expect(dojo.state.sw.gold).toBe(500);
    expect(dojo.monster("xiang-full")).toEqual(lead);
    expect(dojo.said.some((line) => /restored|side effect|learned technique/.test(line))).toBeFalse();
    expect(dojo.choices.map((choice) => choice.prompt)).not.toContain("Forget which technique?");
    dojo.talk(NO);
    expect(dojo.choices.at(-1)!.options).toEqual(["Yes", "No"]);
  });

  test("lacking the fee changes nothing and charges nothing", () => {
    const lead = monster("rockitten", 20, "xiang-poor");
    const dojo = new Dojo("en_US", "xiang", [lead], 199, xiangMet).talk();
    expect(dojo.said).toEqual(["Not enough to cover the cost of the Re-Learner Potion."]);
    expect(dojo.state.sw.gold).toBe(199);
    expect(dojo.monster("xiang-poor")).toEqual(lead);
  });
});

describe("Spyder Dojo devolution (dojo_method monster) on the imported map", () => {
  test("a stage1 monster returns to its basic form with its identity, and survives a save", () => {
    const spawned = monster("aardart", 20, "fu-lead");
    const trainingPoints = { ...spawned.trainingPoints!, armour: 17, hp: 43, melee: 29 };
    const trainedBase = calculateBaseStats(
      RULES,
      spawned.slug,
      spawned.level,
      spawned.individualValues,
      spawned.tasteCold,
      spawned.tasteWarm,
      trainingPoints,
    );
    const lead = {
      ...spawned,
      nickname: "Digger",
      trainingPoints,
      base: trainedBase,
      currentHp: trainedBase.hp - 11,
      status: "poison",
    };
    const other = monster("rockitten", 9, "fu-other");
    const dojo = new Dojo("en_US", "student2", [other, lead], 600).talk(YES, { key: "fu-lead" }, { key: "aardorn" });
    const devolved = dojo.monster("fu-lead");
    expect(devolved.slug).toBe("aardorn");
    expect(devolved.stage).toBe("basic");
    expect(devolved).toMatchObject({
      iid: "fu-lead",
      nickname: "Digger",
      level: 20,
      totalExperience: lead.totalExperience,
      tasteCold: lead.tasteCold,
      tasteWarm: lead.tasteWarm,
      individualValues: lead.individualValues,
      trainingPoints,
      status: "poison",
      moves: lead.moves,
    });
    expect(devolved.currentHp).toBe(Math.min(lead.currentHp!, devolved.base.hp));
    expect(dojo.ext().party[0]).toEqual(other);
    expect(dojo.ext().caught).toContain("aardorn");
    expect(dojo.state.sw.gold).toBe(100);
    expect(dojo.choices[1]).toMatchObject({ prompt: "Choose a monster", options: ["Digger"], cancellable: true });
    expect(dojo.choices[2]).toMatchObject({ prompt: "Return to which form?", options: ["Aardorn"], cancellable: true });
    expect(dojo.said.at(-1)).toBe("Digger devolves into Aardorn!");
    const reloaded = dojo.reloaded();
    expect(reloaded.party[1]).toEqual(devolved);
    expect(reloaded.party[1]).toMatchObject({ trainingPoints, status: "poison", currentHp: devolved.currentHp });
    expect(reloaded.caught).toContain("aardorn");
  });

  test("a stage2 monster returns to its stage1 form, reported in Chinese", () => {
    const species = Object.keys(DB.monsters).find((slug) => DB.monsters[slug]!.stage === "stage2"
      && DB.monsters[slug]!.evolvesFrom.some((parent) => DB.monsters[parent]?.stage === "stage1"))!;
    const parent = DB.monsters[species]!.evolvesFrom.find((slug) => DB.monsters[slug]?.stage === "stage1")!;
    const lead = monster(species, 40, "fu-zh");
    const dojo = new Dojo("zh_CN", "student1", [lead], 500).talk(YES, { key: "fu-zh" }, { key: parent });
    expect(dojo.monster("fu-zh").slug).toBe(parent);
    expect(dojo.state.sw.gold).toBe(0);
    const zh = TUXEMON_BATTLE_DB_ZH.monsters;
    expect(dojo.said.at(-1)).toBe(`${zh[species]!.name} 退化成了 ${zh[parent]!.name}！`);
    expect(dojo.said.at(-1)).not.toMatch(/[A-Za-z]/);
    expect(dojo.choices[1]).toMatchObject({
      prompt: "选择一只精灵",
      options: [zh[species]!.name],
      cancellable: true,
    });
    expect(dojo.choices[2]!.prompt).toBe("要退回到哪种形态？");
  });

  test("cancelling the form or monster menu refunds through the map's no-choice event", () => {
    const lead = monster("aardart", 20, "fu-cancel");
    const refund = "I'm ready to assist you, but please, choose the tuxemon that will undergo the reversal process.";
    for (const answers of [[YES, { key: "fu-cancel" }, "cancel"], [YES, "cancel"]] as Answer[][]) {
      const dojo = new Dojo("en_US", "student2", [lead], 600).talk(...answers);
      expect(dojo.state.sw.gold).toBe(600);
      expect(dojo.monster("fu-cancel")).toEqual(lead);
      expect(dojo.said.at(-1)).toBe(refund);
    }
  });

  test("a monster whose earlier form is not imported is refunded instead of charged", () => {
    const species = Object.keys(DB.monsters).find((slug) => DB.monsters[slug]!.stage === "stage1"
      && !DB.monsters[slug]!.evolvesFrom.some((parent) => DB.monsters[parent]?.stage === "basic"))!;
    const lead = monster(species, 30, "fu-orphan");
    const dojo = new Dojo("en_US", "student2", [lead], 500).talk(YES, { key: "fu-orphan" });
    expect(dojo.state.sw.gold).toBe(500);
    expect(dojo.monster("fu-orphan")).toEqual(lead);
  });

  test("lacking the fee changes nothing and charges nothing", () => {
    const lead = monster("aardart", 20, "fu-poor");
    const dojo = new Dojo("en_US", "student2", [lead], 499).talk();
    expect(dojo.state.sw.gold).toBe(499);
    expect(dojo.monster("fu-poor")).toEqual(lead);
    expect(dojo.said.at(-1)).toContain("Maybe another time, then?");
  });

  test("Student1's stage2 service also rejects an insufficient fee", () => {
    const species = Object.keys(DB.monsters).find((slug) => DB.monsters[slug]!.stage === "stage2"
      && DB.monsters[slug]!.evolvesFrom.some((parent) => DB.monsters[parent]?.stage === "stage1"))!;
    const lead = monster(species, 40, "fu-poor-stage2");
    const dojo = new Dojo("en_US", "student1", [lead], 499).talk();
    expect(dojo.state.sw.gold).toBe(499);
    expect(dojo.monster("fu-poor-stage2")).toEqual(lead);
    expect(dojo.said).toEqual([
      "You're interested in using the Button Potion on one of your tuxemon?",
      "That'll be $500, if you're willing to part with it.",
      "I see. Well, if you're not interested or can't afford it, I won't pressure you. The Button Potion is a rare and valuable item, after all.",
      "Maybe another time, then?",
    ]);
  });
});

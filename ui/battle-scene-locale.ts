// zh_CN labels for the battle scene's static chrome (menu titles, prompts,
// event narration). Monster names come from the battle state (the zh_CN
// database); technique and item names stay title-cased slugs, matching the
// English build's presentation. The kit's own battle UI strings are KUI1's
// scope and stay English.

import type { GameLang } from "../battle/extension.ts";

const titleCase = (slug: string): string => slug
  .split("_")
  .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
  .join(" ");

export interface BattleSceneLabels {
  chooseAction: string;
  monsterFallback: string;
  entersBattle: (name: string) => string;
  chose: (name: string, technique: string) => string;
  attackMissed: string;
  damage: (amount: number) => string;
  used: (name: string, technique: string) => string;
  grewLevels: (name: string, levels: number) => string;
  gainedXp: (name: string, xp: number) => string;
  fainted: (name: string) => string;
  status: (name: string, status: string) => string;
  itemUsed: (item: string, name: string) => string;
  shakes: (count: number) => string;
  captured: (name: string) => string;
  brokeFree: (name: string) => string;
  gotAway: string;
  couldntEscape: string;
  victory: string;
  /** The message band's confirm legend while a message is presented. */
  messageOk: string;
  partyDefeated: string;
  battleOver: string;
  battleEnded: string;
  whatWill: (name: string) => string;
  parkPrompt: string;
  chooseTechnique: string;
  chooseTuxemon: string;
  chooseCapture: string;
  chooseItem: string;
  swap: string;
  wait: (turns: number) => string;
  menuTitle: (mode: "root" | "technique" | "item" | "capture" | "swap") => string;
  /** Root command menu labels, keyed by the entry slug (fight/item/…). */
  rootCommand: (slug: string) => string;
  /** Spectator (NPC-versus-NPC) battle chrome. */
  spectatorWatching: string;
  spectatorFastForward: string;
  spectatorSkip: string;
  spectatorSpeed: (speed: number) => string;
  /** The banner's fighter/foe separator ("vs" / "对战"). */
  spectatorVs: string;
}

const EN: BattleSceneLabels = {
  chooseAction: "Choose an action",
  monsterFallback: "Tuxemon",
  entersBattle: (name) => `${name} enters the battle!`,
  chose: (name, technique) => `${name} chose ${technique}.`,
  attackMissed: "The attack missed!",
  damage: (amount) => `${Math.trunc(amount)} damage!`,
  used: (name, technique) => `${name} used ${technique}!`,
  grewLevels: (name, levels) => `${name} grew ${levels} level${levels === 1 ? "" : "s"}!`,
  gainedXp: (name, xp) => `${name} gained ${xp} XP!`,
  fainted: (name) => `${name} fainted!`,
  status: (name, status) => `${name}: ${status}.`,
  itemUsed: (item, name) => `${item} used on ${name}.`,
  shakes: (count) => `${count} shake${count === 1 ? "" : "s"}...`,
  captured: (name) => `${name} was captured!`,
  brokeFree: (name) => `${name} broke free!`,
  gotAway: "Got away safely!",
  couldntEscape: "Couldn't escape!",
  victory: "Victory!",
  messageOk: "OK",
  partyDefeated: "Your party was defeated.",
  battleOver: "The battle is over.",
  battleEnded: "The battle ended.",
  whatWill: (name) => `What will ${name} do?`,
  parkPrompt: "What will you do?",
  chooseTechnique: "Choose a technique",
  chooseTuxemon: "Choose a Tuxemon",
  chooseCapture: "Choose a capture device",
  chooseItem: "Choose an item",
  swap: "Swap",
  wait: (turns) => `wait ${turns}`,
  menuTitle: (mode) => mode === "technique" ? "Techniques"
    : mode === "item" ? "Items"
      : mode === "capture" ? "Capture"
        : mode === "swap" ? "Party" : "Commands",
  rootCommand: (slug) => {
    switch (slug) {
      case "fight": return "Fight";
      case "item": return "Item";
      case "forfeit": return "Forfeit";
      case "capture": return "Capture";
      case "park_ball": return "Ball";
      case "park_food": return "Food";
      case "park_doll": return "Doll";
      case "run": return "Run";
      default: return titleCase(slug);
    }
  },
  spectatorWatching: "Watching the battle…",
  spectatorFastForward: "A: Fast-forward",
  spectatorSkip: "B: Skip",
  spectatorSpeed: (speed) => `×${speed}`,
  spectatorVs: "vs",
};

const ZH: BattleSceneLabels = {
  chooseAction: "选择行动",
  monsterFallback: "精灵",
  entersBattle: (name) => `${name} 进入了战斗！`,
  chose: (name, technique) => `${name} 选择了 ${technique}。`,
  attackMissed: "攻击没有命中！",
  damage: (amount) => `${Math.trunc(amount)} 点伤害！`,
  used: (name, technique) => `${name} 使用了 ${technique}！`,
  grewLevels: (name, levels) => `${name} 升到了 ${levels} 级！`,
  gainedXp: (name, xp) => `${name} 获得了 ${xp} 点经验！`,
  fainted: (name) => `${name} 倒下了！`,
  status: (name, status) => `${name}：${status}。`,
  itemUsed: (item, name) => `对 ${name} 使用了 ${item}。`,
  shakes: (count) => `摇晃了 ${count} 次…`,
  captured: (name) => `${name} 被捕获了！`,
  brokeFree: (name) => `${name} 挣脱了！`,
  gotAway: "成功逃跑！",
  couldntEscape: "逃跑失败！",
  victory: "胜利！",
  messageOk: "确定",
  partyDefeated: "你的队伍被击败了。",
  battleOver: "战斗结束。",
  battleEnded: "战斗结束了。",
  whatWill: (name) => `${name} 要做什么？`,
  parkPrompt: "你要做什么？",
  chooseTechnique: "选择招式",
  chooseTuxemon: "选择一只精灵",
  chooseCapture: "选择捕获道具",
  chooseItem: "选择道具",
  swap: "替换",
  wait: (turns) => `等待 ${turns} 回合`,
  menuTitle: (mode) => mode === "technique" ? "招式"
    : mode === "item" ? "道具"
      : mode === "capture" ? "捕获"
        : mode === "swap" ? "队伍" : "指令",
  rootCommand: (slug) => {
    switch (slug) {
      case "fight": return "战斗";
      case "item": return "道具";
      case "forfeit": return "认输";
      case "capture": return "捕获";
      case "park_ball": return "公园球";
      case "park_food": return "食物";
      case "park_doll": return "玩偶";
      case "run": return "逃跑";
      default: return titleCase(slug);
    }
  },
  spectatorWatching: "观战中…",
  spectatorFastForward: "A：快进",
  spectatorSkip: "B：跳过",
  spectatorSpeed: (speed) => `×${speed}`,
  spectatorVs: "对战",
};

let active: BattleSceneLabels = EN;
let activeLang: GameLang = "en_US";

/** Set the battle scene language once at boot (main.tsx). */
export function setBattleSceneLang(lang: GameLang): void {
  activeLang = lang;
  active = lang === "zh_CN" ? ZH : EN;
}

export function battleSceneLang(): GameLang {
  return activeLang;
}

export function battleSceneLabels(): BattleSceneLabels {
  return active;
}

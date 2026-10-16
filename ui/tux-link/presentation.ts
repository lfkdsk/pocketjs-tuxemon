import type {
  TuxPublicObservation,
  TuxPublicPresentation,
} from "../../battle/tux-link-wire.ts";
import type { Lang } from "../language.ts";

export interface TuxLinkBattlerView {
  readonly key: string;
  readonly name: string;
  readonly level: number;
  readonly hpPercent: number;
  readonly status: string | null;
}

export interface TuxLinkBattleViewModel {
  readonly own: TuxLinkBattlerView[];
  readonly opponent: TuxLinkBattlerView[];
  readonly message: string | null;
}

function relative(value: "self" | "opponent", lang: Lang): string {
  if (lang === "zh_CN") return value === "self" ? "我方" : "对手";
  return value === "self" ? "You" : "Opponent";
}

export function tuxLinkPresentationMessage(
  events: TuxPublicPresentation,
  lang: Lang,
): string | null {
  const event = events[events.length - 1];
  if (!event) return null;
  if (event.kind === "action") {
    const actor = relative(event.actor, lang);
    const action = event.action;
    if (lang === "zh_CN") {
      if (action.type === "move") return `${actor}使用了 ${action.move ?? "招式"}`;
      if (action.type === "swap") return `${actor}更换了精灵`;
      if (action.type === "item") return `${actor}使用了道具`;
      return `${actor}尝试逃跑`;
    }
    if (action.type === "move") return `${actor} used ${action.move ?? "a move"}`;
    if (action.type === "swap") return `${actor} switched Tuxemon`;
    if (action.type === "item") return `${actor} used an item`;
    return `${actor} tried to run`;
  }
  if (event.kind === "hp") {
    return lang === "zh_CN"
      ? `生命值变为 ${Math.round(event.percent)}%`
      : `HP changed to ${Math.round(event.percent)}%`;
  }
  if (lang === "zh_CN") {
    return event.winner === "self" ? "胜利！" : event.winner === "opponent" ? "战败" : "平局";
  }
  return event.winner === "self" ? "Victory!" : event.winner === "opponent" ? "Defeat" : "Draw";
}

/** Observation is authoritative. Presentation contributes only the transient
 * message; entity identity and HP always come from the latest observation. */
export function tuxLinkBattleViewModel(
  observation: TuxPublicObservation,
  presentation: TuxPublicPresentation,
  lang: Lang,
): TuxLinkBattleViewModel {
  return {
    own: observation.own.party.filter((monster) => monster.active).map((monster) => ({
      key: `self:${monster.party}`,
      name: monster.species.displayName[lang as "en_US" | "zh_CN"] ?? monster.species.displayName.en_US,
      level: monster.level,
      hpPercent: monster.hp.percent,
      status: monster.status,
    })),
    opponent: observation.opponent.active.map((monster) => ({
      // Never use the species slug: two active monsters may be the same species.
      key: `opponent:${monster.publicId}`,
      name: monster.species.displayName[lang as "en_US" | "zh_CN"] ?? monster.species.displayName.en_US,
      level: monster.level,
      hpPercent: monster.hpPercent,
      status: monster.status,
    })),
    message: tuxLinkPresentationMessage(presentation, lang),
  };
}

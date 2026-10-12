// Runtime-only shape of the generated out-of-map feature document. Keep this
// separate from importer/feature-modes.ts: PocketJS intentionally follows
// type imports, and build-only upstream image paths must never be considered
// application texture literals.

export type FeatureLocale = "en_US" | "zh_CN";

export interface LocalizedFeatureText {
  en_US: string;
  zh_CN: string;
}

export interface FeatureImage {
  texture: string;
  width: number;
  height: number;
}

export type NuPhoneDirection = "up" | "right" | "down" | "left";

export interface NuPhoneMapPoint {
  key: string;
  x: number;
  y: number;
  label: LocalizedFeatureText;
  mapSlugs: string[];
  core: boolean;
  nav: Record<NuPhoneDirection, string | null>;
}

export interface NuPhoneMapData {
  source: "mods/nu_phone_map.yaml";
  nominalWidth: 256;
  nominalHeight: 144;
  entry: {
    phoneItem: "nu_phone";
    appItem: "app_map";
    phoneLabel: LocalizedFeatureText;
    appLabel: LocalizedFeatureText;
    noTrackers: LocalizedFeatureText;
  };
  art: {
    map: FeatureImage;
    cursor: FeatureImage;
    player: FeatureImage;
    phoneIcon: FeatureImage;
    appIcon: FeatureImage;
  };
  points: NuPhoneMapPoint[];
  mapToLocation: Record<string, string>;
}

export interface TitleBattleDifficulty {
  id: string;
  label: LocalizedFeatureText;
  level: number;
  partySize: number;
  /** Exact upstream RandomMonsterAction eligibility pool at this level. */
  candidates: string[];
}

export interface AuthoredScriptUsage {
  eventCount: number;
  actionCount: number;
  conditionCount: number;
  eventNames: string[];
  actions: Record<string, number>;
  conditions: Record<string, number>;
}

export interface TitleBattleData {
  source: "mods/tuxemon/maps/battle_menu.yaml";
  title: LocalizedFeatureText;
  difficultyPrompt: LocalizedFeatureText;
  player: "player";
  opponent: "professor";
  environment: "interior";
  difficulties: TitleBattleDifficulty[];
  authored: AuthoredScriptUsage;
}

export type TitleMinigameDifficultyId = "easy" | "normal" | "hard";

export interface TitleMinigameDifficulty {
  id: TitleMinigameDifficultyId;
  label: LocalizedFeatureText;
  choices: 3 | 5;
  points: 1 | 2 | 3;
  clue: "image" | "description";
}

/** Imported constants and text used by Tuxemon's title-screen guessing game.
 * Monster details and art deliberately stay in the existing lazy battle
 * repository; this small eager document carries only the exact eligible IDs. */
export interface TitleMinigameData {
  source: "tuxemon/states/minigame.py";
  title: LocalizedFeatureText;
  question: LocalizedFeatureText;
  difficultyPrompt: LocalizedFeatureText;
  scoreLabel: LocalizedFeatureText;
  streakLabel: LocalizedFeatureText;
  streakBonus: LocalizedFeatureText;
  wrong: LocalizedFeatureText;
  exit: LocalizedFeatureText;
  difficulties: TitleMinigameDifficulty[];
  /** MonsterModel cache parity: every upstream monster with txmn_id > 0. */
  monsters: string[];
  /** Content-derived FNV-1a seed; independent of campaign/save RNG state. */
  seed: number;
}

/** Imported START/title menu copy. Keeping these strings in the generated
 * feature document makes the UI consume the same .po catalogs as Tuxemon
 * instead of maintaining a second English/Chinese translation table. */
export interface StartMenuData {
  source: "tuxemon/states/start.py";
  root: {
    party: LocalizedFeatureText;
    bag: LocalizedFeatureText;
    player: LocalizedFeatureText;
    missions: LocalizedFeatureText;
    save: LocalizedFeatureText;
    load: LocalizedFeatureText;
    options: LocalizedFeatureText;
    tuxepedia: LocalizedFeatureText;
    exit: LocalizedFeatureText;
  };
  title: {
    newGame: LocalizedFeatureText;
    load: LocalizedFeatureText;
    autosave: LocalizedFeatureText;
    battle: LocalizedFeatureText;
    minigame: LocalizedFeatureText;
    options: LocalizedFeatureText;
    exit: LocalizedFeatureText;
  };
  party: {
    info: LocalizedFeatureText;
    techniques: LocalizedFeatureText;
    move: LocalizedFeatureText;
    sort: LocalizedFeatureText;
    release: LocalizedFeatureText;
    sortByLevel: LocalizedFeatureText;
    sortByHp: LocalizedFeatureText;
    sortByName: LocalizedFeatureText;
    sortById: LocalizedFeatureText;
    releaseConfirmation: LocalizedFeatureText;
    released: LocalizedFeatureText;
  };
  bag: {
    use: LocalizedFeatureText;
    cancel: LocalizedFeatureText;
    cannotUseHere: LocalizedFeatureText;
    noTarget: LocalizedFeatureText;
  };
  player: {
    wallet: LocalizedFeatureText;
    playtime: LocalizedFeatureText;
    battles: LocalizedFeatureText;
    seen: LocalizedFeatureText;
    caught: LocalizedFeatureText;
  };
  common: {
    yes: LocalizedFeatureText;
    no: LocalizedFeatureText;
    back: LocalizedFeatureText;
    empty: LocalizedFeatureText;
    hp: LocalizedFeatureText;
    armour: LocalizedFeatureText;
    dodge: LocalizedFeatureText;
    melee: LocalizedFeatureText;
    ranged: LocalizedFeatureText;
    speed: LocalizedFeatureText;
    height: LocalizedFeatureText;
    weight: LocalizedFeatureText;
    taste: LocalizedFeatureText;
    accuracy: LocalizedFeatureText;
    potency: LocalizedFeatureText;
    power: LocalizedFeatureText;
  };
}

export interface FeatureModesRuntimeData {
  format: "pocket-tuxemon/feature-modes/v1";
  nuPhoneMap: NuPhoneMapData;
  titleBattle: TitleBattleData;
  titleMinigame: TitleMinigameData;
  startMenu: StartMenuData;
}

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

export interface FeatureModesRuntimeData {
  format: "pocket-tuxemon/feature-modes/v1";
  nuPhoneMap: NuPhoneMapData;
  titleBattle: TitleBattleData;
}

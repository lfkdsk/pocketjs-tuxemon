// Non-English startup documents are raw pak/data.fs entries rather than
// imports. This keeps every translation out of the shared JS bundle and lets
// a boot decode only its selected locale. The PSP build swaps this module for
// tools/psp-stubs/zh-data.ts in its English-only package.
import type { GameLang } from "../battle/extension.ts";
import type { LocaleData, ZhData } from "./zh-data-types.ts";
import { decodeMapEntryBytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { startupProfileMark } from "../vendor/pocket-rpgkit/src/startup-profile.ts";

export type LocalizedLang = Exclude<GameLang, "en_US">;

export function localeDataEntries(lang: LocalizedLang) {
  const root = `l10n/${lang}`;
  return {
    project: `${root}/project-shell.json`,
    battleShell: `${root}/battle-runtime-shell.json`,
    names: `${root}/battle-names.json`,
    mapDescriptions: `${root}/map-descriptions.json`,
    monthNames: `${root}/month-names.json`,
    featureModes: `${root}/feature-modes-shell.json`,
    worldItems: `${root}/feature-world-items.json`,
  } as const;
}

const { worldItems: _zhWorldItems, ...zhStartupEntries } = localeDataEntries("zh_CN");
export const ZH_DATA_ENTRIES = zhStartupEntries;

export type ZhDataReader = (entry: string) => string | Uint8Array;

export interface LocaleDataStore {
  readonly available: boolean;
  load(lang: LocalizedLang, read: ZhDataReader): LocaleData | null;
  current(lang?: LocalizedLang): LocaleData | null;
}

export function createLocaleDataStore(): LocaleDataStore {
  const cached = new Map<LocalizedLang, LocaleData>();
  return {
    available: true,
    load(lang, read) {
      const existing = cached.get(lang);
      if (existing) return existing;
      const entries = localeDataEntries(lang);
      const parse = <T>(entry: string): T => {
        startupProfileMark(`startup-data:${entry}:read-start`);
        const input = read(entry);
        startupProfileMark(`startup-data:${entry}:read-end`);
        const value = JSON.parse(
          typeof input === "string" ? input : decodeMapEntryBytes(input),
        ) as T;
        startupProfileMark(`startup-data:${entry}:parse-end`);
        return value;
      };
      const data: LocaleData = {
        project: parse<LocaleData["project"]>(entries.project),
        battleShell: parse<LocaleData["battleShell"]>(entries.battleShell),
        names: parse<LocaleData["names"]>(entries.names),
        mapDescriptions: parse<LocaleData["mapDescriptions"]>(entries.mapDescriptions),
        monthNames: parse<LocaleData["monthNames"]>(entries.monthNames),
        featureModes: parse<LocaleData["featureModes"]>(entries.featureModes),
      };
      cached.set(lang, data);
      return data;
    },
    current: (lang) => lang === undefined
      ? cached.values().next().value ?? null
      : cached.get(lang) ?? null,
  };
}

export const localeData = createLocaleDataStore();

export interface ZhDataStore {
  readonly available: boolean;
  /** Decode all five documents on the first Chinese boot; later calls reuse them. */
  load(read: ZhDataReader): ZhData | null;
  /** The already-loaded Chinese data, or null before a Chinese boot. */
  current(): ZhData | null;
}

export function createZhDataStore(): ZhDataStore {
  const store = createLocaleDataStore();
  return {
    available: true,
    load: (read) => store.load("zh_CN", read),
    current: () => store.current("zh_CN"),
  };
}

export const zhData = createZhDataStore();

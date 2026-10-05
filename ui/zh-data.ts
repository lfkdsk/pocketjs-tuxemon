// The five zh_CN startup documents are raw pak/data.fs entries rather than
// imports. This keeps their JSON text out of the shared JS bundle and lets an
// English boot avoid decoding or parsing any Chinese content. The PSP build
// swaps this module for tools/psp-stubs/zh-data.ts and filters the same entry
// keys from its external pak.
import type { ZhData } from "./zh-data-types.ts";
import { decodeMapEntryBytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";

export const ZH_DATA_ENTRIES = {
  project: "l10n/zh_CN/project-shell.json",
  battleShell: "l10n/zh_CN/battle-runtime-shell.json",
  names: "l10n/zh_CN/battle-names.json",
  mapDescriptions: "l10n/zh_CN/map-descriptions.json",
  monthNames: "l10n/zh_CN/month-names.json",
} as const;

export type ZhDataReader = (entry: string) => string | Uint8Array;

export interface ZhDataStore {
  readonly available: boolean;
  /** Decode all five documents on the first Chinese boot; later calls reuse them. */
  load(read: ZhDataReader): ZhData | null;
  /** The already-loaded Chinese data, or null before a Chinese boot. */
  current(): ZhData | null;
}

export function createZhDataStore(): ZhDataStore {
  let cached: ZhData | null = null;
  return {
    available: true,
    load(read) {
      if (cached) return cached;
      const parse = <T>(entry: string): T => {
        const input = read(entry);
        return JSON.parse(typeof input === "string" ? input : decodeMapEntryBytes(input)) as T;
      };
      cached = {
        project: parse<ZhData["project"]>(ZH_DATA_ENTRIES.project),
        battleShell: parse<ZhData["battleShell"]>(ZH_DATA_ENTRIES.battleShell),
        names: parse<ZhData["names"]>(ZH_DATA_ENTRIES.names),
        mapDescriptions: parse<ZhData["mapDescriptions"]>(ZH_DATA_ENTRIES.mapDescriptions),
        monthNames: parse<ZhData["monthNames"]>(ZH_DATA_ENTRIES.monthNames),
      };
      return cached;
    },
    current: () => cached,
  };
}

export const zhData = createZhDataStore();

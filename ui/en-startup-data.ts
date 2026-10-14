// English startup shells are raw pak/data.fs entries rather than JavaScript
// object literals. Parsing them once is cheaper for QuickJS than compiling
// hundreds of kilobytes of generated object syntax on every cold launch.

import type { ProjectShell } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import { decodeMapEntryBytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";

export const EN_STARTUP_DATA_ENTRIES = {
  project: "l10n/en_US/project-shell.json",
  battleShell: "l10n/en_US/battle-runtime-shell.json",
} as const;

export interface EnStartupData {
  project: ProjectShell;
  battleShell: BattleRuntimeShell;
}

export type EnStartupDataReader = (entry: string) => string | Uint8Array;

export interface EnStartupDataStore {
  load(read: EnStartupDataReader): EnStartupData;
  current(): EnStartupData | null;
}

export function createEnStartupDataStore(): EnStartupDataStore {
  let cached: EnStartupData | null = null;
  return {
    load(read) {
      if (cached) return cached;
      const parse = <T>(entry: string): T => {
        const input = read(entry);
        return JSON.parse(typeof input === "string" ? input : decodeMapEntryBytes(input)) as T;
      };
      cached = {
        project: parse<ProjectShell>(EN_STARTUP_DATA_ENTRIES.project),
        battleShell: parse<BattleRuntimeShell>(EN_STARTUP_DATA_ENTRIES.battleShell),
      };
      return cached;
    },
    current: () => cached,
  };
}

export const enStartupData = createEnStartupDataStore();

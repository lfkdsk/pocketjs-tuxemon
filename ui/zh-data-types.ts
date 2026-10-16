// Type-only module for a non-English locale data bundle, so the PSP stub
// (tools/psp-stubs/zh-data.ts) can type-check standalone without importing
// the real JSON blobs.
import type { ProjectShell } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import type { BattleNames } from "../battle/battle-names.ts";
import type { FeatureModesShellData } from "./feature-modes-data.ts";

export interface LocaleData {
  project: ProjectShell;
  battleShell: BattleRuntimeShell;
  names: BattleNames;
  /** Kit map id -> localized map description, for the {x:map_desc} resolver. */
  mapDescriptions: Record<string, string>;
  /** The 12 translated month names, for the {x:today} resolver. */
  monthNames: string[];
  /** Localized labels for title, START, Options, NuPhone, and world menus. */
  featureModes: FeatureModesShellData;
}

/** Compatibility name retained for tests and PSP tooling. */
export type ZhData = LocaleData;

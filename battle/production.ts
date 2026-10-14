import variableEnumsJson from "../dist/variable-enums.json";

import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import { createTuxemonBattleDbProvider, type BattleEntrySource } from "./battle-repository.ts";
import {
  createTuxemonExtensions,
  type GameLang,
  type TuxemonExtensionRuntimeOptions,
} from "./extension.ts";
import { createTuxemonBattleRules, type VariableEnums } from "./runtime.ts";
import { createTuxemonScenes, runtimeJournalIndex } from "./scenes.ts";

// The importer splits the runtime projection into this compact shell plus one pak/data.fs entry per
// monster/technique/item/status. Building the provider here — instead of
// importing the full 801 KB battle-runtime-db.json as an object literal —
// keeps species/technique data out of the bundle and off the startup path;
// each battle then parses only the slugs it actually touches. The caller
// supplies the already parsed language shell from the raw startup entry.

export function createProductionTuxemonBattle(
  source: BattleEntrySource,
  runtimeShell: BattleRuntimeShell,
  extensionOptions: Readonly<TuxemonExtensionRuntimeOptions> = {},
  lang: GameLang = "en_US",
): {
  extensions: ReturnType<typeof createTuxemonExtensions>;
  rules: ReturnType<typeof createTuxemonBattleRules>;
  scenes: ReturnType<typeof createTuxemonScenes>["rules"];
  catalog: ReturnType<typeof createTuxemonScenes>["catalog"];
  /** Upstream CharacterState uses every positive-id MonsterModel as the
   * Tuxepedia progress denominator, not the campaign-visible Journal slice. */
  monsterTotal: number;
} {
  const RUNTIME_SHELL = runtimeShell;
  const provider = createTuxemonBattleDbProvider(RUNTIME_SHELL, source);
  const journalIndex = runtimeJournalIndex(RUNTIME_SHELL);
  const sceneBundle = createTuxemonScenes(provider, journalIndex, lang);
  return {
    extensions: createTuxemonExtensions(provider, {
      ...extensionOptions,
      lang,
      campaignMonsterIds: journalIndex.map((entry) => entry.id),
    }),
    rules: createTuxemonBattleRules(provider, variableEnumsJson as VariableEnums),
    scenes: sceneBundle.rules,
    catalog: sceneBundle.catalog,
    monsterTotal: RUNTIME_SHELL.monstersIndex.filter((entry) => entry.txmnId > 0).length,
  };
}

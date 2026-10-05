import shellJson from "../dist/battle-runtime-shell.json";
import variableEnumsJson from "../dist/variable-enums.json";
import { zhData } from "../ui/zh-data.ts";

import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import { createTuxemonBattleDbProvider, type BattleEntrySource } from "./battle-repository.ts";
import {
  createTuxemonExtensions,
  type GameLang,
  type TuxemonExtensionRuntimeOptions,
} from "./extension.ts";
import { createTuxemonBattleRules, type VariableEnums } from "./runtime.ts";
import { createTuxemonScenes, runtimeJournalIndex } from "./scenes.ts";

// GP1: the importer splits the runtime projection into this compact shell
// (bundled, like project-shell.json) plus one pak/data.fs entry per
// monster/technique/item/status. Building the provider here — instead of
// importing the full 801 KB battle-runtime-db.json as an object literal —
// keeps species/technique data out of the bundle and off the startup path;
// each battle then parses only the slugs it actually touches.
// The zh_CN shell is loaded synchronously from pak/data.fs only on a Chinese
// boot. The PSP build swaps ui/zh-data.ts for an English-only stub.
export function battleRuntimeShell(lang: GameLang = "en_US"): BattleRuntimeShell {
  if (lang !== "zh_CN") return shellJson as unknown as BattleRuntimeShell;
  const localized = zhData.current();
  if (!localized) throw new Error("zh_CN battle shell requested before language data was loaded");
  return localized.battleShell;
}

export function createProductionTuxemonBattle(
  source: BattleEntrySource,
  extensionOptions: Readonly<TuxemonExtensionRuntimeOptions> = {},
  lang: GameLang = "en_US",
): {
  extensions: ReturnType<typeof createTuxemonExtensions>;
  rules: ReturnType<typeof createTuxemonBattleRules>;
  scenes: ReturnType<typeof createTuxemonScenes>["rules"];
  catalog: ReturnType<typeof createTuxemonScenes>["catalog"];
} {
  const RUNTIME_SHELL = battleRuntimeShell(lang);
  const provider = createTuxemonBattleDbProvider(RUNTIME_SHELL, source);
  const sceneBundle = createTuxemonScenes(provider, runtimeJournalIndex(RUNTIME_SHELL), lang);
  return {
    extensions: createTuxemonExtensions(provider, { ...extensionOptions, lang }),
    rules: createTuxemonBattleRules(provider, variableEnumsJson as VariableEnums),
    scenes: sceneBundle.rules,
    catalog: sceneBundle.catalog,
  };
}

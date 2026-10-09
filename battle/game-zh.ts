// zh_CN inline battle registration for headless drivers and tests (the
// production bundle uses battle/production.ts with the streamed shell and
// shards). Mirrors battle/game.ts over the imported zh_CN database.

import battleDbJson from "../data/battle-db.zh_CN.json";
import variableEnumsJson from "../dist/variable-enums.json";
import mapDescriptionsJson from "../dist/map-descriptions.zh_CN.json";
import monthNamesJson from "../data/month-names.zh_CN.json";
import battleNamesJson from "../data/battle-names.zh_CN.json";

import { validateBattleDb } from "../importer/battle-schema.ts";
import { createTuxemonExtensions } from "./extension.ts";
import { createTuxemonBattleRules, type VariableEnums } from "./runtime.ts";
import { createTuxemonScenes } from "./scenes.ts";
import { createTuxemonTextTokens } from "./text-tokens.ts";

/** Shared zh_CN registration used by headless journeys and their tests. */
export const TUXEMON_BATTLE_DB_ZH = validateBattleDb(battleDbJson);
export const TUXEMON_VARIABLE_ENUMS_ZH = variableEnumsJson as VariableEnums;
export const TUXEMON_EXTENSIONS_ZH = createTuxemonExtensions(TUXEMON_BATTLE_DB_ZH, {
  lang: "zh_CN",
  battleNames: battleNamesJson,
});
export const TUXEMON_BATTLE_RULES_ZH = createTuxemonBattleRules(
  TUXEMON_BATTLE_DB_ZH,
  TUXEMON_VARIABLE_ENUMS_ZH,
);
const TUXEMON_SCENE_BUNDLE_ZH = createTuxemonScenes(TUXEMON_BATTLE_DB_ZH, undefined, "zh_CN");
export const TUXEMON_SCENES_ZH = TUXEMON_SCENE_BUNDLE_ZH.rules;
export const TUXEMON_SCENE_CATALOG_ZH = TUXEMON_SCENE_BUNDLE_ZH.catalog;
/** The {x:} text-token resolver for the zh_CN build. Headless zh_CN drivers
 *  pass it in their createTuxemonSessionOptions overrides (the EN base does
 *  not know the session language); the live GameView builds its own from the
 *  boot language. */
export const TUXEMON_TEXT_TOKENS_ZH = createTuxemonTextTokens("zh_CN", {
  mapDescriptions: mapDescriptionsJson as Record<string, string>,
  monthNames: monthNamesJson as string[],
  battleNames: battleNamesJson,
});
export const TUXEMON_SESSION_OPTIONS_ZH = Object.freeze({
  extensions: TUXEMON_EXTENSIONS_ZH,
  battle: TUXEMON_BATTLE_RULES_ZH,
  scenes: TUXEMON_SCENES_ZH,
  textTokens: TUXEMON_TEXT_TOKENS_ZH,
});

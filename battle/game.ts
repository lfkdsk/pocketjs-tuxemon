import battleDbJson from "../data/battle-db.json";
import variableEnumsJson from "../dist/variable-enums.json";
import mapDescriptionsJson from "../dist/map-descriptions.json";
import monthNamesJson from "../data/month-names.json";

import { validateBattleDb } from "../importer/battle-schema.ts";
import { createTuxemonExtensions } from "./extension.ts";
import { createTuxemonBattleRules, type VariableEnums } from "./runtime.ts";
import { createTuxemonScenes } from "./scenes.ts";
import { createTuxemonTextTokens } from "./text-tokens.ts";
import type { SessionOptions } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { ProjectSource, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { createWorldHandoffResolver } from "../vendor/pocket-rpgkit/src/engine/world-handoff.ts";

/** Shared production registration used by GameView and headless journeys. */
export const TUXEMON_BATTLE_DB = validateBattleDb(battleDbJson);
export const TUXEMON_VARIABLE_ENUMS = variableEnumsJson as VariableEnums;
export const TUXEMON_EXTENSIONS = createTuxemonExtensions(TUXEMON_BATTLE_DB);
export const TUXEMON_BATTLE_RULES = createTuxemonBattleRules(
  TUXEMON_BATTLE_DB,
  TUXEMON_VARIABLE_ENUMS,
);
const TUXEMON_SCENE_BUNDLE = createTuxemonScenes(TUXEMON_BATTLE_DB);
export const TUXEMON_SCENES = TUXEMON_SCENE_BUNDLE.rules;
export const TUXEMON_SCENE_CATALOG = TUXEMON_SCENE_BUNDLE.catalog;
/** The {x:} text-token resolver for the English build. Headless recorders
 *  and verifiers get it through createTuxemonSessionOptions; the live GameView
 *  and its attract/demo controller receive the same instance as a prop. */
export const TUXEMON_TEXT_TOKENS = createTuxemonTextTokens("en_US", {
  mapDescriptions: mapDescriptionsJson as Record<string, string>,
  monthNames: monthNamesJson as string[],
});
export const TUXEMON_SESSION_OPTIONS = Object.freeze({
  extensions: TUXEMON_EXTENSIONS,
  battle: TUXEMON_BATTLE_RULES,
  scenes: TUXEMON_SCENES,
  textTokens: TUXEMON_TEXT_TOKENS,
});

/** Build the complete game session wiring for a concrete generated project.
 * Headless recorders and verifiers must use this instead of the static
 * registration bundle: seamless traversal needs a resolver bound to the
 * project's own topology hash. Passing an explicit legacy identity keeps old
 * tapes on their original timeline. */
export function createTuxemonSessionOptions(
  project: Pick<ProjectSource, "worldTraversal" | "worldLayout">,
  worldTraversal: WorldTraversalMode = project.worldTraversal ?? "legacy-transfer",
  overrides: SessionOptions = {},
): SessionOptions {
  const base: SessionOptions = {
    ...TUXEMON_SESSION_OPTIONS,
    ...overrides,
    worldTraversal,
  };
  if (worldTraversal === "legacy-transfer") {
    delete base.handoff;
    return base;
  }
  if (project.worldTraversal !== "seamless-v1" || !project.worldLayout) {
    throw new Error("seamless-v1 session requires a seamless project with WorldLayout");
  }
  return {
    ...base,
    handoff: createWorldHandoffResolver(project.worldLayout),
  };
}

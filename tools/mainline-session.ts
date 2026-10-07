// Shared session options for headless tools that record or replay the
// mainline tape. The production GameView paginates long dialogs through the
// kit's dialog paginator (GameView.tsx createDialogPaginator); a headless
// session that does not pass the same paginator sees a different page count
// for a long corner/side dialog, so the tape's confirms run out mid-box and
// the replay stalls (the built bundle and the reducer diverge). These
// options fold in the identical paginator, keeping every headless caliber
// — recorders, verifiers, golden captures, chapters, saves — on the
// production timeline.

import { resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { productionPaginator } from "../battle/paginator.ts";
import type { SessionOptions } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { ProjectSource, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const MAINLINE_ROOT = resolve(import.meta.dir, "..");

/** Build the session options for a mainline headless session: the game's
 *  registration plus the production dialog paginator. */
export function mainlineSessionOptions(
  project: Pick<ProjectSource, "worldTraversal" | "worldLayout">,
  worldTraversal: WorldTraversalMode = project.worldTraversal ?? "legacy-transfer",
  overrides: SessionOptions = {},
): SessionOptions {
  return createTuxemonSessionOptions(project, worldTraversal, {
    paginateText: productionPaginator(MAINLINE_ROOT),
    ...overrides,
  });
}

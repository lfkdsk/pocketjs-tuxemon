// Effect-shell helpers shared by the START and title menus. Reducer state
// creation stays in the engine; these functions only bridge menu choices to
// the live GameView host and PocketJS service channel.

import type { HostOps } from "@pocketjs/framework/host";
import { startSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { SaveMenuRuntime } from "./save-menu-runtime.ts";
import type { TitleMenuAvailability } from "./title-battle-runtime.ts";

/** Drop every campaign mutation and install the session's authored fresh
 * state. This is the shared New Game / START Exit path. */
export function resetWorldSession(host: GameViewSessionHost): SessionState {
  const fresh = startSession(host.project, host.session);
  host.replaceState(fresh, 0);
  return fresh;
}

/** Refresh storage once, then publish only healthy rows. A corrupt file is
 * still visible inside SaveMenu for recovery/reporting but is not advertised
 * as a title-screen Load shortcut. Upstream shows Autosave only alongside a
 * normal save. */
export function titleSaveAvailability(
  save: Pick<SaveMenuRuntime, "refresh" | "slots" | "autosave">,
): TitleMenuAvailability {
  save.refresh();
  const manualSave = save.slots().some((slot) => slot !== null && !("error" in slot));
  const automatic = save.autosave();
  const autosave = manualSave && automatic !== null && !("error" in automatic);
  return { manualSave, autosave };
}

/** Desktop hosts close their window for this service intent. Browser hosts
 * cannot close a tab reliably, so the title overlay remains on its terminal
 * page; a web shell may additionally stop its loop through onQuit. */
export function requestHostQuit(ops: Pick<HostOps, "svcSend">): boolean {
  if (!ops.svcSend) return false;
  ops.svcSend(JSON.stringify({ t: "quit" }));
  return true;
}

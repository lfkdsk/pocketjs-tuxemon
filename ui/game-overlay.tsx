// Composite GameView overlay: the save/load menu (START), the language
// switcher (R), and game-owned apps opened from the save/world menu. Only one
// child screen is interactive at a time. A child takes priority over the save
// menu it was opened from, so closing it returns the player to that menu.

import type { JSX } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { tuxemonExtensionState } from "../battle/extension.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  GameViewDemoRuntime,
  GameViewOverlayConfig,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { UiTheme } from "../vendor/pocket-rpgkit/src/ui/theme.ts";
import type { UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";

/** An overlay whose full-screen reducer scene must bypass sibling menu
 * watchers while still letting the underlying GameView fold scene input. */
export interface SessionOwningOverlayConfig extends GameViewOverlayConfig {
  ownsSession(): boolean;
}

/** The demo transport replaces the complete live session. Keep it out of
 * reducer-owned scenes and the Park's multi-map session so a modal flow cannot
 * be abandoned halfway through. Players can open SELECT again after the scene
 * or Park visit finishes. This check only runs on the SELECT edge. */
export function demoMenuBlocked(state: Readonly<SessionState>): boolean {
  if (state.scene !== null) return true;
  if (state.interp.pendingBattles.length > 0 || (state.interp.pendingScenes?.length ?? 0) > 0) {
    return true;
  }
  const park = tuxemonExtensionState(state.ext).parkSession;
  return park?.active === true || park?.summaryPending === true;
}

export function createCompositeOverlay(
  saveMenu: GameViewOverlayConfig,
  langMenu: GameViewOverlayConfig | undefined,
  tuxepedia?: GameViewOverlayConfig,
  nuPhone?: GameViewOverlayConfig,
  titleBattle?: SessionOwningOverlayConfig,
): GameViewOverlayConfig {
  return {
    create(host: GameViewSessionHost): GameViewDemoRuntime {
      const save = saveMenu.create(host);
      const lang = langMenu?.create(host);
      const tux = tuxepedia?.create(host);
      const phone = nuPhone?.create(host);
      const title = titleBattle?.create(host);
      return {
        step(buttons, pressed) {
          if ((pressed & BTN.SELECT) !== 0 && demoMenuBlocked(host.getState())) {
            return { consumed: true };
          }
          if (title && (title.isOpen() || titleBattle?.ownsSession())) {
            // During a title battle this result deliberately stays
            // unconsumed: GameView must fold the battle scene input, but save,
            // language and phone watchers must not see the same buttons.
            return title.step(buttons, pressed);
          }
          if (phone?.isOpen()) return phone.step(buttons, pressed);
          if (tux?.isOpen()) return tux.step(buttons, pressed);
          if (save.isOpen()) return save.step(buttons, pressed);
          if (lang?.isOpen()) return lang.step(buttons, pressed);
          // All closed: the save menu watches START, the language menu R.
          const saveResult = save.step(buttons, pressed);
          if (save.isOpen() || saveResult.consumed) return saveResult;
          return lang ? lang.step(buttons, pressed) : saveResult;
        },
        isOpen: () => save.isOpen() || (lang?.isOpen() ?? false) || (tux?.isOpen() ?? false) || (phone?.isOpen() ?? false) || (title?.isOpen() ?? false),
        render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides): JSX.Element {
          return [
            save.render(theme, uiText),
            lang?.render(theme, uiText),
            tux?.render(theme, uiText),
            phone?.render(theme, uiText),
            title?.render(theme, uiText),
          ];
        },
      };
    },
  };
}

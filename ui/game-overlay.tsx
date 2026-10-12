// Composite GameView overlay: the game-owned world menu (START), its save/load
// child, the language switcher (R), and game-owned apps. Only one child screen
// is interactive at a time. A child takes priority over the world menu it was
// opened from, so closing it returns the player to that menu.

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
  worldMenu: GameViewOverlayConfig,
  langMenu: GameViewOverlayConfig | undefined,
  tuxepedia?: GameViewOverlayConfig,
  nuPhone?: GameViewOverlayConfig,
  titleBattle?: SessionOwningOverlayConfig,
  /** A child opened programmatically by the game-owned world/title menu.
   * It is never stepped while closed, so its legacy START watcher cannot
   * compete with the parent world menu. */
  childMenu?: GameViewOverlayConfig | readonly GameViewOverlayConfig[],
): GameViewOverlayConfig {
  const childMenus = childMenu === undefined
    ? []
    : Array.isArray(childMenu) ? childMenu : [childMenu];
  return {
    create(host: GameViewSessionHost): GameViewDemoRuntime {
      const world = worldMenu.create(host);
      const children = childMenus.map((config) => config.create(host));
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
          const child = children.find((runtime) => runtime.isOpen());
          if (child) return child.step(buttons, pressed);
          // Options is also a programmatic child of START/title. Give an
          // already-open language screen priority over the still-mounted
          // START root so dismissing it returns to the parent menu.
          if (lang?.isOpen()) return lang.step(buttons, pressed);
          if (world.isOpen()) return world.step(buttons, pressed);
          // All closed: the game-owned world menu watches START, the
          // language menu R. Child menus only open through parent callbacks.
          const worldResult = world.step(buttons, pressed);
          if (world.isOpen() || worldResult.consumed) return worldResult;
          return lang ? lang.step(buttons, pressed) : worldResult;
        },
        isOpen: () => world.isOpen() || children.some((runtime) => runtime.isOpen()) || (lang?.isOpen() ?? false)
          || (tux?.isOpen() ?? false) || (phone?.isOpen() ?? false) || (title?.isOpen() ?? false),
        render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides): JSX.Element {
          return [
            world.render(theme, uiText),
            ...children.map((runtime) => runtime.render(theme, uiText)),
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

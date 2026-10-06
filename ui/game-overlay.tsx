// Composite GameView overlay: the save/load menu (START), the language
// switcher (R), and the Tuxepedia (opened from the save menu). Only one is
// open at a time; each runtime owns its open button and its frames while
// open. The Tuxepedia, when open, takes priority over the save menu it was
// opened from, so closing it returns the player to that menu.

import type { JSX } from "solid-js";
import type {
  GameViewDemoRuntime,
  GameViewOverlayConfig,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { UiTheme } from "../vendor/pocket-rpgkit/src/ui/theme.ts";
import type { UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";

export function createCompositeOverlay(
  saveMenu: GameViewOverlayConfig,
  langMenu: GameViewOverlayConfig | undefined,
  tuxepedia?: GameViewOverlayConfig,
): GameViewOverlayConfig {
  return {
    create(host: GameViewSessionHost): GameViewDemoRuntime {
      const save = saveMenu.create(host);
      const lang = langMenu?.create(host);
      const tux = tuxepedia?.create(host);
      return {
        step(buttons, pressed) {
          if (tux?.isOpen()) return tux.step(buttons, pressed);
          if (save.isOpen()) return save.step(buttons, pressed);
          if (lang?.isOpen()) return lang.step(buttons, pressed);
          // All closed: the save menu watches START, the language menu R.
          const saveResult = save.step(buttons, pressed);
          if (save.isOpen() || saveResult.consumed) return saveResult;
          return lang ? lang.step(buttons, pressed) : saveResult;
        },
        isOpen: () => save.isOpen() || (lang?.isOpen() ?? false) || (tux?.isOpen() ?? false),
        render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides): JSX.Element {
          return (
            <>
              {save.render(theme, uiText)}
              {lang?.render(theme, uiText)}
              {tux?.render(theme, uiText)}
            </>
          );
        },
      };
    },
  };
}

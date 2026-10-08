// In-game save/load menu: START opens the kit's SaveMenu over the world, and
// a short notice confirms a save or a load. The logic lives in
// ui/save-menu-runtime.ts; this file only presents it.

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createOsk } from "@pocketjs/framework/osk";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { SaveMenu } from "../vendor/pocket-rpgkit/src/ui/SaveMenu.tsx";
import type { UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import { resolveUiTheme, type UiTheme } from "../vendor/pocket-rpgkit/src/ui/theme.ts";
import { createSaveMenuRuntime, validateOpenButton, type SaveMenuOptions } from "./save-menu-runtime.ts";

export function SaveToast(props: { text: () => string | null; theme?: Partial<UiTheme> }) {
  const theme = () => resolveUiTheme(props.theme);
  return (
    <Show when={props.text() !== null}>
      <View class="absolute left-0 right-0 flex-row justify-center" style={{ posType: 1, insetT: 10 }} debugName="tux-save-toast">
        <Panel theme={theme()} style={{ posType: 1, width: 300, height: 34 }} paperClass="flex-row justify-center items-center">
          <Text
            class="text-xs"
            style={{ textColor: theme().accent, lineHeight: 15, height: 15 }}
            debugName="tux-save-toast-text"
          >
            {props.text() ?? ""}
          </Text>
        </Panel>
      </View>
    </Show>
  );
}

/** GameView overlay config for the save/load menu. */
export function createSaveMenu(options: SaveMenuOptions = {}): GameViewOverlayConfig {
  validateOpenButton(options.openButton ?? BTN.START);
  return {
    create(host) {
      let activeUiText: UiTextOverrides | undefined;
      const menu = createSaveMenuRuntime(options, host, createOsk, () => activeUiText);
      return {
        step: menu.step,
        isOpen: menu.isOpen,
        render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides) {
          activeUiText = uiText;
          return (
            <>
              <SaveMenu
                menu={menu.menu}
                hasFs={menu.hasSlots}
                slots={menu.slots}
                autosave={menu.autosave}
                saveCode={menu.saveCode}
                osk={menu.osk}
                legend={menu.legend}
                theme={theme}
                title={uiText?.["save.title"] ?? menu.title}
                uiText={uiText}
                extraRows={options.extraRows}
              />
              <SaveToast text={menu.toast} theme={theme} />
            </>
          );
        },
      };
    },
  };
}

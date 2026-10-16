// In-game language switcher, opened with R. The web build persists the
// choice to localStorage and reloads the page without the lang= query
// parameter (otherwise the URL would win over the stored choice on the next
// boot); desktop writes lang.json to data.fs and asks for an app restart
// (the guest has no reload). The kit's own UI strings stay English (KUI1
// pending); this switches game content.

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { GameViewDemoRuntime, GameViewOverlayConfig, GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { resolveUiTheme, type UiTheme } from "../vendor/pocket-rpgkit/src/ui/theme.ts";
import type { Lang } from "./language.ts";
import { LANG_ROWS, createLangMenuRuntime, type LangMenuRuntime } from "./lang-menu-runtime.ts";

export { LANG_MENU_BUTTON, type LangMenuRuntime } from "./lang-menu-runtime.ts";

/** GameView overlay config for the language switcher. */
export function createLangMenu(active: Lang): GameViewOverlayConfig & {
  runtimeRef: { current: LangMenuRuntime | null };
} {
  const runtimeRef: { current: LangMenuRuntime | null } = { current: null };
  return {
    runtimeRef,
    create(_host: GameViewSessionHost): GameViewDemoRuntime {
      const menu = createLangMenuRuntime(active);
      runtimeRef.current = menu;
      return {
        step: menu.step,
        isOpen: menu.isOpen,
        render(themeProp?: Partial<UiTheme>) {
          const theme = resolveUiTheme(themeProp);
          return (
            <Show when={menu.openSignal()}>
              <View
                class="absolute inset-0 flex-row justify-center items-center"
                style={{ posType: 1, bgColor: theme.backdrop }}
                debugName="tux-lang-overlay"
              >
                <Panel
                  theme={theme}
                  style={{ posType: 1, width: 360, height: 230 }}
                  paperClass="flex-col grow p-[8]"
                  debugName="tux-lang-panel"
                >
                  <Text
                    class="text-sm"
                    style={{ textColor: theme.accent, lineHeight: 20, height: 20 }}
                    debugName="tux-lang-title"
                  >
                    {"LANGUAGE / 语言"}
                  </Text>
                  <Show when={menu.notice() !== null} fallback={
                    <>
                      {LANG_ROWS.map((row, i) => (
                        <Text
                          class="text-sm"
                          style={{
                            textColor: menu.cursor() === i ? theme.accent : theme.ink,
                            lineHeight: 22,
                            height: 22,
                          }}
                          debugName="tux-lang-row"
                        >
                          {`${menu.cursor() === i ? ">" : " "} ${row.label}  ${row.sub}`}
                        </Text>
                      ))}
                      <Text
                        class="text-xs"
                        style={{ textColor: theme.ink, lineHeight: 18, height: 18 }}
                        debugName="tux-lang-legend"
                      >
                        {"o: select   x/R: close"}
                      </Text>
                    </>
                  }>
                    <Text
                      class="text-sm"
                      style={{ textColor: theme.ink, lineHeight: 22, height: 44 }}
                      debugName="tux-lang-notice"
                    >
                      {menu.notice() ?? ""}
                    </Text>
                    <Text
                      class="text-xs"
                      style={{ textColor: theme.ink, lineHeight: 18, height: 18 }}
                      debugName="tux-lang-notice-legend"
                    >
                      {"o: ok"}
                    </Text>
                  </Show>
                </Panel>
              </View>
            </Show>
          );
        },
      };
    },
  };
}

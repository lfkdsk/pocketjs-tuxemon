// Language switcher runtime: button dispatch and the reload/restart switch
// mechanism. Presentation lives in ui/lang-menu.tsx (the same split as the
// save menu) so this runtime is testable without a JSX transform.

import { createSignal, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type { GameViewDemoRuntime } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { LANGUAGES, langSwitchMechanism, persistLang, switchLangAndReload, type Lang } from "./language.ts";

export const LANG_MENU_BUTTON = BTN.RTRIGGER;

export const LANG_ROWS: { lang: Lang; label: string; sub: string }[] =
  LANGUAGES.map(({ lang, label, sub }) => ({ lang, label, sub }));

/** Everything the presentation reads, plus the GameView step contract. */
export interface LangMenuRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  /** Test/tooling handle: open the menu programmatically. */
  open(): void;
  openSignal: Accessor<boolean>;
  cursor: Accessor<number>;
  notice: Accessor<string | null>;
}

export function createLangMenuRuntime(active: Lang): LangMenuRuntime {
  const [openSignal, setOpen] = createSignal(false);
  const [cursor, setCursor] = createSignal(Math.max(0, LANG_ROWS.findIndex((row) => row.lang === active)));
  const [notice, setNotice] = createSignal<string | null>(null);
  let waitRelease = false;

  const close = () => {
    setOpen(false);
    setNotice(null);
    waitRelease = true;
  };

  const step: GameViewDemoRuntime["step"] = (buttons, pressed) => {
    if (!openSignal()) {
      if (waitRelease) {
        if (buttons !== 0) return { consumed: true };
        waitRelease = false;
      }
      if (pressed & LANG_MENU_BUTTON) {
        setOpen(true);
        return { consumed: true };
      }
      return { consumed: false };
    }
    if (notice()) {
      if (pressed & (BTN.CIRCLE | BTN.CROSS | LANG_MENU_BUTTON)) close();
      return { consumed: true };
    }
    if (pressed & (BTN.CROSS | LANG_MENU_BUTTON)) {
      close();
      return { consumed: true };
    }
    if (pressed & BTN.UP) {
      setCursor((cursor() + LANG_ROWS.length - 1) % LANG_ROWS.length);
      return { consumed: true };
    }
    if (pressed & BTN.DOWN) {
      setCursor((cursor() + 1) % LANG_ROWS.length);
      return { consumed: true };
    }
    if (pressed & BTN.CIRCLE) {
      const choice = LANG_ROWS[cursor()]!;
      if (langSwitchMechanism() === "reload") {
        // The web player persists the choice and reloads the page without
        // the lang= parameter, so the stored choice wins on the next boot.
        if (switchLangAndReload(choice.lang)) return { consumed: true };
      } else {
        persistLang(choice.lang);
      }
      setNotice(choice.lang === "zh_CN"
        ? "已切换语言。重启游戏后生效。"
        : `Switched to ${choice.label}. Restart the game to apply.`);
      return { consumed: true };
    }
    return { consumed: true };
  };

  return {
    step,
    isOpen: () => openSignal(),
    open: () => setOpen(true),
    openSignal,
    cursor,
    notice,
  };
}

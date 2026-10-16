// In-page language switching (B1): a page opened with ?lang= must switch
// for real when the player picks another language in the page menu. The
// switch persists the choice and reloads without the lang= query parameter,
// so boot priority (URL param > storage > default) resolves to the picked
// language. These tests drive the real lang-menu runtime with button events
// and re-run the real boot detection after the simulated reload.

import { afterEach, describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import { createLangMenuRuntime, LANG_MENU_BUTTON } from "../ui/lang-menu-runtime.ts";
import {
  cleanedLangSwitchUrl,
  detectLang,
  LANGUAGES,
  LANG_STORAGE_KEY,
  normalizeLang,
} from "../ui/language.ts";

// Bun tests have no location/localStorage/history globals; each case
// installs a minimal mock of the web environment and removes it afterwards.

interface MockWeb {
  store: Map<string, string>;
  replaced: string[];
  reloads: number;
  setAddress(href: string): void;
}

function mockWeb(href: string, stored: string | null): MockWeb {
  const store = new Map<string, string>();
  if (stored !== null) store.set(LANG_STORAGE_KEY, stored);
  const replaced: string[] = [];
  const web: MockWeb = {
    store,
    replaced,
    reloads: 0,
    setAddress(newHref: string) {
      const search = newHref.includes("?") ? newHref.slice(newHref.indexOf("?")) : "";
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { search, href: newHref, reload: () => { web.reloads++; } },
      });
    },
  };
  web.setAddress(href);
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState: (_s: unknown, _t: string, u: string) => { replaced.push(u); } },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
  });
  return web;
}

afterEach(() => {
  for (const key of ["location", "history", "localStorage", "navigator"] as const) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

describe("cleanedLangSwitchUrl", () => {
  test("strips the lang parameter", () => {
    expect(cleanedLangSwitchUrl("https://example.com/game/?lang=zh")).toBe("https://example.com/game/");
  });
  test("keeps other parameters and the hash", () => {
    expect(cleanedLangSwitchUrl("https://example.com/game/?chapter=2&lang=zh#top"))
      .toBe("https://example.com/game/?chapter=2#top");
  });
  test("returns undefined without a lang parameter", () => {
    expect(cleanedLangSwitchUrl("https://example.com/game/")).toBeUndefined();
    expect(cleanedLangSwitchUrl("https://example.com/game/?chapter=2")).toBeUndefined();
  });
});

describe("detectLang boot priority", () => {
  test("normalizes canonical ids, URL aliases, and regional browser tags", () => {
    expect(["de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR"].map(normalizeLang)).toEqual([
      "de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR",
    ]);
    expect(["de-AT", "fr-CA", "es-MX", "it-CH", "pt-PT"].map(normalizeLang)).toEqual([
      "de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR",
    ]);
  });

  test("URL parameter wins over storage", () => {
    mockWeb("https://example.com/?lang=zh", "en");
    expect(detectLang()).toBe("zh_CN");
  });
  test("storage wins without a URL parameter", () => {
    mockWeb("https://example.com/", "zh");
    expect(detectLang()).toBe("zh_CN");
  });
  test("defaults to en_US with neither URL nor storage", () => {
    mockWeb("https://example.com/", null);
    expect(detectLang()).toBe("en_US");
  });

  test("uses the first supported browser language after URL and storage", () => {
    mockWeb("https://example.com/", null);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["nl-NL", "fr-CA", "de-DE"], language: "nl-NL" },
    });
    expect(detectLang()).toBe("fr_FR");
  });
});

describe("in-page language switch through the menu runtime", () => {
  test("a ?lang=zh page that selects English boots en_US after reload", () => {
    const web = mockWeb("https://example.com/?lang=zh", null);
    expect(detectLang()).toBe("zh_CN");

    const menu = createLangMenuRuntime("zh_CN");
    expect(menu.isOpen()).toBeFalse();
    menu.step(0, LANG_MENU_BUTTON); // R opens the menu
    expect(menu.isOpen()).toBeTrue();
    menu.step(0, BTN.UP); // cursor starts on 中文; move up to English
    menu.step(0, BTN.CIRCLE); // select

    expect(web.store.get(LANG_STORAGE_KEY)).toBe("en");
    expect(web.replaced).toEqual(["https://example.com/"]);
    expect(web.reloads).toBe(1);

    // The browser reloads at the cleaned address; next boot must be English.
    web.setAddress("https://example.com/");
    expect(detectLang()).toBe("en_US");
  });

  test("a default page that selects Chinese boots zh_CN after reload", () => {
    const web = mockWeb("https://example.com/", null);
    expect(detectLang()).toBe("en_US");

    const menu = createLangMenuRuntime("en_US");
    menu.step(0, LANG_MENU_BUTTON);
    menu.step(0, BTN.DOWN); // cursor starts on English; move down to 中文
    menu.step(0, BTN.CIRCLE);

    expect(web.store.get(LANG_STORAGE_KEY)).toBe("zh");
    // No lang parameter to clean: the address stays and the page reloads.
    expect(web.replaced).toEqual([]);
    expect(web.reloads).toBe(1);
    expect(detectLang()).toBe("zh_CN");
  });

  test("a ?lang=en page that selects Chinese boots zh_CN after reload", () => {
    const web = mockWeb("https://example.com/?lang=en", null);
    expect(detectLang()).toBe("en_US");

    const menu = createLangMenuRuntime("en_US");
    menu.step(0, LANG_MENU_BUTTON);
    menu.step(0, BTN.DOWN);
    menu.step(0, BTN.CIRCLE);

    expect(web.store.get(LANG_STORAGE_KEY)).toBe("zh");
    expect(web.replaced).toEqual(["https://example.com/"]);
    expect(web.reloads).toBe(1);

    web.setAddress("https://example.com/");
    expect(detectLang()).toBe("zh_CN");
  });

  test("all seven native language rows are selectable and persist stable codes", () => {
    expect(LANGUAGES.map(({ lang }) => lang)).toEqual([
      "en_US", "zh_CN", "de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR",
    ]);
    const web = mockWeb("https://example.com/", null);
    const menu = createLangMenuRuntime("en_US");
    menu.step(0, LANG_MENU_BUTTON);
    menu.step(0, BTN.DOWN);
    menu.step(0, BTN.DOWN);
    menu.step(0, BTN.CIRCLE);
    expect(web.store.get(LANG_STORAGE_KEY)).toBe("de");
    expect(web.reloads).toBe(1);
  });
});

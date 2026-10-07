// Boot-time language selection for the imported game.
//
// Sources, in order:
//   1. web URL ?lang=zh|en
//   2. web localStorage / desktop lang.json (written by the in-game
//      switcher; the web switcher also strips the URL parameter so the
//      stored choice wins on the next boot)
//   3. default en_US
//
// The kit's own UI strings stay English (KUI1 pending); this selects the
// game content language only. A save records the language it was written
// with (battle/extension.ts codec); loading it in the other language shows
// a clear message instead of silently mixing content.

import { fsHost, readFileSync, write } from "@pocketjs/framework/fs";
import type { GameLang } from "../battle/extension.ts";

export type Lang = GameLang;

export const LANG_STORAGE_KEY = "pocket-tuxemon/lang";
export const LANG_FS_ENTRY = "lang.json";

export function langCode(lang: Lang): "en" | "zh" {
  return lang === "zh_CN" ? "zh" : "en";
}

function normalizeLang(value: string | null | undefined): Lang | undefined {
  if (value === "zh" || value === "zh_CN") return "zh_CN";
  if (value === "en" || value === "en_US") return "en_US";
  return undefined;
}

function urlLang(): Lang | undefined {
  try {
    const loc = (globalThis as { location?: { search: string } }).location;
    if (!loc) return undefined;
    return normalizeLang(new URLSearchParams(loc.search).get("lang"));
  } catch {
    return undefined;
  }
}

function storedLang(): Lang | undefined {
  try {
    const storage = (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage;
    return normalizeLang(storage?.getItem(LANG_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Desktop and other fs-mounted targets: lang.json in data.fs. */
function fsLang(): Lang | undefined {
  try {
    if (!fsHost()) return undefined;
    const text = readFileSync(LANG_FS_ENTRY, "utf8");
    try {
      const parsed = JSON.parse(text) as { lang?: unknown };
      const fromObject = normalizeLang(typeof parsed.lang === "string" ? parsed.lang : undefined);
      if (fromObject) return fromObject;
    } catch {
      // A bare "zh_CN" / "zh" file is also accepted.
    }
    return normalizeLang(text.trim());
  } catch {
    return undefined;
  }
}

/** The active content language, resolved once at boot. */
export function detectLang(): Lang {
  // Test/benchmark override: force a language without URL/storage/fs.
  const forced = normalizeLang(
    (globalThis as { __pocketTuxemonLang?: string }).__pocketTuxemonLang,
  );
  if (forced) return forced;
  return urlLang() ?? storedLang() ?? fsLang() ?? "en_US";
}

function reachableStorage(): { setItem(k: string, v: string): void } | null {
  try {
    const storage = (globalThis as { localStorage?: { setItem(k: string, v: string): void } }).localStorage;
    if (!storage || typeof storage.setItem !== "function") return null;
    return storage;
  } catch {
    return null;
  }
}

/** Remember the language for the next boot. Web uses localStorage (the
 *  switcher reloads the page); fs-mounted targets write lang.json so the
 *  desktop launcher and the in-game switcher share one channel. */
export function persistLang(lang: Lang): void {
  const storage = reachableStorage();
  if (storage) {
    storage.setItem(LANG_STORAGE_KEY, langCode(lang));
    return;
  }
  if (fsHost()) {
    write(LANG_FS_ENTRY, JSON.stringify({ lang }));
  }
}

/** How a language switch takes effect on this target. */
export function langSwitchMechanism(): "reload" | "restart" {
  return reachableStorage() ? "reload" : "restart";
}

/** Whether the in-game language switcher should be shown: the target must be
 *  able to persist the choice (web localStorage, or desktop data.fs). The PSP
 *  build has neither, so its language is a build-time choice and the switcher
 *  is hidden there. */
export function canSwitchLang(): boolean {
  return reachableStorage() !== null || fsHost() !== null;
}

/** The address to reload at after an in-page language switch: the current
 *  URL with any lang= query parameter removed, so the stored choice wins on
 *  the next boot (boot priority stays URL param > storage > default).
 *  Returns undefined when the URL has no lang parameter, or is not a URL.
 *  Uses URLSearchParams (already a boot dependency) plus string edits, so it
 *  does not rely on the URL constructor being present in the guest. */
export function cleanedLangSwitchUrl(href: string): string | undefined {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return undefined;
  const params = new URLSearchParams(beforeHash.slice(queryIndex + 1));
  if (!params.has("lang")) return undefined;
  params.delete("lang");
  const remaining = params.toString();
  return `${beforeHash.slice(0, queryIndex)}${remaining ? `?${remaining}` : ""}${hash}`;
}

/** Persist a language choice made in the page and reload without the lang=
 *  query parameter, so the stored choice wins on the next boot. Returns
 *  true when a reload was triggered (web); false when there is no page to
 *  reload (desktop: the caller shows the restart notice instead). */
export function switchLangAndReload(lang: Lang): boolean {
  persistLang(lang);
  try {
    const loc = (globalThis as { location?: { reload(): void; href?: string } }).location;
    if (!loc) return false;
    if (loc.href !== undefined) {
      const cleaned = cleanedLangSwitchUrl(loc.href);
      if (cleaned !== undefined) {
        const hist = (globalThis as {
          history?: { replaceState(state: unknown, unused: string, url: string): void };
        }).history;
        hist?.replaceState(null, "", cleaned);
      }
    }
    loc.reload();
    return true;
  } catch {
    return false;
  }
}

// Boot-time language selection for the imported game.
//
// Sources, in order:
//   1. a test or build-time override
//   2. the Web URL's ?lang= value
//   3. Web localStorage / desktop lang.json (written by the in-game
//      switcher; the Web switcher also strips the URL parameter so the
//      stored choice wins on the next boot)
//   4. the browser's preferred languages
//   5. default en_US
//
// Imported content and translated feature-mode strings follow this locale;
// untranslated chrome falls back to English. A save records the language it
// was written with (battle/extension.ts codec); loading it in a different
// language shows a clear message instead of silently mixing content.

import { fsHost, readFileSync, write } from "@pocketjs/framework/fs";
import type { GameLang } from "../battle/extension.ts";

export type Lang = GameLang;

export const LANG_STORAGE_KEY = "pocket-tuxemon/lang";
export const LANG_FS_ENTRY = "lang.json";

export interface LanguageInfo {
  readonly lang: Lang;
  /** Stable URL/storage code written by this build. */
  readonly code: string;
  readonly label: string;
  readonly sub: string;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { lang: "en_US", code: "en", label: "English", sub: "English" },
  { lang: "zh_CN", code: "zh", label: "中文", sub: "简体中文" },
  { lang: "de_DE", code: "de", label: "Deutsch", sub: "Deutsch" },
  { lang: "fr_FR", code: "fr", label: "Français", sub: "Français" },
  { lang: "es_ES", code: "es", label: "Español", sub: "Español" },
  { lang: "it_IT", code: "it", label: "Italiano", sub: "Italiano" },
  { lang: "pt_BR", code: "pt-br", label: "Português", sub: "Português (Brasil)" },
] as const;

const LANGUAGE_BY_LANG = new Map(LANGUAGES.map((entry) => [entry.lang, entry]));

/** True only for the stable locale ids stored in saves and generated data. */
export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && LANGUAGE_BY_LANG.has(value as Lang);
}

export function langCode(lang: Lang): string {
  return LANGUAGE_BY_LANG.get(lang)!.code;
}

export function languageLabel(lang: Lang): string {
  return LANGUAGE_BY_LANG.get(lang)!.label;
}

export function normalizeLang(value: string | null | undefined): Lang | undefined {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "zh" || normalized === "zh-cn" || normalized === "zh-hans") return "zh_CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en_US";
  if (normalized === "de" || normalized.startsWith("de-")) return "de_DE";
  if (normalized === "fr" || normalized.startsWith("fr-")) return "fr_FR";
  if (normalized === "es" || normalized.startsWith("es-")) return "es_ES";
  if (normalized === "it" || normalized.startsWith("it-")) return "it_IT";
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt_BR";
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

function browserLang(): Lang | undefined {
  try {
    const navigator = (globalThis as {
      navigator?: { languages?: readonly string[]; language?: string };
    }).navigator;
    const candidates = navigator?.languages?.length
      ? navigator.languages
      : navigator?.language ? [navigator.language] : [];
    for (const candidate of candidates) {
      const lang = normalizeLang(candidate);
      if (lang) return lang;
    }
  } catch {
    // Sandboxed and non-browser hosts may expose a throwing navigator proxy.
  }
  return undefined;
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
  return urlLang() ?? storedLang() ?? fsLang() ?? browserLang() ?? "en_US";
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

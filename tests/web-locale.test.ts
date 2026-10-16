import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  injectBrowserLanguageDetection,
  injectLocaleBootstrapBarrier,
  WEB_LOCALE_BOOTSTRAP,
} from "../tools/web-locale.ts";

const ROOT = resolve(import.meta.dir, "..");

function runDetection(href: string, languages: string[], stored?: string): {
  stored: string | null;
  replaced: string[];
} {
  const values = new Map<string, string>();
  if (stored !== undefined) values.set("pocket-tuxemon/lang", stored);
  const replaced: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href } });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState: (_state: unknown, _unused: string, url: string) => replaced.push(url) },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages, language: languages[0] },
  });
  const html = injectBrowserLanguageDetection(
    '<script type="application/json" id="pocket-i18n">{}</script><script>pageI18n()</script>',
  );
  const script = /<script id="pocket-tuxemon-browser-language">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("injected detection script missing");
  new Function(script)();
  return { stored: values.get("pocket-tuxemon/lang") ?? null, replaced };
}

afterEach(() => {
  for (const key of ["location", "history", "localStorage", "navigator"] as const) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

describe("web locale bootstrap", () => {
  test("browser language selects and persists a supported canonical page code", () => {
    expect(runDetection("https://example.test/game/", ["de-DE", "en-US"]).stored).toBe("de");
    expect(runDetection("https://example.test/game/", ["pt-PT"]).stored).toBe("pt-br");
  });

  test("URL remains highest priority and aliases are canonicalized for page and guest", () => {
    const result = runDetection("https://example.test/game/?chapter=one&lang=pt_BR#play", ["de-DE"], "fr");
    expect(result.stored).toBe("fr");
    expect(result.replaced).toEqual(["/game/?chapter=one&lang=pt-br#play"]);
  });

  test("player awaits the selected locale chunk before evaluating the guest", () => {
    const source = readFileSync(
      resolve(ROOT, "vendor/pocket-rpgkit/tools/web/player.js"),
      "utf8",
    );
    const patched = injectLocaleBootstrapBarrier(source);
    const barrier = patched.indexOf("await globalThis.__pocketPak.prepare(");
    const evaluate = patched.indexOf("new Function(`${source}");
    expect(barrier).toBeGreaterThan(0);
    expect(evaluate).toBeGreaterThan(barrier);
    expect(WEB_LOCALE_BOOTSTRAP).toEqual({
      zh: "l10n/zh_CN/project-shell.json",
      de: "l10n/de_DE/project-shell.json",
      fr: "l10n/fr_FR/project-shell.json",
      es: "l10n/es_ES/project-shell.json",
      it: "l10n/it_IT/project-shell.json",
      "pt-br": "l10n/pt_BR/project-shell.json",
    });
  });

  test("bootstrap barrier also patches the bundled player spelling", () => {
    const source = "async boot(){let J={},C='';Function(`${C}\n//# sourceURL=${J.app}.js`)()}";
    const patched = injectLocaleBootstrapBarrier(source);
    expect(patched).toContain("await globalThis.__pocketPak.prepare(J.localeBootstrap");
    expect(patched.indexOf("__pocketPak.prepare(")).toBeLessThan(patched.indexOf("Function(`${C}"));
    expect(injectLocaleBootstrapBarrier(patched)).toBe(patched);
  });

  test("web manifest declares every canonical page language code", () => {
    const web = JSON.parse(readFileSync(resolve(ROOT, "web.json"), "utf8")) as {
      games: { "pocket-tuxemon": { languages: Array<{ code: string }> } };
    };
    expect(web.games["pocket-tuxemon"].languages.map(({ code }) => code)).toEqual([
      "en", "zh", "de", "fr", "es", "it", "pt-br",
    ]);
  });
});

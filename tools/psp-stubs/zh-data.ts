// English-only replacement for ui/zh-data.ts (tools/psp.ts temporarily
// copies this file over ui/zh-data.ts). The English PSP package ships
// English only — no CJK font, no zh shards, and the language switcher is
// hidden there — so the zh_CN JSON blobs are excluded from its JS bundle
// entirely.
// This file is self-contained because tsc also checks it in its real tools/
// location; it cannot use relative imports that resolve only after the swap
// into ui/. main.tsx sees available=false and never asks the stub to read a
// Chinese entry.
interface UnavailableZhData {
  // `never` is assignable to the real consumers' data types while documenting
  // that the English-only stub can never produce localized content.
  project: never;
  battleShell: never;
  names: {
    monsters: Record<string, string>;
    techniques: Record<string, string>;
    items: Record<string, string>;
    npcs: Record<string, string>;
    tastes?: Record<string, string>;
  };
  mapDescriptions: Record<string, string>;
  monthNames: string[];
  featureModes: never;
}

type LocalizedLang = "zh_CN" | "de_DE" | "fr_FR" | "es_ES" | "it_IT" | "pt_BR";

export function localeDataEntries(lang: LocalizedLang) {
  const root = `l10n/${lang}`;
  return {
    project: `${root}/project-shell.json`,
    battleShell: `${root}/battle-runtime-shell.json`,
    names: `${root}/battle-names.json`,
    mapDescriptions: `${root}/map-descriptions.json`,
    monthNames: `${root}/month-names.json`,
    featureModes: `${root}/feature-modes-shell.json`,
    worldItems: `${root}/feature-world-items.json`,
  } as const;
}

export const localeData: {
  readonly available: boolean;
  load(lang: LocalizedLang, read: (entry: string) => string | Uint8Array): UnavailableZhData | null;
  current(lang?: LocalizedLang): UnavailableZhData | null;
} = {
  available: false,
  load: (_lang, _read) => null,
  current: (_lang) => null,
};

export const zhData: {
  readonly available: boolean;
  load(read: (entry: string) => string | Uint8Array): UnavailableZhData | null;
  current(): UnavailableZhData | null;
} = {
  available: false,
  load: (_read) => null,
  current: () => null,
};

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
}

export const zhData: {
  readonly available: boolean;
  load(read: (entry: string) => string | Uint8Array): UnavailableZhData | null;
  current(): UnavailableZhData | null;
} = {
  available: false,
  load: (_read) => null,
  current: () => null,
};

// English-only stub swapped in by tools/psp.ts during the PSP compile (it
// is copied over ui/zh-data.ts). The PSP package ships English only — no
// CJK font, no zh shards, and the language switcher is hidden there — so
// the zh_CN JSON blobs are excluded from the PSP JS bundle entirely.
// tsc checks this file at its real location (tools/psp-stubs/), so it must
// be self-contained: no relative imports that only resolve from ui/. The
// fields are typed `unknown` so the consumers' `as unknown as X` casts
// still type-check with the stub in place. The object itself exists (its
// fields are null) because consumers read `zhData.<field>` while their
// modules load; main.tsx boots in English when `project` is null.
export const zhData: {
  project: unknown;
  battleShell: unknown;
  names: unknown;
  mapDescriptions: unknown;
  monthNames: unknown;
} = { project: null, battleShell: null, names: null, mapDescriptions: null, monthNames: null };

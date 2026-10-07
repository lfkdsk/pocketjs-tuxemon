// PSP zh_CN: stream CJK glyphs from a 2bpp font archive on the memory stick.
//
// The PSP boot pak bakes ASCII-only atlases: the full CJK subset (4.4 MiB of
// 8bpp coverage) would not fit the arena alongside the game, and embedding it
// in the PRX would shrink the arena itself. Instead the --zh build ships a
// 1.07 MiB 2bpp archive (tools/psp.ts) and opens it here with the core's
// draw-demand stream: glyphs the layout resolves to tofu are fetched on
// demand into a bounded resident set, so every Chinese string renders after
// a few frames without a per-text lease.
//
// Other targets (web/desktop) bake the CJK subset into their pak and never
// open this stream; the English PSP build boots en_US and skips it too.

import { openFontArchive } from "@pocketjs/framework/fonts";
import { detectHost, installHost } from "@pocketjs/framework/host";

/** The boot pak's baked slots (0=12r,1=14r,2=16r,3=18r,7=12b,19=10r). */
const SLOTS = [0, 1, 2, 3, 7, 19];

let opened = false;

/** Open the CJK font archive on the PSP zh build. Safe to call once at boot;
 *  no-ops on every other target/language. */
export function initZhFontStream(lang: string): void {
  if (opened || lang !== "zh_CN") return;
  // The PSP host registers the device-local offload provider
  // (`offload.local`, ms0:/PSP/COMMON/pocketjs/) on every build; web/desktop
  // hosts do not. Only the PSP build ships font-archive.bin, so a failed open
  // (missing archive, no stream ops) leaves the baked atlases in charge.
  const local = (globalThis as { offload?: { local?: unknown } }).offload?.local;
  if (typeof local !== "object" || local === null) {
    return;
  }
  try {
    // The fonts subpath can resolve its own host.ts copy; install the host
    // there too so getOps() sees the native ops.
    installHost(detectHost());
    openFontArchive({
      path: "font-archive.bin",
      slots: SLOTS,
      provider: "local",
      capacity: 256,
      drawDemand: true,
    });
    opened = true;
  } catch {
    // The archive is only shipped by the PSP zh build; stay on baked glyphs.
  }
}

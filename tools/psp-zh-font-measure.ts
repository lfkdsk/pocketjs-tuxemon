// Measure CJK font residency options for the PSP build:
//   A. full 8bpp atlas bake (the desktop/web approach) per used slot
//   B. 2bpp font archive (the streaming format, hosts/psp offload_local)
//   C. working-set subset (characters the zh smoke tape actually displays)
//
// Prints the comparison table used by findings/G-PSPZH.md. No side effects.
//
//   bun tools/psp-zh-font-measure.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bakeAtlases } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/bake-font.ts";
import { bakeFontArchive } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/font-archive.ts";
import { fontSlotFor, fontSlotInfo } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/tailwind.ts";
import { collectZhWorkingSet } from "./psp-zh-working-set.ts";

const root = resolve(import.meta.dir, "..");
const charset = [...new Set([...readFileSync(resolve(root, "fonts/cjk-charset.txt"), "utf8")])]
  .filter((ch) => ch.codePointAt(0)! >= 0x4e00 && ch.codePointAt(0)! <= 0x9fff);
const charsetCps = charset.map((ch) => ch.codePointAt(0)!);

// Slots the game+kit UI actually styles (tailwind text-* usage): 10/12/14/16/18
// regular, plus bold where a weight is used. The 16px default slot is always
// baked. Bold usage in the kit/game is rare; measure the regular set and the
// bold 14px (the kit's emphasized labels) as the upper bound.
const slotSpecs: { px: number; bold: boolean }[] = [
  { px: 10, bold: false },
  { px: 12, bold: false },
  { px: 14, bold: false },
  { px: 16, bold: false },
  { px: 18, bold: false },
  { px: 14, bold: true },
];
const slots = slotSpecs.map((s) => fontSlotFor(s.px, s.bold));

const cjkFont = resolve(root, "fonts/NotoSansCJKsc-subset.otf");

// Characters the zh smoke tape displays: every modal text/choice line the
// session renders while replaying data/zh-smoke-journey.json, collected the
// same way tools/psp-zh-working-set.ts does. This is the realistic on-demand
// working set for the opening; the full game's working set is larger but
// bounded by dialogue.
const workingCps = collectZhWorkingSet(root).cjk.map((ch) => ch.codePointAt(0)!);

console.log(`charset: ${charset.length} CJK chars`);
console.log(`smoke working set: ${workingCps.length} CJK chars`);
console.log(`slots: ${slots.map((s, i) => `${s}=${fontSlotInfo(s).px}px${slotSpecs[i]!.bold ? "b" : ""}`).join(" ")}`);
console.log("");

const asciiAtlases = await bakeAtlases({
  slots,
  codepoints: [],
  rasterDensity: 1,
});
const cjkAtlases = await bakeAtlases({
  slots,
  codepoints: charsetCps,
  fallbackTtfs: [cjkFont],
  rasterDensity: 1,
});
const workingAtlases = await bakeAtlases({
  slots,
  codepoints: workingCps,
  fallbackTtfs: [cjkFont],
  rasterDensity: 1,
});

const mib = (n: number) => (n / 1024 / 1024).toFixed(2);
console.log("slot | px | ASCII-only | full CJK (8bpp) | smoke working set (8bpp)");
let asciiTotal = 0, cjkTotal = 0, workTotal = 0;
for (let i = 0; i < slots.length; i++) {
  const a = asciiAtlases[i]!, c = cjkAtlases[i]!, w = workingAtlases[i]!;
  asciiTotal += a.bytes.length; cjkTotal += c.bytes.length; workTotal += w.bytes.length;
  console.log(
    `${String(slots[i]).padStart(2)} | ${String(fontSlotInfo(slots[i]!).px).padStart(2)} | ` +
      `${String(a.bytes.length).padStart(7)} (${a.glyphCount}g) | ` +
      `${String(c.bytes.length).padStart(8)} (${c.glyphCount}g) | ` +
      `${String(w.bytes.length).padStart(8)} (${w.glyphCount}g)`,
  );
}
console.log("");
console.log(`A. full 8bpp atlas total:     ${cjkTotal} bytes (${mib(cjkTotal)} MiB), of which CJK ink ${cjkTotal - asciiTotal}`);
console.log(`   ASCII-only total:           ${asciiTotal} bytes (${mib(asciiTotal)} MiB)`);
console.log(`   smoke working-set total:    ${workTotal} bytes (${mib(workTotal)} MiB)`);

// B. 2bpp font archive (streaming format). The archive holds every charset
// glyph per slot on the memory stick; only leased cells are resident.
const archive = await bakeFontArchive({
  font: cjkFont,
  slots,
  codepoints: charsetCps,
});
console.log(`B. 2bpp font archive total:   ${archive.length} bytes (${mib(archive.length)} MiB) on disk`);

// Per-glyph resident cost in the archive (2bpp, ceil(w*h/4) per cell) and the
// residency caps the streaming controller admits (capacity glyphs per slot).
const first = cjkAtlases[0]!;
const cellBytes = Math.ceil(first.cellW * first.cellH / 4);
console.log(`   cell: ${first.cellW}x${first.cellH} -> ${cellBytes} bytes/glyph at 2bpp`);
for (const cap of [256, 512, 1024, 2048]) {
  const resident = slots.length * cap * cellBytes;
  console.log(`   resident cap ${cap} glyphs/slot: ${resident} bytes (${mib(resident)} MiB) for ${slots.length} slots`);
}

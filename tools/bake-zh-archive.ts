import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bakeFontArchive } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/font-archive.ts";
import { fontSlotInfo } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/tailwind.ts";
const root = resolve(import.meta.dir, "..");
const charset = [...new Set([...readFileSync(resolve(root,"fonts/cjk-charset.txt"),"utf8")])]
  .filter(ch => { const cp = ch.codePointAt(0)!; return cp >= 0x4e00 && cp <= 0x9fff; })
  .map(ch => ch.codePointAt(0)!);
const archive = await bakeFontArchive({
  font: resolve(root,"fonts/NotoSansCJKsc-subset.otf"),
  slots: [19,0,1,2,3,7],
  codepoints: charset,
  onStrike: (slot, count) => { const i = fontSlotInfo(slot); console.log(`strike slot ${slot} (${i.px}px${i.bold?"b":""}): ${count} glyphs`); },
});
const out = process.argv[2] ?? resolve(root, "dist/psp/font-archive.bin");
writeFileSync(out, archive);
console.log("archive bytes:", archive.length, "(", (archive.length/1048576).toFixed(2), "MiB ) ->", out);

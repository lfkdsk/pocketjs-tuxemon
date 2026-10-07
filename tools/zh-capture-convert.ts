import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
const dir = process.argv[2];
const out = process.argv[3];
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter(f => f.endsWith(".raw")).sort();
// PSP GE framebuffer: 512-stride RGBA, alpha left clear (force opaque).
const W = 480, H = 272, STRIDE = 512;
for (const f of files) {
  const raw = readFileSync(join(dir, f));
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const row = y * STRIDE * 4;
    const dst = y * W * 4;
    for (let x = 0; x < W; x++) {
      const si = row + x * 4, di = dst + x * 4;
      rgba[di] = raw[si]!; rgba[di+1] = raw[si+1]!; rgba[di+2] = raw[si+2]!; rgba[di+3] = 255;
    }
  }
  const base = f.replace(".raw", "");
  writeFileSync(join(out, `${base}.png`), encodePNG(rgba, W, H));
  const up = new Uint8Array(rgba.length * 9);
  const w3 = W * 3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const dst = ((y * 3 + dy) * w3 + (x * 3 + dx)) * 4;
      up[dst] = rgba[src]!; up[dst+1] = rgba[src+1]!; up[dst+2] = rgba[src+2]!; up[dst+3] = 255;
    }
  }
  writeFileSync(join(out, `${base}.3x.png`), encodePNG(up, w3, H * 3));
}
console.log(`converted ${files.length} frames to ${out}`);

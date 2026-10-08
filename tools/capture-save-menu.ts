// Capture the PSP save menu: build a capture journey that opens the START
// menu after the GB6 opening prefix, run PPSSPP, convert the framebuffer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";

const ROOT = resolve(import.meta.dir, "..");
const PSP_OUT = join(ROOT, "dist/psp");
const HEADLESS = process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
const MEMSTICK = join(ROOT, ".psp-emu-memstick/save");
const OUT = join(ROOT, "dist/captures/save-menu");
const OPENING_PREFIX = 1406;
const START = 0x0008;

// Tape: GB6 opening prefix, settle, START (open save menu), settle.
const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as { masks: number[] };
const masks = journey.masks.slice(0, OPENING_PREFIX);
for (let i = 0; i < 30; i++) masks.push(0);
masks.push(START);
for (let i = 0; i < 10; i++) masks.push(0);
const tapeFile = join(ROOT, ".psp-save-e2e/save-menu.tape.json");
mkdirSync(join(ROOT, ".psp-save-e2e"), { recursive: true });
writeFileSync(tapeFile, JSON.stringify({ masks, logAt: masks.length, label: "save-menu" }));

// Build the capture journey.
console.log("# build capture journey");
const build = spawnSync(process.execPath, ["run", "build:psp", "--skip-assets", "--capture", `--journey-tape=${tapeFile}`], {
  cwd: ROOT, stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}`, PSP_CAP_START: "1440", PSP_CAP_N: "2" },
  timeout: 300000,
});
if (build.status !== 0) throw new Error("build failed");

// Run PPSSPP.
mkdirSync(OUT, { recursive: true });
const capMemstick = join(MEMSTICK, "capture");
rmSync(join(capMemstick, "dc_cap"), { recursive: true, force: true });
mkdirSync(capMemstick, { recursive: true });
const prx = join(OUT, "pocket-tuxemon.prx");
copyFileSync(join(PSP_OUT, "pocket-tuxemon.prx"), prx);
copyFileSync(join(PSP_OUT, "assets.pak"), join(OUT, "assets.pak"));
console.log("# run PPSSPP capture");
const run = spawnSync(HEADLESS, ["--graphics=software", "--timeout=120", `--memstick=${capMemstick}`, prx], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 150000,
});
const stdout = run.stdout?.toString() ?? "";
if (run.status !== 0 && !stdout.includes("TIMEOUT")) {
  console.error(stdout); console.error(run.stderr?.toString());
  throw new Error(`PPSSPP exited ${run.status}`);
}

// Convert the dumped frames.
const capDir = join(capMemstick, "dc_cap");
const raws = existsSync(capDir) ? readdirSync(capDir).filter((f) => f.endsWith(".raw")).sort() : [];
if (raws.length === 0) throw new Error("no framebuffer dumps in dc_cap");
console.log(`# ${raws.length} frame(s) dumped`);
// Crop 512-stride RGBA to 480x272, write PNG + 3x zoom.
const cropPspRaw = (raw: Uint8Array): Uint8Array => {
  const w = 480, h = 272, stride = 512;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * stride + x) * 4, di = (y * w + x) * 4;
      out[di] = raw[si]!; out[di+1] = raw[si+1]!; out[di+2] = raw[si+2]!; out[di+3] = 255;
    }
  }
  return out;
};
const zoom3 = (rgba: Uint8Array, w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * 3 * h * 3 * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const si = (y * w + x) * 4, di = ((y * 3 + dy) * w * 3 + (x * 3 + dx)) * 4;
      out[di] = rgba[si]!; out[di+1] = rgba[si+1]!; out[di+2] = rgba[si+2]!; out[di+3] = 255;
    }
  }
  return out;
};
const raw = readFileSync(join(capDir, raws[raws.length - 1]!));
const rgba = cropPspRaw(new Uint8Array(raw));
writeFileSync(join(OUT, "save-menu-480x272.png"), encodePNG(rgba, 480, 272));
writeFileSync(join(OUT, "save-menu-1440x816-3x.png"), encodePNG(zoom3(rgba, 480, 272), 1440, 816));
console.log(`# wrote ${join(OUT, "save-menu-480x272.png")} and 3x`);

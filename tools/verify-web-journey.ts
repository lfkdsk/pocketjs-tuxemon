// tools/verify-web-journey.ts — play the maintained journey tape (bedroom
// through the first battle to Route 1) in real headless Chrome against the
// built web site, one fixed step per tape frame, and compare the checkpoint
// states and framebuffer hashes with the committed 1x goldens. The browser
// renders at 2x: every map checkpoint must remain a hard-edged nearest-neighbour
// expansion, and the native canvas must match the core's physical framebuffer.
//
//   bun run web && bun tools/verify-web-journey.ts [--chrome PATH]
//   bun tools/verify-web-journey.ts --update-density-golden
//
// The page's requestAnimationFrame is frozen before load, so the player
// advances only when this script steps it: frame 0 is the player's own boot
// step (the tape starts idle), frames 1..N are fed from data/g6-journey.json.
// Any console error or uncaught exception fails the run. After the journey
// the START save menu saves to browser storage and loads the slot back.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { decodePng } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-journey");
const UPDATE_DENSITY_GOLDEN = process.argv.includes("--update-density-golden");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-journey: no site at dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8"));
const goldens = JSON.parse(readFileSync(join(ROOT, "data/g6-goldens.json"), "utf8"));
const DENSITY_DIALOG_FRAME = 1610;
const densityDialog = decodePng(new Uint8Array(readFileSync(
  join(ROOT, "tests/goldens/web-density-paper-dialog.2x.png"),
)));
if (densityDialog.width !== 960 || densityDialog.height !== 544) {
  throw new Error(`web density dialog golden is ${densityDialog.width}x${densityDialog.height}, want 960x544`);
}
const densityDialogSha256 = createHash("sha256").update(densityDialog.rgba).digest("hex");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
  },
});

// The browser and the server are torn down on every exit path (pass, fail,
// throw, signal) via the shared cleanup registry in headless-chrome.ts.
registerCleanup(() => server.stop(true));
const chrome = await spawnHeadlessChrome(CHROME, join(OUT, "profile"));
registerCleanup(() => chrome.close());
const wsUrl = chrome.wsUrl;

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map<number, (m: any) => void>();
const errors: string[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== undefined) pending.get(m.id)?.(m), pending.delete(m.id);
  else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
// Freeze the page's real-time clock: the player only advances when we step it.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};`,
});
const t0 = performance.now();
await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/pocket-tuxemon/` });
for (let i = 0; i < 600; i++) {
  const ready = await evaluate(`!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && globalThis.__rpgSessionState)`).catch(() => false);
  if (ready) break;
  await Bun.sleep(100);
}
const bootMs = performance.now() - t0;

const checkpoints = new Map<number, string>(journey.checkpoints.map((c: any) => [c.frame, c.name]));
const result = await evaluate(`(async () => {
  const masks = ${JSON.stringify(journey.masks)};
  const marks = new Set(${JSON.stringify([...checkpoints.keys()])});
  const p = globalThis.__pocketPlayer;
  const density = p.config.rasterDensity ?? 1;
  const fnv = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
  const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const downsample = (physical, width, height) => {
    const logical = new Uint8Array(width * height * 4);
    const center = density >> 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = (((y * density + center) * width * density) + x * density + center) * 4;
        const dst = (y * width + x) * 4;
        logical[dst] = physical[src];
        logical[dst + 1] = physical[src + 1];
        logical[dst + 2] = physical[src + 2];
        logical[dst + 3] = physical[src + 3];
      }
    }
    return logical;
  };
  const nearestMismatches = (logical, physical, width, height, x0 = 0, y0 = 0, x1 = width, y1 = height) => {
    let mismatches = 0;
    for (let y = y0 * density; y < y1 * density; y++) {
      for (let x = x0 * density; x < x1 * density; x++) {
        const src = ((Math.floor(y / density) * width) + Math.floor(x / density)) * 4;
        const dst = (y * width * density + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (physical[dst + channel] !== logical[src + channel]) {
            mismatches++;
            break;
          }
        }
      }
    }
    return mismatches;
  };
  const byteMismatches = (a, b) => {
    if (a.length !== b.length) return Math.max(a.length, b.length);
    let mismatches = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mismatches++;
    return mismatches;
  };
  const out = {
    density,
    size: [p.width, p.height],
    physicalSize: [p.canvas.width, p.canvas.height],
    marks: {},
    frames: 0,
  };
  // Frame 0 already ran at boot with buttons 0 (masks[0] is 0).
  if (masks[0] !== 0) throw new Error("tape does not start with an idle frame");
  const snap = (frame) => {
    const s = globalThis.__rpgSessionState;
    // These four committed checkpoints contain only pixel-art world scenes.
    // A future text/vector checkpoint needs its own 2x golden instead of the
    // nearest-neighbour assertion below.
    const logical = new Uint8Array(p.wasm.render());
    const physical = new Uint8Array(p.wasm.renderScaled(density));
    const sampled = downsample(physical, p.width, p.height);
    out.marks[frame] = {
      hash: fnv(sampled),
      logicalHash: fnv(logical),
      physicalHash: fnv(physical),
      nearestMismatches: nearestMismatches(logical, physical, p.width, p.height),
      state: [s.mapId, s.move.tx, s.move.ty],
    };
  };
  if (marks.has(0)) snap(0);
  const t = performance.now();
  for (let frame = 1; frame < masks.length; frame++) {
    const mask = masks[frame];
    p.buttons = () => mask;
    p.step();
    out.frames++;
    if (marks.has(frame)) snap(frame);
    if (frame === ${DENSITY_DIALOG_FRAME}) {
      const s = globalThis.__rpgSessionState;
      const logical = new Uint8Array(p.wasm.render());
      const physical = new Uint8Array(p.wasm.renderScaled(density));
      p.paint();
      const modal = s.interp.modal;
      out.densityDialog = {
        frame,
        sha256: await sha256(physical),
        // The upper map is texture-only and must still be exact nearest-neighbour.
        mapNearestMismatches: nearestMismatches(logical, physical, p.width, p.height, 0, 0, p.width, 170),
        // This rectangle covers both dialog lines. Native-density glyph coverage
        // must differ materially from a mechanical scale-up of the 1x frame.
        textNearestMismatches: nearestMismatches(logical, physical, p.width, p.height, 8, 174, 470, 220),
        pngBase64: p.canvas.toDataURL("image/png").split(",", 2)[1],
        state: [s.mapId, s.move.tx, s.move.ty],
        modal: modal && { kind: modal.kind, complete: modal.complete, lines: modal.lines },
      };
    }
  }
  out.ms = performance.now() - t;
  const s = globalThis.__rpgSessionState;
  out.end = [s.mapId, s.move.tx, s.move.ty];
  out.scene = s.scene ? s.scene.kind : null;
  p.paint();
  const canvas = p.context.getImageData(0, 0, p.canvas.width, p.canvas.height).data;
  const physical = new Uint8Array(p.wasm.renderScaled(density));
  out.canvas = {
    hash: fnv(canvas),
    physicalHash: fnv(physical),
    byteMismatches: byteMismatches(canvas, physical),
  };
  const rect = p.canvas.getBoundingClientRect();
  out.presentation = {
    dpr: window.devicePixelRatio,
    cssSize: [rect.width, rect.height],
    backingSize: [p.canvas.width, p.canvas.height],
    deviceScale: p.scale.device,
    rasterScale: p.scale.raster,
    devicePixelsPerRasterSample: [
      rect.width * window.devicePixelRatio / p.canvas.width,
      rect.height * window.devicePixelRatio / p.canvas.height,
    ],
  };
  return out;
})()`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(OUT, "end.png"), Buffer.from(shot.data, "base64"));
const canvasUrl = await evaluate(`globalThis.__pocketPlayer.canvas.toDataURL("image/png")`);
writeFileSync(join(OUT, "end-canvas.png"), Buffer.from(canvasUrl.split(",", 2)[1], "base64"));
const capturedDialog = Buffer.from(result.densityDialog.pngBase64, "base64");
writeFileSync(join(OUT, "density-dialog.png"), capturedDialog);
if (UPDATE_DENSITY_GOLDEN) {
  writeFileSync(join(ROOT, "tests/goldens/web-density-paper-dialog.2x.png"), capturedDialog);
}

// After the journey: START opens the save menu, slot 1 saves into the page's
// local storage, a short walk moves the player, and loading slot 1 puts them
// back. The menu's own state and the stored envelope are read back here.
const saveLeg = await evaluate(`(() => {
  const p = globalThis.__pocketPlayer;
  const menu = globalThis.__pocketTuxemonSave;
  const at = () => { const s = globalThis.__rpgSessionState; return [s.mapId, s.move.tx, s.move.ty].join(","); };
  const press = (mask) => { p.buttons = () => mask; p.step(); p.buttons = () => 0; p.step(); };
  const hold = (mask, frames) => { p.buttons = () => mask; for (let i = 0; i < frames; i++) p.step(); p.buttons = () => 0; for (let i = 0; i < 20; i++) p.step(); };
  const START = 0x0008, DOWN = 0x0040, CIRCLE = 0x2000, UP = 0x0010, LEFT = 0x0080;
  const out = { channel: menu ? menu.channel() : null, saved: at() };
  localStorage.removeItem("pocket-tuxemon/save/slot-1");
  press(START);
  out.opened = menu.menu().kind;
  press(CIRCLE);
  press(CIRCLE);
  out.message = menu.menu().title || null;
  out.stored = (localStorage.getItem("pocket-tuxemon/save/slot-1") || "").length;
  press(CIRCLE);
  press(START);
  hold(UP, 40);
  if (at() === out.saved) hold(LEFT, 40);
  out.walked = at();
  press(START);
  press(DOWN);
  press(CIRCLE);
  // An imported autosave exists by this point and occupies the read-only
  // first row. Move to the first manual slot before confirming the restore.
  press(DOWN);
  press(CIRCLE);
  for (let i = 0; i < 4; i++) p.step();
  out.closed = menu.menu().kind;
  out.toast = menu.toast();
  out.loaded = at();
  p.paint();
  return out;
})()`);
const saveShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(OUT, "save-loaded.png"), Buffer.from(saveShot.data, "base64"));

console.log(`boot ${bootMs.toFixed(0)} ms; replayed ${result.frames + 1} frames in ${result.ms.toFixed(0)} ms; viewport ${result.size.join("x")} @${result.density}x (${result.physicalSize.join("x")})`);
let ok = true;
const viewportOk = result.density === 2 && result.size.join() === "480,272" && result.physicalSize.join() === "960,544";
ok &&= viewportOk;
console.log(`${viewportOk ? "ok  " : "FAIL"} raster: logical ${result.size.join("x")} @${result.density}x -> physical ${result.physicalSize.join("x")} (want 480x272 @2x -> 960x544)`);
for (const g of goldens.frames) {
  const got = result.marks[g.frame];
  const stateOk = got && got.state.join() === [g.map, ...g.position].join();
  const hashOk = got && got.hash === g.rgbaFnv1a && got.logicalHash === g.rgbaFnv1a;
  const nearestOk = got && got.nearestMismatches === 0;
  ok &&= !!(stateOk && hashOk && nearestOk);
  console.log(`${stateOk && hashOk && nearestOk ? "ok  " : "FAIL"} ${g.name} @${g.frame}: state ${got?.state.join(",")} (want ${g.map},${g.position.join(",")}) sampled/logical pixels ${got?.hash}/${got?.logicalHash} (want ${g.rgbaFnv1a}), 2x nearest mismatches ${got?.nearestMismatches}, physical ${got?.physicalHash}`);
}
const dialog = result.densityDialog;
const dialogStateOk = dialog?.frame === DENSITY_DIALOG_FRAME &&
  dialog.state.join() === "spyder_paper_town,24,13" &&
  dialog.modal?.kind === "text" && dialog.modal.complete === true &&
  dialog.modal.lines?.join("\n") === "I recognize you, you're the kid who hasn't got a\nGold Pass.";
const expectedDialogSha256 = UPDATE_DENSITY_GOLDEN ? dialog?.sha256 : densityDialogSha256;
const dialogPixelsOk = dialog?.sha256 === expectedDialogSha256;
const dialogDensityOk = dialog?.mapNearestMismatches === 0 && dialog?.textNearestMismatches > 1_000;
ok &&= !!(dialogStateOk && dialogPixelsOk && dialogDensityOk);
console.log(`${dialogStateOk && dialogPixelsOk && dialogDensityOk ? "ok  " : "FAIL"} native-density dialog @${DENSITY_DIALOG_FRAME}: state ${dialog?.state?.join(",")}, physical sha256 ${dialog?.sha256} (want ${expectedDialogSha256}), map nearest mismatches ${dialog?.mapNearestMismatches}, text native-density mismatches ${dialog?.textNearestMismatches}`);
const endOk = result.end.join() === [journey.map, ...journey.position].join();
ok &&= endOk;
console.log(`${endOk ? "ok  " : "FAIL"} end: ${result.end.join(",")} (want ${journey.map},${journey.position.join(",")}), scene ${result.scene}`);
const canvasOk = result.canvas.byteMismatches === 0 && result.canvas.hash === result.canvas.physicalHash;
ok &&= canvasOk;
console.log(`${canvasOk ? "ok  " : "FAIL"} canvas: pixels ${result.canvas.hash}, core ${result.canvas.physicalHash}, byte mismatches ${result.canvas.byteMismatches}`);
const wholePositive = (value: number) => value >= 1 && Math.abs(value - Math.round(value)) < 1e-6;
const presentationOk = result.presentation.dpr === 1 &&
  result.presentation.backingSize.join() === result.physicalSize.join() &&
  result.presentation.deviceScale % result.density === 0 &&
  wholePositive(result.presentation.rasterScale) &&
  result.presentation.devicePixelsPerRasterSample.every(wholePositive);
ok &&= presentationOk;
console.log(`${presentationOk ? "ok  " : "FAIL"} presentation: CSS ${result.presentation.cssSize.join("x")} at DPR ${result.presentation.dpr}, backing ${result.presentation.backingSize.join("x")}, device/raster scale ${result.presentation.deviceScale}/${result.presentation.rasterScale}, device pixels per raster sample ${result.presentation.devicePixelsPerRasterSample.join("x")}`);
const saveOk = saveLeg.channel === "browser" && saveLeg.opened === "root" && saveLeg.message === "SAVED TO SLOT 1" &&
  saveLeg.stored > 1000 && saveLeg.walked !== saveLeg.saved && saveLeg.closed === "closed" &&
  saveLeg.toast === "Loaded slot 1" && saveLeg.loaded === saveLeg.saved;
ok &&= saveOk;
console.log(`${saveOk ? "ok  " : "FAIL"} save menu: ${saveLeg.channel} storage, saved at ${saveLeg.saved} (${saveLeg.stored} bytes, "${saveLeg.message}"), walked to ${saveLeg.walked}, loaded back to ${saveLeg.loaded} ("${saveLeg.toast}")`);
console.log(`console errors: ${errors.length}${errors.length ? "\n  " + errors.slice(0, 5).join("\n  ") : ""}`);
ok &&= errors.length === 0;
console.log(ok ? "WEB JOURNEY PASS" : "WEB JOURNEY FAIL");
ws.close();
process.exit(ok ? 0 : 1);

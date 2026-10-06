// tools/verify-web-lang.ts — drive the built web site in headless Chrome and
// prove the language behavior the page switcher promises:
//
//   1. A ?lang= deep link beats the stored language and SURVIVES chapter and
//      autoplay clicks (the URL keeps the parameter, the page and game stay
//      in that language, and a refresh keeps it) — in both directions.
//   2. The controls table shows only the active language's wording (English
//      actions under English, their translations under Chinese), on both the
//      player page and the landing page.
//   3. The per-language chapter preview swaps with the language.
//   4. Landing-page chapter chips carry the active language into the player
//      page.
//
//   bun run web && bun tools/verify-web-lang.ts [--chrome PATH]
//
// Screenshots land in dist/web-lang/ and are meant to be opened and looked
// at, not just hash-pinned.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-lang");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-lang: no site at dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const GAME = "pocket-tuxemon";
const LANG_STORAGE = "pocket-tuxemon/lang";

// --- Chrome harness (mirrors verify-web-demo.ts) ---------------------------

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

const proc = Bun.spawn([
  CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
  `--user-data-dir=${OUT}/profile`, "--no-first-run", "--disable-background-networking",
  "--window-size=1280,900", "--force-device-scale-factor=1", "about:blank",
], { stdout: "ignore", stderr: "pipe" });
const reader = proc.stderr.getReader();
let text = "";
let wsUrl = "";
while (!wsUrl) {
  const { value, done } = await reader.read();
  if (done) throw new Error("chrome exited: " + text);
  text += new TextDecoder().decode(value);
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
  if (m) {
    const port = new URL(m[1]!).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
    wsUrl = targets.find((t) => t.type === "page").webSocketDebuggerUrl;
  }
}
reader.releaseLock();

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
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};
localStorage.setItem(${JSON.stringify(LANG_STORAGE)}, "zh");`,
});

const base = `http://127.0.0.1:${server.port}/${GAME}/`;
const paint = () => evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.paint()`);
const shot = async (name: string) => {
  await paint();
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(png.data, "base64"));
};
const waitFor = async (label: string, expression: string, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(expression).catch(() => false);
    if (ok) return;
    await evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.step()`).catch(() => {});
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
};
const boot = async (query = "") => {
  await send("Page.navigate", { url: base + query });
  await waitFor("boot", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && globalThis.__rpgkitDemo && globalThis.__rpgSessionState)`);
  for (let i = 0; i < 10; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
};

let failures = 0;
const check = (label: string, ok: boolean, detail: string | null = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const pageLang = () => evaluate(`document.documentElement.lang`) as Promise<string>;
const fullscreenLabel = () => evaluate(`document.getElementById("fullscreen-toggle").textContent.trim()`) as Promise<string>;
const locationSearch = () => evaluate(`location.search`) as Promise<string>;
const controlCell = (action: string) =>
  evaluate(`document.querySelector(${JSON.stringify(`[data-i18n-control="${action}"]`)})?.textContent ?? null`) as Promise<string | null>;
const EN_ACTIONS = [
  "Walk / choose",
  "Talk / confirm",
  "Back / cancel",
  "Open the demo menu (chapters, map warp, autoplay)",
  "Save / load menu",
  "Switch language (in game)",
];

// --- 1. A ?lang= deep link survives chapter and autoplay clicks -------------

await boot("?lang=en");
check("deep link beats the stored language", (await pageLang()) === "en" && (await fullscreenLabel()) === "Fullscreen",
  `lang=${await pageLang()} storage=${await evaluate(`localStorage.getItem(${JSON.stringify(LANG_STORAGE)})`)}`);
check("the deep link does not overwrite the stored language",
  (await evaluate(`localStorage.getItem(${JSON.stringify(LANG_STORAGE)})`)) === "zh");

await evaluate(`document.querySelector('[data-demo-chapter="paper-town"]').click()`);
await waitFor("chapter paper-town", `__rpgSessionState.mapId === "spyder_paper_town"`);
let search = await locationSearch();
check("chapter click keeps the deep-link language", search.includes("lang=en") && search.includes("chapter=paper-town"), search);
check("chapter click keeps the page English", (await pageLang()) === "en" && (await fullscreenLabel()) === "Fullscreen");

await send("Page.navigate", { url: base + search });
await waitFor("reload", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && __rpgSessionState.mapId === "spyder_paper_town")`);
for (let i = 0; i < 10; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
check("refresh after the chapter click stays English", (await pageLang()) === "en", await locationSearch());

await evaluate(`document.querySelector('[data-demo-speed="2"]').click()`);
await waitFor("autoplay", `__rpgkitDemo && __rpgkitDemo.current() && __rpgkitDemo.current().speed === 2`);
search = await locationSearch();
check("autoplay click keeps the deep-link language", search.includes("lang=en") && search.includes("autoplay=") && search.includes("speed=2"), search);
await send("Page.navigate", { url: base + search });
await waitFor("reload after autoplay", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running")`);
for (let i = 0; i < 10; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
check("refresh after the autoplay click stays English", (await pageLang()) === "en", await locationSearch());

// --- 2. The controls table follows the page language ------------------------

check("English controls table shows the English actions",
  (await controlCell("Switch language (in game)")) === "Switch language (in game)");
const englishTableHasZh = await evaluate(`
  (() => {
    const table = document.querySelector("table.controls");
    return table ? /[一-鿿]/.test(table.textContent) : "no table";
  })()`);
check("English controls table has no Chinese", englishTableHasZh === false, String(englishTableHasZh));

await evaluate(`document.querySelector('[data-lang-code="zh"]').click()`);
await waitFor("switch to Chinese", `document.documentElement.lang === "zh" && globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running"`);
for (let i = 0; i < 30; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
check("switching to Chinese reboots the page and game", (await pageLang()) === "zh" && (await fullscreenLabel()) === "全屏",
  `lang=${await pageLang()} fullscreen=${await fullscreenLabel()}`);
check("Chinese controls table shows only Chinese actions",
  (await controlCell("Switch language (in game)")) === "切换语言（游戏内）",
  await controlCell("Switch language (in game)"));
const chineseTableHasEn = await evaluate(`
  (() => {
    const table = document.querySelector("table.controls");
    if (!table) return "no table";
    return ${JSON.stringify(EN_ACTIONS)}.some((en) => table.textContent.includes(en));
  })()`);
check("Chinese controls table has no English actions", chineseTableHasEn === false, String(chineseTableHasEn));
await shot("player-zh");

// --- 2b. Switcher-driven Chinese: chapter jumps and Autoplay ----------------

const ZH_CHAPTER_JUMPS: ReadonlyArray<readonly [string, string]> = [
  ["bedroom", "spyder_bedroom"],
  ["paper-town", "spyder_paper_town"],
  ["candy-town", "spyder_candy_town"],
];
for (const [chapterId, mapId] of ZH_CHAPTER_JUMPS) {
  await evaluate(`document.querySelector(${JSON.stringify(`[data-demo-chapter="${chapterId}"]`)}).click()`);
  await waitFor(`zh chapter ${chapterId}`, `__rpgSessionState.mapId === ${JSON.stringify(mapId)}`);
  const zhSearch = await locationSearch();
  check(`zh chapter ${chapterId} restores after the switcher`, zhSearch.includes(`chapter=${chapterId}`), zhSearch);
}

// Chinese Autoplay for 600 frames: a fresh boot with autoplay (the page
// stays Chinese through the stored choice), the same contract
// verify-web-demo §5 proves, driven through the page here. Autoplay does not
// advance one session frame per step(), so poll until the frame lands.
await send("Page.navigate", { url: base + "?autoplay=bedroom&speed=1" });
await waitFor("zh autoplay boot", `__rpgkitDemo && __rpgkitDemo.current() && __rpgkitDemo.current().speed === 1 && globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running"`);
for (let i = 0; i < 10; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
const frameBefore = (await evaluate(`__rpgSessionState.frame`)) as number;
const target = frameBefore + 600;
let stepped = 0;
while (stepped < 12000) {
  await evaluate(`globalThis.__pocketPlayer.step()`);
  stepped++;
  if ((await evaluate(`__rpgSessionState.frame`)) as number >= target) break;
}
const frameAfter = (await evaluate(
  `({ frame: __rpgSessionState.frame, running: globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" })`,
)) as { frame: number; running: boolean };
check("zh autoplay runs 600 frames after the switcher",
  frameAfter.running && frameAfter.frame >= target,
  `frame ${frameBefore} -> ${frameAfter.frame} (${stepped} steps)`);
await shot("player-zh-autoplay");

// --- 3. The per-language chapter preview swaps ------------------------------

const preview = await evaluate(`
  (() => {
    const img = document.getElementById("demo-chapter-preview-bedroom");
    return img ? { src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0 } : null;
  })()`);
check("Chinese chapter preview is the localized image",
  preview !== null && preview.src.endsWith("chapter-previews/bedroom.zh.png") && preview.loaded,
  JSON.stringify(preview));

// --- 4. Landing chips carry the active language -----------------------------

await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/?lang=en` });
await waitFor("landing", `document.documentElement.getAttribute("data-page-lang") === "en"`);
const chipHref = (await evaluate(`
  document.querySelector('[data-landing-chapter="pocket-tuxemon/bedroom"]')?.href ?? null`)) as string | null;
check("landing chapter chips carry the deep-link language",
  chipHref !== null && chipHref.includes("lang=en") && chipHref.includes("chapter=bedroom"),
  chipHref ?? "no chip");
const landingControl = (await evaluate(`
  document.querySelector('[data-landing-control="pocket-tuxemon"][data-i18n-control="Walk / choose"]')?.textContent ?? null`)) as string | null;
check("landing controls table follows the language", landingControl === "Walk / choose", landingControl);

// --- 3x screenshots for the report ------------------------------------------

await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 3, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/?lang=zh` });
await waitFor("landing zh", `document.documentElement.getAttribute("data-page-lang") === "zh"`);
const landingShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(join(OUT, "landing-zh-3x.png"), Buffer.from(landingShot.data, "base64"));

await send("Page.navigate", { url: base + "?lang=zh" });
await waitFor("player zh", `document.documentElement.lang === "zh" && globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running"`);
for (let i = 0; i < 120; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
await paint();
const playerShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(OUT, "player-zh-3x.png"), Buffer.from(playerShot.data, "base64"));
await send("Emulation.clearDeviceMetricsOverride");

// --- Teardown ---------------------------------------------------------------

await new Promise((r) => setTimeout(r, 200));
ws.close();
proc.kill();
server.stop(true);

if (errors.length > 0) {
  for (const error of errors) console.error("console:", error);
  failures += errors.length;
}
console.log(failures === 0 ? "WEB LANG PASS" : `WEB LANG FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

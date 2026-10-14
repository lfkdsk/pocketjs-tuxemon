// tools/verify-web-zh.ts — play the zh_CN opening smoke tape in real headless
// Chrome against the built web site (?lang=zh), capture the dialog/choice/
// battle frames, and assert the pixels and the text:
//
//   - dialog screenshots are taken after the typewriter finished, so the
//     body area is drawn (non-background pixel lower bound)
//   - a long mainline dialog paginates into consecutive pages whose
//     concatenation equals the catalog full text (no truncation, no …)
//   - on-screen choice text equals the catalog strings
//   - the battle menu is captured while open (state + pixels), with Chinese
//     prompt text — not a post-battle map
//   - every displayed CJK character is in the subset font, and glyph cells
//     are not hollow tofu boxes, on EVERY screenshot (not just the first)
//
//   bun run web && bun tools/verify-web-zh.ts [--chrome PATH]
//
// Screenshots land in dist/web-zh/ at 3x for visual inspection.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import { WEB_CHUNK_AWARE_STEP_SOURCE } from "./web-chunk-step.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-zh");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-zh: no site at dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const journey = JSON.parse(readFileSync(join(ROOT, "data/zh-smoke-journey.json"), "utf8"));

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
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};
${WEB_CHUNK_AWARE_STEP_SOURCE}`,
});
await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/pocket-tuxemon/?lang=zh` });
for (let i = 0; i < 600; i++) {
  const ready = await evaluate(`!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && globalThis.__rpgSessionState)`).catch(() => false);
  if (ready) break;
  await Bun.sleep(100);
}

// Drive the tape. Text modals are captured only after the typewriter caught
// up (idle frames are inserted while a text box is open, so the body is
// drawn); choices and the battle menu are captured the moment they appear.
// Every modal transition is recorded in order so the pagination assertion
// can find consecutive pages of one long dialog.
const checkpoints = new Map<number, string>(journey.checkpoints.map((c: any) => [c.frame, c.name]));
const checkpointNames = JSON.stringify([...checkpoints.entries()].map(([f, n]) => [f, n]));
console.log("verify-web-zh: driving the zh smoke tape...");
const driveResult = await evaluate(`(async () => {
  const masks = ${JSON.stringify(journey.masks)};
  const p = globalThis.__pocketPlayer;
  const density = p.config.rasterDensity ?? 1;
  const out = {
    density, frames: 0, dialogFrames: 0, choiceFrames: 0, battleMenuFrames: 0,
    modalSequence: [], captures: [],
  };
  if (masks[0] !== 0) throw new Error("tape does not start with an idle frame");
  const want = new Set(${JSON.stringify([...checkpoints.keys()])});
  const cpNames = new Map(${checkpointNames});
  const capturedText = new Set();
  const capturedChoices = new Set();
  let battleCaptured = false;
  let textCaptures = 0;
  const MAX_TEXT_CAPTURES = 14;
  const readState = () => globalThis.__rpgSessionState;
  const captureFrame = (frame, name, kind, extra) => {
    p.paint();
    const logical = new Uint8Array(p.wasm.render());
    let bin = "";
    for (let i = 0; i < logical.length; i += 0x8000) bin += String.fromCharCode(...logical.subarray(i, i + 0x8000));
    out.captures.push({
      frame, name, kind,
      lines: extra?.lines ?? [],
      options: extra?.options ?? [],
      prompt: extra?.prompt ?? "",
      page: extra?.page ?? null,
      pageStarts: extra?.pageStarts ?? null,
      battleEntries: extra?.battleEntries ?? null,
      battlePlayerMonster: extra?.battlePlayerMonster ?? null,
      width: p.width, height: p.height,
      b64: btoa(bin),
    });
  };
  const modalKey = (m) => m.kind === "text"
    ? "text:" + m.lines.join("/") + "#" + (m.page ?? 0)
    : m.kind === "choices" ? "choices:" + m.options.join("/") : m.kind;
  for (let frame = 1; frame < masks.length; frame++) {
    // Before applying this frame's tape input: if the modal left open by the
    // previous frame is a text box that finished typing, capture it now (the
    // body is drawn). No idle frames are inserted, so the tape timing and the
    // battle trigger are preserved.
    const s0 = readState();
    const m0 = s0 && s0.interp ? s0.interp.modal : null;
    if (m0 && m0.kind === "text" && m0.complete) {
      const key = modalKey(m0);
      if (!capturedText.has(key) && textCaptures < MAX_TEXT_CAPTURES) {
        capturedText.add(key);
        textCaptures++;
        out.dialogFrames++;
        captureFrame(frame, "text-" + out.dialogFrames, "text", m0);
      }
    }
    // Apply the tape's input for this frame.
    const mask = masks[frame];
    p.buttons = () => mask;
    await globalThis.__pocketTestStep();
    out.frames++;
    const s = readState();
    const modal = s && s.interp ? s.interp.modal : null;
    const inBattle = !!(s && s.scene && s.scene.kind === "battle");
    const st = inBattle && s.scene.state ? s.scene.state : null;
    // The root command menu is only visible when no presentation event
    // (narration like "X entered the battle!") is on screen.
    const presenting = !!(st && st.battle && Array.isArray(st.battle.events)
      && st.eventCursor !== undefined && st.eventCursor < st.battle.events.length
      && st.battle.events[st.eventCursor] != null);
    const battleMenu = !!st && st.menuMode === "root" && st.battle && st.battle.awaiting && !presenting;
    if (battleMenu) out.battleMenuFrames++;
    // Record modal transitions (for the pagination assertion).
    if (modal) {
      const key = modalKey(modal);
      const last = out.modalSequence[out.modalSequence.length - 1];
      if (!last || last.key !== key) {
        out.modalSequence.push({
          key, kind: modal.kind, frame,
          lines: modal.kind === "text" ? modal.lines : [],
          options: modal.kind === "choices" ? modal.options : [],
          prompt: modal.kind === "choices" ? modal.prompt : "",
          page: modal.kind === "text" ? (modal.page ?? null) : null,
          pageStarts: modal.kind === "text" ? (modal.pageStarts ?? null) : null,
        });
      }
    }
    // Choices appear immediately (no typewriter): capture at once.
    if (modal && modal.kind === "choices") {
      const key = modalKey(modal);
      if (!capturedChoices.has(key)) {
        capturedChoices.add(key);
        out.choiceFrames++;
        captureFrame(frame, "choice-" + out.choiceFrames, "choices", modal);
      }
    }
    // Battle menu: capture the first frame the root menu is awaiting input.
    if (battleMenu && !battleCaptured) {
      battleCaptured = true;
      // Guard with optional chaining: a capture taken outside battle (e.g. a
      // mutated capture condition) must reach the battle assertions below and
      // fail there, not throw a TypeError over a null scene state.
      const party0 = st?.battle && Array.isArray(st.battle.parties) ? st.battle.parties[0] : null;
      const playerMonster = Array.isArray(party0) && party0[0] ? {
        slug: String(party0[0].slug ?? ""),
        nickname: party0[0].nickname != null ? String(party0[0].nickname) : null,
      } : null;
      captureFrame(frame, "battle-menu", "battle", {
        battleEntries: Array.isArray(st?.menu) ? st.menu.map((e) => ({
          kind: String(e.kind ?? ""),
          slug: String(e.slug ?? ""),
        })) : [],
        battlePlayerMonster: playerMonster,
      });
    }
    // Checkpoints.
    if (want.has(frame)) {
      captureFrame(frame, cpNames.get(frame), "checkpoint", null);
    }
  }
  return out;
})()`);
console.log(`verify-web-zh: drove ${driveResult.frames} frames, ${driveResult.captures.length} captures`);
const result = driveResult;
const captureFrames = driveResult.captures;
interface Capture {
  name: string; frame: number; png: Uint8Array; rgba: Uint8Array;
  width: number; height: number; kind: string;
  lines: string[]; options: string[]; prompt: string;
  page: number | null; pageStarts: number[] | null;
  battleEntries: { kind: string; slug: string }[] | null;
  battlePlayerMonster: { slug: string; nickname: string | null } | null;
}
const captures: Capture[] = [];

for (const cap of captureFrames) {
  const bin = Buffer.from(cap.b64, "base64");
  const rgba = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  const png = encodePNG(rgba, cap.width, cap.height);
  const base = `${String(cap.frame).padStart(5, "0")}-${cap.name}`;
  writeFileSync(join(OUT, `${base}.png`), png);
  // 3x nearest-neighbour upscale for visual inspection.
  const up = new Uint8Array(rgba.length * 9);
  const w3 = cap.width * 3, h3 = cap.height * 3;
  for (let y = 0; y < cap.height; y++) for (let x = 0; x < cap.width; x++) {
    const src = (y * cap.width + x) * 4;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const dst = ((y * 3 + dy) * w3 + (x * 3 + dx)) * 4;
      up[dst] = rgba[src]!; up[dst + 1] = rgba[src + 1]!; up[dst + 2] = rgba[src + 2]!; up[dst + 3] = rgba[src + 3]!;
    }
  }
  writeFileSync(join(OUT, `${base}.3x.png`), encodePNG(up, w3, h3));
  captures.push({
    name: cap.name, frame: cap.frame, png, rgba, width: cap.width, height: cap.height,
    kind: cap.kind, lines: cap.lines ?? [], options: cap.options ?? [], prompt: cap.prompt ?? "",
    page: cap.page ?? null, pageStarts: cap.pageStarts ?? null,
    battleEntries: cap.battleEntries ?? null,
    battlePlayerMonster: cap.battlePlayerMonster ?? null,
  });
}

// --- glyph-mask text verification ------------------------------------------
// Instead of counting light pixels in a band that also holds map and box
// decoration, we render the EXPECTED text from the baked font atlas and
// compare its glyph mask against the screenshot's text region. This catches
// early screenshots (trailing glyphs missing), blacked-out bodies, and
// pure-light battle menus, which a pixel-count threshold lets through.

const { loadFontMask, renderTextMask, maskMatch } = await import("./zh-font-mask.ts");
const font = loadFontMask();

const assertions: { name: string; ok: boolean; detail: string }[] = [];
function assert(name: string, ok: boolean, detail = "") {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Dialog theme (ui/tuxemon-theme.ts): paper #102b3a (dark navy), ink #f5f1d7
// (cream). Battle theme: paper #f5f1d7, ink/accent for labels.
// Text predicates are sum-based with a wide margin over the background so
// anti-aliased glyph edges count as ink.
const isDialogInk = (r: number, g: number, b: number) => r + g + b > 250;
const isDialogPaper = (r: number, g: number, b: number) => r < 45 && g < 75 && b < 95;
const isBattlePaper = (r: number, g: number, b: number) => r > 225 && g > 220 && b > 180;
// Battle message-band ink: dark navy text (core ~16,43,58) on light paper —
// the inverse of the dialog box. Mid-tone anti-aliased edges (~390 sum) stay
// out, matching the font mask's solid-core (alpha >= 100) pixels.
const isBattleInk = (r: number, g: number, b: number) => r + g + b < 250;

function pxAt(rgba: Uint8Array, W: number, x: number, y: number): [number, number, number] {
  const o = (y * W + x) * 4;
  return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!];
}

/** Best mask-match score over a small offset search around (ox, oy). */
function bestMatch(
  mask: { width: number; height: number; ink: Uint8Array },
  rgba: Uint8Array, W: number, ox: number, oy: number,
  isOn: (x: number, y: number) => boolean, radius = 4,
): { score: number; dx: number; dy: number } {
  let best = { score: 0, dx: 0, dy: 0 };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const m = maskMatch(mask, rgba, W, ox + dx, oy + dy, isOn);
      if (m.score > best.score) best = { score: m.score, dx, dy };
    }
  }
  return best;
}

/** Ink bounding box of a region under a predicate. */
function inkBBox(
  rgba: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number,
  isOn: (x: number, y: number) => boolean,
): { minX: number; minY: number; maxX: number; maxY: number; count: number } | null {
  let minX = W, minY = H_MAX, maxX = -1, maxY = -1, count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (isOn(x, y)) {
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return count > 0 ? { minX, minY, maxX, maxY, count } : null;
}
const H_MAX = 9999;

/** Mask ink bounding box. */
function maskBBox(mask: { width: number; height: number; ink: Uint8Array }): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.ink[y * mask.width + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Align the mask's ink bbox to the screenshot's ink bbox and score the
 *  overlap, trying small offsets to absorb anti-aliasing jitter. */
function alignAndMatch(
  mask: { width: number; height: number; ink: Uint8Array },
  rgba: Uint8Array, W: number,
  region: { x0: number; y0: number; x1: number; y1: number },
  isOn: (x: number, y: number) => boolean, radius = 2,
): { score: number; dx: number; dy: number } {
  const ss = inkBBox(rgba, W, region.x0, region.y0, region.x1, region.y1, isOn);
  if (!ss) return { score: 0, dx: 0, dy: 0 };
  const mb = maskBBox(mask);
  const baseDx = ss.minX - mb.minX;
  const baseDy = ss.minY - mb.minY;
  let best = { score: 0, dx: 0, dy: 0 };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const m = maskMatch(mask, rgba, W, baseDx + dx, baseDy + dy, isOn);
      if (m.score > best.score) best = { score: m.score, dx: baseDx + dx, dy: baseDy + dy };
    }
  }
  return best;
}

// --- text helpers -----------------------------------------------------------
const { buildZhCatalog } = await import("../importer/l10n.ts");
const zhCatalog = buildZhCatalog();
const zhSource = [...zhCatalog.values()].map((s) => s.replace(/\\n/g, "\n"));
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Every CJK character in a string. */
function cjkChars(s: string): string[] {
  return [...s].filter((ch) => ch >= "一" && ch <= "鿿");
}

// The subset font's charset (one character per code point).
const charset = new Set([...readFileSync(join(ROOT, "fonts/cjk-charset.txt"), "utf8")]);

// zh_CN monster display names for the battle prompt.
const zhBattleNames = JSON.parse(readFileSync(join(ROOT, "data/battle-names.zh_CN.json"), "utf8")) as {
  monsters: Record<string, string>;
};

// --- assertions -------------------------------------------------------------
assert("the zh site booted ?lang=zh", result.frames === journey.masks.length - 1, `${result.frames} frames`);
assert("a Chinese dialog was shown", result.dialogFrames > 0, `${result.dialogFrames} text captures`);
assert("a Chinese choice was shown", result.choiceFrames > 0, `${result.choiceFrames} choice captures`);
assert("the battle menu was reached", result.battleMenuFrames > 0, `${result.battleMenuFrames} frames`);
assert("no console errors", errors.length === 0, errors.slice(0, 3).join("; "));

// Dialog text: every line of every text capture must match its expected glyph
// mask (rendered from the font atlas). The kit's DialogBox sits at a fixed
// viewport position (bottom, insetB=8, MESSAGE_BOX_H=92), so the text origin
// is deterministic; a small offset search absorbs anti-aliasing jitter. A
// typewriter that has not finished, a blacked-out body, or a truncated line
// leaves expected glyph ink unmatched.
const textCaps = captures.filter((c) => c.kind === "text");
const ROW_H = 15; // MESSAGE_ROW_H in the kit's DialogBox
const BOX_Y0 = 172; // dialog box top in a 480x272 frame
const TEXT_X = 18;   // first text column (box interior + padding)
const TEXT_Y0 = 184; // first text row top
let worstDialogScore = Infinity;
let dialogChecked = 0;
for (const cap of textCaps) {
  const isOn = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= cap.width || y >= cap.height) return false;
    const [r, g, b] = pxAt(cap.rgba, cap.width, x, y);
    return isDialogInk(r, g, b);
  };
  for (let li = 0; li < cap.lines.length; li++) {
    const line = cap.lines[li]!;
    if (line.trim() === "") continue;
    const mask = renderTextMask(font, line);
    const oy = TEXT_Y0 + li * ROW_H - 2; // coverage cell has 2px top padding
    const m = bestMatch(mask, cap.rgba, cap.width, TEXT_X, oy, isOn, 4);
    worstDialogScore = Math.min(worstDialogScore, m.score);
    dialogChecked++;
    if (m.score < 0.6) {
      assert(`dialog glyphs @${cap.name} line ${li + 1}`, false,
        `"${line.slice(0, 20)}" match ${(m.score * 100).toFixed(0)}% at (${TEXT_X + m.dx},${oy + m.dy})`);
    }
  }
}
if (dialogChecked > 0) {
  assert("every dialog line matches its font glyph mask", worstDialogScore >= 0.6,
    `${dialogChecked} lines, worst ${(worstDialogScore * 100).toFixed(0)}%`);
}

// Charset coverage: every displayed CJK character is in the subset font.
const displayedText = [
  ...captures.filter((c) => c.kind === "text").flatMap((c) => c.lines),
  ...captures.filter((c) => c.kind === "choices").flatMap((c) => [c.prompt, ...c.options]),
].join("\n");
const missingChars = [...new Set(cjkChars(displayedText))].filter((ch) => !charset.has(ch));
assert("every displayed CJK character is in the subset font", missingChars.length === 0,
  missingChars.length ? `missing: ${missingChars.join("")}` : "");

// No component-inserted ellipsis: no shown text line contains … unless the
// catalog source has it.
const catalogHasEllipsis = zhSource.some((s) => s.includes("…"));
const shownLines = result.modalSequence
  .filter((m: any) => m.kind === "text")
  .flatMap((m: any) => m.lines as string[]);
const ellipsisLines = shownLines.filter((l: string) => l.includes("…") && !zhSource.some((s: string) => s.includes(l)));
assert("no kit-inserted ellipsis in dialog text", ellipsisLines.length === 0,
  ellipsisLines.slice(0, 2).join(" | ") || (catalogHasEllipsis ? "(catalog has …, allowed)" : ""));

// Long-dialogue pagination: the longest sub-run of >=2 consecutive text
// modals whose concatenated lines STRICTLY EQUAL a catalog entry. The
// importer wraps CJK at 52 columns and Latin at spaces, so the join
// separator differs; we remove ALL whitespace from both sides and compare
// the pure character sequence. A one-character truncation (or any
// dropped/inserted glyph) fails. Consecutive text modals may belong to
// different dialogs, so every sub-run is checked, not just the full run.
const seq = result.modalSequence as any[];
const squash = (s: string) => s.replace(/\s+/g, "");
const catalogSquash = new Set(zhSource.map((s) => squash(s)).filter((s) => s.length >= 30));
let paginationOk = false;
let paginationDetail = "no consecutive text-modal sub-run exactly matched a catalog entry";
let bestRun = { pages: 0, chars: 0 };
for (let i = 0; i < seq.length - 1; i++) {
  if (seq[i]!.kind !== "text") continue;
  let runText = "";
  for (let j = i; j < seq.length && seq[j]!.kind === "text"; j++) {
    runText = squash(runText + (seq[j]!.lines as string[]).join(""));
    const pages = j - i + 1;
    if (pages < 2 || runText.length <= bestRun.chars) continue;
    if (catalogSquash.has(runText)) {
      bestRun = { pages, chars: runText.length };
      paginationOk = true;
      paginationDetail = `${pages} pages, ${runText.length} chars, strictly equals catalog entry`;
    }
  }
}
assert("a long dialog paginated into consecutive pages strictly equal to the catalog text", paginationOk, paginationDetail);

// Choices: on-screen option text equals catalog strings (or the raw option
// value when the catalog has no translation).
const choiceCaps = captures.filter((c) => c.kind === "choices");
let choiceOk = choiceCaps.length > 0;
let choiceDetail = `${choiceCaps.length} choice captures`;
for (const cap of choiceCaps) {
  for (const opt of cap.options) {
    const inCatalog = zhSource.some((s) => normalize(s).includes(normalize(opt)));
    if (!inCatalog) {
      const isRawValue = opt.length > 0 && !/[一-鿿]/.test(opt);
      if (!isRawValue) {
        choiceOk = false;
        choiceDetail = `option "${opt}" not in catalog`;
      }
    }
  }
}
assert("on-screen choice text matches the catalog", choiceOk, choiceDetail);

// Battle menu: the root command grid and the prompt are captured while open.
// Each command label is rendered from the font atlas and matched against its
// cell; the prompt is matched against the message band. Painting the cells
// pure light (or capturing a post-battle map) leaves no glyph ink to match.
const battleCap = captures.find((c) => c.kind === "battle");
if (battleCap) {
  assert("battle menu captured while open", result.battleMenuFrames > 0, `${result.battleMenuFrames} frames`);
  // Root command labels, keyed by entry slug (ui/battle-scene-locale.ts).
  const ROOT_LABELS: Record<string, string> = {
    fight: "战斗", item: "道具", forfeit: "认输", capture: "捕获", run: "逃跑", swap: "替换",
  };
  const entries = battleCap.battleEntries ?? [];
  const labels = entries.map((e) => e.kind === "replacement" ? "替换" : ROOT_LABELS[e.slug] ?? e.slug);
  // CommandGrid geometry: R.menu = {x:244, y:216}; grid insetT = R.menu.y+4;
  // 2x2 cells, CELL_W=116, CELL_H=22, 2px inset (vendor CommandGrid.tsx).
  const MENU_X = 244, MENU_Y = 216, CELL_W = 116, CELL_H = 22, GRID_PAD = 2;
  const isNonPaper = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= battleCap.width || y >= battleCap.height) return false;
    const [r, g, b] = pxAt(battleCap.rgba, battleCap.width, x, y);
    return !isBattlePaper(r, g, b);
  };
  let worstMenuScore = Infinity;
  let menuChecked = 0;
  for (let i = 0; i < Math.min(labels.length, 4); i++) {
    const r = Math.floor(i / 2), c = i % 2;
    const cellX = MENU_X + GRID_PAD + c * CELL_W;
    const cellY = MENU_Y + 4 + GRID_PAD + r * CELL_H;
    const mask = renderTextMask(font, labels[i]!);
    // The label sits ~6px below the cell top (the cell has a top border and
    // the glyph coverage cell carries 2px of top padding). bestMatch searches
    // a small offset window; the cell border does not affect the score
    // because the mask has no ink there.
    const m = bestMatch(mask, battleCap.rgba, battleCap.width, cellX, cellY + 6, isNonPaper, 6);
    worstMenuScore = Math.min(worstMenuScore, m.score);
    menuChecked++;
    // Threshold 0.45 (below the dialog text's 0.6): the selected cell's
    // orange label and its cursor sit in the same band, costing precision,
    // and gray labels anti-alias into the paper. A solid-light paint still
    // drives every label to 0 (no non-paper pixels at all), so the
    // assertion stays discriminating with margin on real renders.
    if (m.score < 0.45) {
      assert(`battle command "${labels[i]}" glyphs @cell ${r},${c}`, false,
        `match ${(m.score * 100).toFixed(0)}% at (${cellX + m.dx},${cellY + 6 + m.dy})`);
    }
  }
  if (menuChecked > 0) {
    assert("every battle command label matches its font glyph mask", worstMenuScore >= 0.45,
      `${menuChecked} labels, worst ${(worstMenuScore * 100).toFixed(0)}%`);
  }
  // The prompt: "<monster> 要做什么？" in the message band (R.message, left).
  // The battle message band is LIGHT paper with DARK ink (the inverse of the
  // dialog box), so the ink predicate must match dark pixels — matching light
  // pixels would score the uniform background and let a solid-light band pass
  // at 100%.
  const pm = battleCap.battlePlayerMonster;
  if (pm) {
    const monsterName = pm.nickname ?? zhBattleNames.monsters[pm.slug] ?? pm.slug;
    const prompt = `${monsterName} 要做什么？`;
    const mask = renderTextMask(font, prompt);
    const isOn = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= battleCap.width || y >= battleCap.height) return false;
      const [r, g, b] = pxAt(battleCap.rgba, battleCap.width, x, y);
      return isBattleInk(r, g, b);
    };
    const m = alignAndMatch(mask, battleCap.rgba, battleCap.width,
      // The band's 2 px panel border is the same dark navy as the text, so the
      // region must start inside the border (band top 216 + border 2 + a
      // margin) and end above the bottom border, or the ink bbox spans the
      // whole panel and the alignment is meaningless.
      { x0: 8, y0: 222, x1: 236, y1: 256 }, isOn);
    assert("battle prompt matches its font glyph mask", m.score >= 0.5,
      `"${prompt}" match ${(m.score * 100).toFixed(0)}%`);
  } else {
    assert("battle prompt matches its font glyph mask", false, "no player monster captured");
  }
} else {
  assert("battle menu captured while open", false, "no battle capture");
}

const report = {
  site: `?lang=zh`,
  frames: result.frames,
  dialogFrames: result.dialogFrames,
  choiceFrames: result.choiceFrames,
  battleMenuFrames: result.battleMenuFrames,
  captures: captures.map((c) => ({ name: c.name, frame: c.frame, kind: c.kind })),
  worstDialogScore,
  dialogChecked,
  missingChars: missingChars.join(""),
  pagination: paginationDetail,
  assertions,
};
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
const failed = assertions.filter((a) => !a.ok);
console.log(`\n${assertions.length - failed.length}/${assertions.length} assertions passed; ${captures.length} screenshots in ${OUT}`);
if (failed.length) {
  console.error("FAIL: " + failed.map((f) => f.name).join("; "));
  process.exit(1);
}
console.log("PASS");
process.exit(0);

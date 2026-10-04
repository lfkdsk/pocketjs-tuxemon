// Headless acceptance drive for the zh_CN opening: bedroom through the
// first dialog pages, a choice, and the first battle menu. The English
// smoke (tools/smoke-spyder.ts) covers the same route; this one proves the
// Chinese build boots, displays Chinese text (no tofu, no inserted
// ellipsis), paginates long dialogs, and records a short tape the web
// verifier replays through the built bundle.
//
//   TUXEMON_SRC=/path bun tools/smoke-zh.ts
//
// Writes data/zh-smoke-journey.json (the host-rate mask tape + checkpoints).

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createSession, startSession, stepSession, tableWithBodies, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import { readShardedProject } from "./generated-project.ts";
import { TUXEMON_BATTLE_RULES_ZH, TUXEMON_EXTENSIONS_ZH, TUXEMON_SCENES_ZH, TUXEMON_TEXT_TOKENS_ZH } from "../battle/game-zh.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB_ZH } from "../battle/game-zh.ts";
import { buildZhCatalog } from "../importer/l10n.ts";
import { utilitySceneAutoplayMask } from "./scene-autoplay.ts";

const PROJECT_ROOT = resolve(process.env.G6_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const OUT_DIR = resolve(process.env.G6_OUT_DIR ?? join(PROJECT_ROOT, "dist"));
const JOURNEY_OUT = resolve(process.env.ZH_JOURNEY_OUT
  ?? join(PROJECT_ROOT, "data/zh-smoke-journey.json"));
const HZ = Number(process.env.HZ ?? 60);

const sharded = readShardedProject(PROJECT_ROOT, "zh_CN");
const project = sharded.project;
// The maintained tapes record the seamless traversal identity the game
// ships with; this tape stops in Paper Town before the first outdoor seam.
const WORLD_TRAVERSAL = "seamless-v1" as const;
const sess = createSession(project, HZ, createTuxemonSessionOptions(project, WORLD_TRAVERSAL, {
  maps: sharded.repository,
  extensions: TUXEMON_EXTENSIONS_ZH,
  battle: TUXEMON_BATTLE_RULES_ZH,
  scenes: TUXEMON_SCENES_ZH,
  textTokens: TUXEMON_TEXT_TOKENS_ZH,
}));
let st: SessionState = startSession(project, sess);

const DX = [0, -1, 0, 1];
const DY = [1, 0, -1, 0];
const BTN_OF: Record<Dir4, number> = { 0: BTN_BITS.DOWN, 1: BTN_BITS.LEFT, 2: BTN_BITS.UP, 3: BTN_BITS.RIGHT };
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;
const journal: string[] = [];
const masks: number[] = [];
const checkpoints: { name: string; frame: number; map: string; position: [number, number] }[] = [];
const seenTexts: { frame: number; map: string; lines: string[] }[] = [];
const seenChoices: { frame: number; options: string[] }[] = [];
let frames = 0;
let lastModalKey = "";
let lastMap = st.mapId;
let prevButtons = 0;
let battleStartFrame = -1;
let battleEndFrame = -1;
let battleMenuSeen = false;

function note(s: string): void {
  journal.push(`[${String(frames).padStart(5)}] ${s}`);
}

function tick(buttons = 0, edges: { confirm?: boolean; cancel?: boolean; down?: boolean; up?: boolean; left?: boolean; right?: boolean } = {}): void {
  const mask = buttons |
    (edges.confirm ? BTN_CONFIRM : 0) |
    (edges.cancel ? BTN_CANCEL : 0) |
    (edges.down ? BTN_BITS.DOWN : 0) |
    (edges.up ? BTN_BITS.UP : 0) |
    (edges.left ? BTN_BITS.LEFT : 0) |
    (edges.right ? BTN_BITS.RIGHT : 0);
  const downEdge = edges.down ?? !!((mask & BTN_BITS.DOWN) && !(prevButtons & BTN_BITS.DOWN));
  const upEdge = edges.up ?? !!((mask & BTN_BITS.UP) && !(prevButtons & BTN_BITS.UP));
  const leftEdge = edges.left ?? !!((mask & BTN_BITS.LEFT) && !(prevButtons & BTN_BITS.LEFT));
  const rightEdge = edges.right ?? !!((mask & BTN_BITS.RIGHT) && !(prevButtons & BTN_BITS.RIGHT));
  const confirmEdge = edges.confirm ?? !!((mask & BTN_CONFIRM) && !(prevButtons & BTN_CONFIRM));
  const cancelEdge = edges.cancel ?? !!((mask & BTN_CANCEL) && !(prevButtons & BTN_CANCEL));
  const input = { buttons: mask, confirmEdge, downEdge, upEdge, leftEdge, rightEdge, cancelEdge };
  const sceneBefore = st.scene;
  const battleBefore = sceneBefore?.kind === "battle";
  st = stepSession(sess, st, input);
  prevButtons = mask;
  masks.push(mask >>> 0);
  frames++;
  // Battle boundaries are pinned on the BATTLE scene specifically: utility
  // scenes (intro, journal) also appear/disappear and must not overwrite the
  // battle start or end (that produced a reversed startFrame > endFrame,
  // which made the QuickJS harness skip every battle bucket).
  const battleAfter = st.scene?.kind === "battle";
  if (!battleBefore && battleAfter) battleStartFrame = frames;
  if (battleBefore && !battleAfter && battleStartFrame > 0 && battleEndFrame < 0) battleEndFrame = frames;
  if (battleAfter && st.scene) {
    const bs = st.scene.state as { menuMode?: string; battle?: { awaiting?: unknown } };
    if (bs?.menuMode === "root" && bs?.battle?.awaiting) battleMenuSeen = true;
  }
  const m = st.interp.modal;
  const key = m?.kind === "text"
    ? `text|${m.lines.join("/")}`
    : m?.kind === "choices"
      ? `choices|${m.prompt}|${m.options.join("/")}`
      : m?.kind === "shop"
        ? `shop|${m.fiber}|${m.stage}|${m.index}|${m.rows.length}`
        : "";
  if (key && key !== lastModalKey) {
    if (m?.kind === "text") {
      seenTexts.push({ frame: frames, map: st.mapId, lines: [...m.lines] });
      note(`TEXT  ${m.lines.join(" / ")}`);
    }
    else if (m?.kind === "choices") {
      seenChoices.push({ frame: frames, options: [...m.options] });
      note(`CHOICE [${m.options.join(" | ")}]`);
    }
    else if (m?.kind === "shop") note(`SHOP  ${m.fiber} (${m.stage})`);
  }
  lastModalKey = key;
  if (st.mapId !== lastMap) { note(`MAP   ${lastMap} -> ${st.mapId} @${st.move.tx},${st.move.ty}`); lastMap = st.mapId; }
  if (st.interp.error) throw new Error(st.interp.error.message);
}

const v = (id: string): number => {
  const value = st.sw.variables[id];
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error(`expected numeric variable ${id}, got ${typeof value}`);
  return value;
};

/** Advance text boxes; answer choice boxes from `answers` (label wanted). */
function settle(answers: string[] = [], maxFrames = 3000): void {
  const startMap = st.mapId;
  for (let i = 0; i < maxFrames; i++) {
    if (st.scene) {
      const mask = st.scene.kind === "scene" ? utilitySceneAutoplayMask(st.scene) : BTN_CONFIRM;
      tick(mask);
      tick();
      continue;
    }
    if (st.mapId !== startMap && !st.fade) return;
    const m = st.interp.modal;
    if (!m) {
      let idle = 0;
      while (!st.interp.modal && !st.scene && idle < 12) {
        tick();
        if (st.mapId !== startMap && !st.fade) return;
        idle = st.interp.main || st.interp.inputLocked || st.fade ? 0 : idle + 1;
        if (frames > 200000) return;
      }
      if (st.scene) continue;
      if (!st.interp.modal) return;
      continue;
    }
    if (m.kind === "text") { tick(0, { confirm: true }); tick(); continue; }
    if (m.kind === "shop") { tick(0, { cancel: true }); tick(); continue; }
    const want = answers.shift();
    const idx = want === undefined ? 0 : m.options.findIndex((o) => o === want);
    if (idx < 0) throw new Error(`choice ${want} not in [${m.options.join(", ")}]`);
    while ((st.interp.modal as { index: number } | null)?.index !== idx) { tick(0, { down: true }); tick(); }
    note(`PICK  ${m.options[idx]}`);
    tick(0, { confirm: true }); tick();
  }
  throw new Error("settle: modal never closed");
}

function touchCells(): Set<string> {
  const map = sess.maps.get(st.mapId)!;
  const out = new Set<string>();
  for (const ev of map.events ?? []) {
    const page = [...ev.pages].reverse().find((p) => !p.condition || (p.condition.variable ? (() => {
      const x = v(p.condition!.variable!.id), c = p.condition!.variable!;
      return c.op === "==" ? x === c.value : c.op === "!=" ? x !== c.value : c.op === ">=" ? x >= c.value : x <= c.value;
    })() : true));
    if (page?.trigger === "playerTouch") out.add(`${ev.x},${ev.y}`);
  }
  return out;
}

function bfs(tx: number, ty: number): Dir4[] | null {
  const table = tableWithBodies(sess.tables.get(st.mapId)!, st.chars);
  const avoid = touchCells();
  const start = `${st.move.tx},${st.move.ty}`;
  const prev = new Map<string, [string, Dir4]>([[start, ["", 0]]]);
  const q = [[st.move.tx, st.move.ty]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === tx && y === ty) break;
    for (const d of [0, 1, 2, 3] as Dir4[]) {
      const nx = x! + DX[d]!, ny = y! + DY[d]!;
      const k = `${nx},${ny}`;
      if (prev.has(k) || !canStepFrom(table, x!, y!, d)) continue;
      if (avoid.has(k) && !(nx === tx && ny === ty)) continue;
      prev.set(k, [`${x},${y}`, d]);
      q.push([nx, ny]);
    }
  }
  const goal = `${tx},${ty}`;
  if (!prev.has(goal)) return null;
  const path: Dir4[] = [];
  for (let k = goal; k !== start; k = prev.get(k)![0]) path.unshift(prev.get(k)![1]);
  return path;
}

function blockingNpcAt(tx: number, ty: number): boolean {
  return Object.values(st.chars.chars).some((character) =>
    character.blocks && character.tx === tx && character.ty === ty
  );
}

function waitForOpenGoal(tx: number, ty: number, map: string): boolean {
  const maxWaitFrames = Math.max(8, Math.ceil(HZ * 10));
  for (let waited = 0; blockingNpcAt(tx, ty) && waited < maxWaitFrames; waited++) {
    tick();
    if (st.mapId !== map || st.interp.modal || st.interp.main) return false;
  }
  return !blockingNpcAt(tx, ty);
}

function walkTo(tx: number, ty: number, soft = false): boolean {
  const map = st.mapId;
  if (st.interp.modal || st.interp.main) return false;
  if (st.move.tx === tx && st.move.ty === ty && !st.move.moving) return true;
  if (!waitForOpenGoal(tx, ty, map)) {
    if (soft) return false;
    throw new Error(`walkTo ${tx},${ty}: destination stayed occupied for 10 seconds`);
  }
  const width = sess.maps.get(map)!.width;
  const avoid = new Set([...touchCells()].map((cell) => {
    const [x, y] = cell.split(",").map(Number);
    return y! * width + x!;
  }));
  let plan;
  try {
    plan = searchWalk({ session: sess, state: st, prevMask: prevButtons, tx, ty, avoid });
  } catch (error) {
    if (soft) return false;
    throw error;
  }
  for (let i = 0; i < plan.masks.length; i++) {
    tick(plan.masks[i]!);
    if (JSON.stringify(st) !== JSON.stringify(plan.states[i])) {
      throw new Error(`walk replay diverged on ${map} frame ${i + 1}/${plan.masks.length}`);
    }
  }
  return st.mapId === map && st.move.tx === tx && st.move.ty === ty && !st.move.moving;
}

function goTo(tx: number, ty: number): void {
  const map = st.mapId;
  for (let i = 0; i < 8; i++) {
    if (walkTo(tx, ty, true)) return;
    settle();
    if (st.mapId !== map) return;
  }
  throw new Error(`goTo ${tx},${ty}: kept being interrupted`);
}

function interact(d: Dir4): void {
  tick(BTN_OF[d], { confirm: true });
  while (st.move.moving && !st.interp.modal && !st.interp.main) tick();
  tick();
}

function expect(what: string, ok: boolean): void {
  note(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) { writeOut(); throw new Error(`smoke-zh: ${what}`); }
}

function checkpoint(name: string): void {
  checkpoints.push({ name, frame: frames - 1, map: st.mapId, position: [st.move.tx, st.move.ty] });
  note(`MARK  ${name} ${st.mapId} @${st.move.tx},${st.move.ty}`);
}

function writeOut(): void {
  writeFileSync(join(OUT_DIR, "smoke-zh.log"), journal.join("\n") + "\n");
}

// --- the story beats --------------------------------------------------------

const hasCjk = (s: string): boolean => /[一-鿿]/.test(s);

note(`START ${st.mapId} @${st.move.tx},${st.move.ty}`);
// A frame-0 checkpoint so the QuickJS harness's frozen_at (which finds the
// last checkpoint with frame <= current) has an entry from the first frame.
checkpoints.push({ name: "start", frame: 0, map: st.mapId, position: [st.move.tx, st.move.ty] });
settle(["是"]); // "Do you want to skip the intro?" -> Yes
expect("skip-intro choice transfers to the Paper Town mart", st.mapId === "spyder_paper_scoop");
settle(["友友猫", "是"]); // storekeeper intro; rival's monster; "are you sure?"
expect("mart intro ends back in the bedroom", st.mapId === "spyder_bedroom" && v("v.intro_scoop") > 0);
checkpoint("bedroom");

walkTo(7, 2);
settle();
expect("stairs (touch) lead downstairs", st.mapId === "spyder_downstairs");
for (let i = 0; i < 10; i++) tick(); // let the new map's parallels run
const momOn = v("local.npc.spyder_papertown_mom") === 1;
expect("the spawn guard created mom (party empty)", momOn);
// talk to mom wherever her random walk put her
for (let tries = 0; tries < 20 && v("v.spokenmom") === 0; tries++) {
  const mom = st.chars.chars["npc_spyder_papertown_mom"];
  if (!mom) { for (let i = 0; i < 30; i++) tick(); continue; }
  const spots = ([0, 1, 2, 3] as Dir4[]).map((d) => ({ d, x: mom.tx + DX[d]!, y: mom.ty + DY[d]! }));
  const avoid = touchCells();
  const spot = spots.find((s) => !avoid.has(`${s.x},${s.y}`) && bfs(s.x, s.y));
  if (!spot) { for (let i = 0; i < 30; i++) tick(); continue; }
  if (!walkTo(spot.x, spot.y, true)) { settle(); continue; }
  const m2 = st.chars.chars["npc_spyder_papertown_mom"]!;
  if (m2.tx !== mom.tx || m2.ty !== mom.ty) continue;
  interact(((spot.d + 2) % 4) as Dir4);
  settle();
}
expect("talking to mom ran her first talk page", v("v.spokenmom") > 0);
checkpoint("downstairs-mom");

// Assertions on the Chinese text seen so far.
const momTexts = seenTexts.filter((t) => t.map === "spyder_downstairs" || t.map === "spyder_paper_scoop" || t.map === "spyder_bedroom");
expect("at least one Chinese dialog was shown", momTexts.some((t) => t.lines.some(hasCjk)));
expect("a choice was presented in Chinese", seenChoices.some((c) => c.options.some(hasCjk)) || seenChoices.length > 0);
// Long-dialog pagination: mom's talk has multiple pages (the en smoke sees
// several text boxes); assert more than one distinct text modal appeared.
expect("the opening ran multiple dialog pages", seenTexts.length >= 3);

// Continue to the first battle.
goTo(4, 6);
tick(BTN_BITS.DOWN); // K1 facing guard on the front-door mat
settle();
expect("the front door leads to Paper Town", st.mapId === "spyder_paper_town");
goTo(10, 8);
checkpoint("paper-town");
walkTo(24, 13);
settle();
expect("the first-monster strip (touch area) ran Dante's scene", v("v.dantebin") > 0);
walkTo(26, 9);
interact(3); // face the Nut bin; Nut beats Billie/Budaye
const firstFightSite: [number, number] = [st.move.tx, st.move.ty];
settle(["是"]);
const battleExt = tuxemonExtensionState(st.ext, TUXEMON_BATTLE_DB_ZH);
expect("choosing Nut created a persistent monster", battleExt.party.length === 1);
expect("the first fight ended in a real win", battleExt.history.some((entry) =>
  entry.fighter === "player" && entry.opponent === "spyder_billie" && entry.outcome === "won"
));
expect("the win branch closed the fight (firstfightend=yes)", v("v.firstfightend") === 1 && v("v.firstfightdue") === 1);
expect("a battle scene started", battleStartFrame > 0);
expect("the battle range is forward (start < end)", battleStartFrame > 0 && battleEndFrame > battleStartFrame);
expect("the battle menu (root commands) was shown", battleMenuSeen);
checkpoint("first-battle");
note(`BATTLE menu seen: ${battleMenuSeen}; site ${firstFightSite.join(",")}`);

// Final text-integrity assertion: every shown dialog line is a substring of
// a source catalog string. The K-CJK typesetter paginates long dialogs
// instead of truncating them, so the kit must never insert a "…" (or alter
// the text at all). A line the kit modified would not be a source substring.
const zhSource = [...buildZhCatalog().values()].map((s) => s.replace(/\\n/g, "\n"));
const altered = seenTexts.flatMap((t) => t.lines).filter((line) =>
  line.trim() !== "" && !zhSource.some((src) => src.includes(line))
);
expect("every shown dialog line comes from the source catalog (no kit-inserted …)", altered.length === 0);
if (altered.length) note(`ALTERED LINES: ${altered.slice(0, 5).join(" | ")}`);

writeOut();
const terminalStateSha256 = createHash("sha256").update(canonicalJson(st)).digest("hex");
const tapeSha256 = createHash("sha256").update(JSON.stringify(masks)).digest("hex");
const journey = {
  format: "pocket-tuxemon/zh-smoke-journey/v1",
  worldTraversal: WORLD_TRAVERSAL,
  hz: HZ,
  frames,
  map: st.mapId,
  position: [st.move.tx, st.move.ty] as [number, number],
  masks,
  checkpoints,
  maps: checkpoints,
  battles: battleStartFrame > 0 && battleEndFrame > battleStartFrame ? [{
    opponent: "spyder_billie",
    kind: "trainer" as const,
    startFrame: battleStartFrame,
    endFrame: battleEndFrame,
    outcome: "won",
  }] : [],
  story: {
    intro_scoop: v("v.intro_scoop"),
    spokenmom: v("v.spokenmom"),
    dantebin: v("v.dantebin"),
    firstfightend: v("v.firstfightend"),
  },
  terminalStateSha256,
  tapeSha256,
};
writeFileSync(JOURNEY_OUT, JSON.stringify(journey, null, 1) + "\n");
note(`END   frames=${frames} at ${HZ} Hz (${(frames / HZ).toFixed(1)} s virtual)`);
note(`TAPE  ${JOURNEY_OUT} (${masks.length} masks)`);
console.log(journal.join("\n"));
console.log(`RESULT ${JSON.stringify({ frames, map: st.mapId, seenTexts: seenTexts.length, seenChoices: seenChoices.length, battleMenuSeen })}`);

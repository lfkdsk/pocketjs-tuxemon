// Headless acceptance drive for the generated Spyder opening.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createSession, startSession, stepSession, tableWithBodies, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { readInlineProject, readShardedProject } from "./generated-project.ts";
import { createTuxemonSessionOptions, TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import { utilitySceneAutoplayMask } from "./scene-autoplay.ts";
import { recordingWorldTraversal } from "./gb6-journey.ts";

const PROJECT_ROOT = resolve(process.env.G6_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const OUT_DIR = resolve(process.env.G6_OUT_DIR ?? join(PROJECT_ROOT, "dist"));
const inlineProject = readInlineProject(PROJECT_ROOT);
const sharded = readShardedProject(PROJECT_ROOT);
const project = sharded.project;
const worldTraversal = recordingWorldTraversal(project, "Spyder smoke journey");
const HZ = Number(process.env.HZ ?? 60); // host rate; the kit folds 60/HZ reference ticks per frame
const OUTCOME = process.env.GB4_OUTCOME === "lose" ? "lose" : "win";
const OUTPUT_TAG = OUTCOME === "win" ? `${HZ}hz` : `lose-${HZ}hz`;
const JOURNEY_OUT = resolve(process.env.GB4_JOURNEY_OUT
  ?? join(OUT_DIR, `journey-spyder-${OUTPUT_TAG}.json`));
const sess = createSession(project, HZ, createTuxemonSessionOptions(project, worldTraversal, {
  maps: sharded.repository,
}));
let st: SessionState = startSession(project, sess);
const inlineSession = createSession(
  inlineProject,
  HZ,
  createTuxemonSessionOptions(inlineProject, worldTraversal),
);
let inlineState: SessionState = startSession(inlineProject, inlineSession);
if (canonicalJson(st) !== canonicalJson(inlineState)) {
  throw new Error("smoke: initial sharded SessionState differs from inline");
}

const DX = [0, -1, 0, 1];
const DY = [1, 0, -1, 0];
const BTN_OF: Record<Dir4, number> = { 0: BTN_BITS.DOWN, 1: BTN_BITS.LEFT, 2: BTN_BITS.UP, 3: BTN_BITS.RIGHT };
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;
const BTN_LTRIGGER = 0x0100;
const journal: string[] = [];
const masks: number[] = [];
const checkpoints: { name: string; frame: number; map: string; position: [number, number] }[] = [];
const seenTexts: { frame: number; map: string; lines: string[] }[] = [];
let frames = 0;
let lastModalKey = "";
let lastMap = st.mapId;
let prevButtons = 0;
let battleStartFrame = -1;
let battleEndFrame = -1;

function note(s: string): void {
  journal.push(`[${String(frames).padStart(5)}] ${s}`);
}

function tick(buttons = 0, edges: { confirm?: boolean; cancel?: boolean; down?: boolean; up?: boolean; left?: boolean; right?: boolean } = {}): void {
  // Record the exact PocketJS button mask that corresponds to the explicit
  // reducer edges used by this adaptive driver. Replaying these masks through
  // GameView exercises the built bundle without a second hand-authored tape.
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
  st = stepSession(sess, st, input);
  inlineState = stepSession(inlineSession, inlineState, input);
  if (canonicalJson(st) !== canonicalJson(inlineState)) {
    throw new Error(`smoke: sharded SessionState differs from inline at frame ${frames}`);
  }
  prevButtons = mask;
  masks.push(mask >>> 0);
  frames++;
  if (!sceneBefore && st.scene) battleStartFrame = frames;
  if (sceneBefore && !st.scene) battleEndFrame = frames;
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
    else if (m?.kind === "choices") note(`CHOICE [${m.options.join(" | ")}]`);
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
    // a transfer ends this beat once its fade has finished
    if (st.mapId !== startMap && !st.fade) return;
    const m = st.interp.modal;
    if (!m) {
      // let autoruns start / fades end; stop once idle for a few frames
      let idle = 0;
      while (!st.interp.modal && !st.scene && idle < 12) {
        tick();
        if (st.mapId !== startMap && !st.fade) return;
        // Blocking automatic events are parallel fibers so concurrently
        // eligible Tuxemon events can all start. Their explicit lock remains
        // the stable signal that the cutscene is still progressing through
        // waits and external movement between modal pages.
        idle = st.interp.main || st.interp.inputLocked || st.fade ? 0 : idle + 1;
        if (frames > 200000) return;
      }
      if (st.scene) continue;
      if (!st.interp.modal) return;
      continue;
    }
    if (m.kind === "text") { tick(0, { confirm: true }); tick(); continue; }
    if (m.kind === "scrollText") { tick(BTN_CONFIRM); tick(); continue; }
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

/** Cells of active playerTouch pages: the walker steps on them only as a
 *  goal. (Found the hard way: v1 drops Tuxemon's `char_facing player,down`
 *  on exit mats, so crossing a mat sideways leaves the map.) */
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

/** A wandering NPC may occupy a requested destination between route calls.
 * Let the world advance until it vacates the tile, with a deterministic
 * host-rate-scaled ceiling so a genuinely blocked target still fails. */
function waitForOpenGoal(tx: number, ty: number, map: string): boolean {
  const maxWaitFrames = Math.max(8, Math.ceil(HZ * 10));
  for (let waited = 0; blockingNpcAt(tx, ty) && waited < maxWaitFrames; waited++) {
    tick();
    if (st.mapId !== map || st.interp.modal || st.interp.main) return false;
  }
  return !blockingNpcAt(tx, ty);
}

/** Walk to a cell; stops early (returns false) when an event takes over. */
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

/** Walk to a cell, letting any event that fires on the way play out. */
function goTo(tx: number, ty: number): void {
  const map = st.mapId;
  for (let i = 0; i < 8; i++) {
    if (walkTo(tx, ty, true)) return;
    settle();
    if (st.mapId !== map) return;
  }
  throw new Error(`goTo ${tx},${ty}: kept being interrupted`);
}

/** Turn toward d (a blocked press turns in place) and press confirm. */
function interact(d: Dir4): void {
  // Direction + confirm share one host frame so a 4 Hz fold cannot let a
  // wandering NPC take 30–45 reference ticks between facing and action.
  tick(BTN_OF[d], { confirm: true });
  while (st.move.moving && !st.interp.modal && !st.interp.main) tick();
  tick();
}

function expect(what: string, ok: boolean): void {
  note(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) { writeOut(); throw new Error(`smoke: ${what}`); }
}

/** Track program without the reducer clock: a restored map mix resumes from
 * its suspended position, then advances again before this post-battle sample. */
function audioProgram(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(audioProgram);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "positionTicks")
      .map(([key, child]) => [key, audioProgram(child)]));
  }
  return value;
}

function checkpoint(name: string): void {
  checkpoints.push({ name, frame: frames - 1, map: st.mapId, position: [st.move.tx, st.move.ty] });
  note(`MARK  ${name} ${st.mapId} @${st.move.tx},${st.move.ty}`);
}

function writeOut(): void {
  writeFileSync(join(OUT_DIR, `smoke-spyder-${OUTPUT_TAG}.log`), journal.join("\n") + "\n");
}

// --- the story beats --------------------------------------------------------

note(`START ${st.mapId} @${st.move.tx},${st.move.ty}`);
settle(["Yes"]); // "Do you want to skip the intro?" -> Yes
expect("skip-intro choice transfers to the Paper Town mart", st.mapId === "spyder_paper_scoop");
settle(["Budaye", "Yes"]); // storekeeper intro; rival's monster; "are you sure?"
expect("mart intro ends back in the bedroom", st.mapId === "spyder_bedroom" && v("v.intro_scoop") > 0);
checkpoint("bedroom");
walkTo(7, 2);
settle();
expect("stairs (touch) lead downstairs", st.mapId === "spyder_downstairs");
for (let i = 0; i < 10; i++) tick(); // the fade froze the fold; let the new map's parallels run
const momOn = v("local.npc.spyder_papertown_mom") === 1;
expect("the spawn guard created mom (party empty)", momOn);
// talk to mom wherever her random walk put her
for (let tries = 0; tries < 20 && v("v.spokenmom") === 0; tries++) {
  const mom = st.chars.chars["npc_spyder_papertown_mom"];
  if (!mom) { note(`chars: ${Object.keys(st.chars.chars).join(",")} page vars: ${v("local.npc.spyder_papertown_mom")}`); for (let i = 0; i < 30; i++) tick(); continue; }
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
goTo(3, 6);
for (let i = 0; i < 120; i++) {
  const mom = st.chars.chars["npc_spyder_papertown_mom"];
  if (mom && !mom.moving && mom.phase === 0) break;
  tick();
}
checkpoint("downstairs-mom");
goTo(4, 6);
tick(BTN_BITS.DOWN); // K1 facing guard on the front-door mat
settle();
expect("the front door leads to Paper Town", st.mapId === "spyder_paper_town");
goTo(10, 8);
checkpoint("paper-town");
walkTo(24, 13);
settle();
expect("the first-monster strip (touch area) ran Dante's scene", v("v.dantebin") > 0);
if (OUTCOME === "win") {
  walkTo(26, 9);
  interact(3); // face the Nut bin; Nut beats Billie/Budaye for every scout seed
} else {
  walkTo(21, 9);
  interact(3); // face the Rockitten bin; Rockitten loses to Billie/Budaye
}
const firstFightSite: [number, number] = [st.move.tx, st.move.ty];
settle(["Yes"]);
const battleExt = tuxemonExtensionState(st.ext, TUXEMON_BATTLE_DB);
const expectedHistory = OUTCOME === "win" ? "won" : "lost";
expect(`choosing ${OUTCOME === "win" ? "Nut" : "Rockitten"} created a persistent monster`, battleExt.party.length === 1);
expect(`the first fight ended in a real ${expectedHistory}`, battleExt.history.some((entry) =>
  entry.fighter === "player" && entry.opponent === "spyder_billie" && entry.outcome === expectedHistory
));
if (OUTCOME === "lose") {
  const recovered = tuxemonExtensionState(st.ext, TUXEMON_BATTLE_DB).party[0];
  note(`FIRST-LOSS ${st.mapId} @${st.move.tx},${st.move.ty} hp=${recovered?.currentHp}/${recovered?.base.hp}`);
  expect("First Fight - Lose stayed in Paper Town", st.mapId === "spyder_paper_town");
  expect(
    "First Fight - Lose healed Rockitten",
    recovered !== undefined && recovered.currentHp === recovered.base.hp,
  );
  expect("First Fight - Lose returned control at the fight site",
    st.move.tx === firstFightSite[0] && st.move.ty === firstFightSite[1]);
  const loseDialogs = seenTexts.filter((entry) => entry.lines.includes("As expected! Old models can't compare to new ones!"));
  const afterDialogs = seenTexts.filter((entry) => entry.lines.join(" ") ===
    "I'll heal you up this time, but I'm not a charity. Rest up at home next time your monsters get worn out.");
  const faintNotices = seenTexts.filter((entry) => entry.lines.includes("You should heal your monsters before heading off."));
  expect("First Fight - Lose was shown exactly once after battle exit", loseDialogs.length === 1 &&
    loseDialogs[0]!.map === "spyder_paper_town" && loseDialogs[0]!.frame > battleEndFrame);
  expect("the first-loss after-dialog was shown exactly once", afterDialogs.length === 1 &&
    afterDialogs[0]!.map === "spyder_paper_town" && afterDialogs[0]!.frame > loseDialogs[0]!.frame);
  expect("Teleport Faint stayed suppressed during the first-loss cutscene", faintNotices.length === 0);
}
expect(`the ${OUTCOME} branch closed the fight (firstfightend=no)`, v("v.firstfightend") === 1 && v("v.firstfightdue") === 1);
let requested = "";
try {
  goTo(14, 1);
  settle();
  expect("the overlapping Paper Town strip kept mom's quest", v("v.momquest") > 0);
  // The quest's NPC approach may leave the player on either side of this
  // two-cell strip. Re-center below the opening, then turn north on its edge
  // so the direct playerTouch page and the handoff validate the same facing.
  goTo(14, 1);
  goTo(14, 0);
  tick(BTN_BITS.UP);
  settle();
} catch (e) {
  requested = String(e);
}
expect(`the Route 1 exit opens after the fight (${requested || st.mapId})`, st.mapId === "spyder_route1");
checkpoint("route-1");
expect("the journey entered and completed Battle Processing", battleStartFrame > 0 && battleEndFrame > battleStartFrame);

// Replay the exact host-rate tape through the product rewind controller.
// Rewind just after the battle back into its middle, then replay the retained
// suffix. Both boundary crossings and the game-owned extension state must
// recover byte-for-byte.
const attractOptions = {
  hz: HZ,
  attractEnabled: false,
  ...createTuxemonSessionOptions(inlineProject, worldTraversal),
} as const;
const baseline = new AttractController(inlineProject, [], {
  ...attractOptions,
  rewindSeconds: 1 / HZ,
});
baseline.startPlay();
const rewindTarget = Math.floor((battleStartFrame + battleEndFrame) / 2);
let rewindTargetState = "";
for (let frame = 0; frame < masks.length; frame++) {
  baseline.step(masks[frame]!);
  if (frame + 1 === rewindTarget) rewindTargetState = canonicalJson(baseline.state);
}
expect("the recorded tape replays to the reducer-identical result", canonicalJson(baseline.state) === canonicalJson(st));

const rewindAt = Math.min(masks.length, battleEndFrame + Math.max(2, Math.ceil(HZ / 5)));
const rewound = new AttractController(inlineProject, [], {
  ...attractOptions,
  rewindSeconds: (rewindAt - rewindTarget) / HZ,
});
rewound.startPlay();
for (let frame = 0; frame < rewindAt; frame++) rewound.step(masks[frame]!);
const mapAudioBeforeRewind = canonicalJson(rewound.state.interp.audio ?? null);
rewound.step(BTN_LTRIGGER);
expect("L rewind crossed back into the active battle", rewound.state.scene?.kind === "battle");
expect("L rewind restored the imported battle cue",
  rewound.state.interp.audio?.bgm?.id === "music_battle_loop");
expect("L rewind retained the suspended map mix program",
  rewound.state.scene?.kind === "battle" &&
  canonicalJson(audioProgram(rewound.state.scene.returnAudio ?? null)) ===
    canonicalJson(audioProgram(JSON.parse(mapAudioBeforeRewind))));
expect("L rewind restored the reducer-identical active battle state",
  canonicalJson(rewound.state) === rewindTargetState);
let replayedResultCue = false;
for (let frame = rewindTarget; frame < masks.length; frame++) {
  rewound.step(masks[frame]!);
  if (rewound.state.interp.audio?.bgm?.id ===
    (OUTCOME === "win" ? "music_win_battle_boss" : "music_gameover")) {
    replayedResultCue = true;
  }
}
expect(`replaying after L rewind projected the ${OUTCOME} result cue`, replayedResultCue);
expect("replaying after L rewind restores the identical result", canonicalJson(rewound.state) === canonicalJson(baseline.state));

note(`END   frames=${frames} at ${HZ} Hz (${(frames / HZ).toFixed(1)} s virtual)`);
writeOut();
console.log(journal.join("\n"));
const tapeDigest = createHash("sha256").update(JSON.stringify(masks)).digest("hex");
const result = {
  ...(OUTCOME === "lose" ? { format: "pocket-tuxemon/gb6-first-loss/v1" } : {}),
  worldTraversal,
  hz: HZ,
  frames,
  map: st.mapId,
  position: [st.move.tx, st.move.ty],
  checkpoints,
  masks,
  rewind: { target: rewindTarget, from: rewindAt, restored: true },
  story: {
    intro_scoop: v("v.intro_scoop"),
    spokenmom: v("v.spokenmom"),
    dantebin: v("v.dantebin"),
    firstfightend: v("v.firstfightend"),
    firstfightdue: v("v.firstfightdue"),
    party_size: tuxemonExtensionState(st.ext, TUXEMON_BATTLE_DB).party.length,
    billie_result: expectedHistory,
    billie_won: st.sw.switches["bo.spyder_billie.won"] === true,
    billie_lost: st.sw.switches["bo.spyder_billie.lost"] === true,
  },
  ...(OUTCOME === "lose" ? { tapeSha256: tapeDigest } : {}),
};
const stateDigest = createHash("sha256").update(canonicalJson(st)).digest("hex");
const payload = { ...result, terminalStateSha256: stateDigest };
const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
writeFileSync(JOURNEY_OUT, JSON.stringify({ ...payload, sha256: digest }, null, 2) + "\n");
console.log(`STATE sha256=${stateDigest} (inline=sharded every frame)`);
console.log("RESULT " + JSON.stringify({
  hz: result.hz,
  frames: result.frames,
  map: result.map,
  position: result.position,
  checkpoints: result.checkpoints,
  story: result.story,
  sha256: digest,
}));

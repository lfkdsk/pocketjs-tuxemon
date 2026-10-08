// PSP save/load end-to-end verification logic, split out from the
// tools/verify-psp-save.ts CLI so the phases can be unit-tested with fake
// build/run deps (the real thing needs PPSSPPHeadless and the PSP SDK).
//
// Four phases, each a separate --journey-tape build + emulator run:
//
//   1. save      boot, open the START menu, save to slot 1, log the state.
//   2. load      boot with the same memstick, load slot 1, log the state.
//                The two logged states must be field-by-field identical.
//   3. autosave  replay the opening (crosses the Paper Town autosave point),
//                then a second run loads the Automatic Save row and continues.
//                Same caliber as the manual phase: the state logged at the
//                autosave point and the state restored after restart must be
//                field-by-field identical (minus the host frame counter and
//                the one-frame hostActions queue).
//   4. failure   a read-only memstick makes the save fail visibly: the menu
//                shows a SAVE FAILED message, the run completes (no crash)
//                and no slot file is written.
//
// The save menu is driven by button masks (--journey-tape), so the same
// code path a player uses runs under the emulator.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../../vendor/pocket-rpgkit/src/engine/save.ts";
import type { SessionState } from "../../vendor/pocket-rpgkit/src/engine/session.ts";

const PSP_SAVE_MAGIC = new TextEncoder().encode("PJSAVE1\n");
const PSP_SAVE_HEADER_BYTES = 16;
const PSP_SAVE_MAX_PAYLOAD = 1 << 20;

function fnv1aBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Decode one physical file written by the PSP host. New saves carry the
 * host's exact-length/FNV record; complete raw JSON remains readable for
 * memory sticks written before that record format existed. */
export function decodePspSaveRecord(bytes: Uint8Array): string {
  const framed = bytes.length >= PSP_SAVE_MAGIC.length
    && PSP_SAVE_MAGIC.every((byte, index) => bytes[index] === byte);
  let payload = bytes;
  if (framed) {
    if (bytes.length < PSP_SAVE_HEADER_BYTES) throw new Error("truncated PSP save header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(8, true);
    const checksum = view.getUint32(12, true);
    if (length > PSP_SAVE_MAX_PAYLOAD || bytes.length !== PSP_SAVE_HEADER_BYTES + length) {
      throw new Error("invalid PSP save length");
    }
    payload = bytes.subarray(PSP_SAVE_HEADER_BYTES);
    if (fnv1aBytes(payload) !== checksum) throw new Error("invalid PSP save checksum");
  } else if (
    bytes.length > PSP_SAVE_MAX_PAYLOAD
    || bytes[0] !== 0x7b
    || bytes[bytes.length - 1] !== 0x7d
  ) {
    throw new Error("invalid legacy PSP save");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

/** A tape: masks per frame, plus the frame at which to log the live state
 *  (right after the save/load the phase is interested in). */
export interface Tape {
  masks: number[];
  logAt: number;
  label: string;
}

/** A parsed profile.jsonl entry. The marked/terminal kinds carry the live
 *  session state; marked also carries the save menu state (null when the
 *  save menu hook is absent or closed). */
export interface LogEntry {
  kind?: string;
  frame?: number;
  state?: SessionState;
  menu?: MenuStateShape | null;
  [key: string]: unknown;
}

/** The subset of the kit's MenuState the failure phase asserts on. */
export interface MenuStateShape {
  kind: string;
  title?: string;
  body?: string;
}

/** Everything a phase needs, injectable so tests can fake the emulator. */
export interface PspSaveVerifyDeps {
  /** Build a journey-tape PSP bundle (real: bun run build:psp). */
  build(tape: Tape): void;
  /** Run the PRX under PPSSPP, return the parsed profile log. */
  run(phase: string, memstick: string): LogEntry[];
  /** Memstick root (contains PSP/COMMON/pocketjs/save/). */
  memstick: string;
  /** Work dir for the saved-state artifact. */
  work: string;
  /** Host frame of the opening's autosave point. */
  autosaveFrame: number;
  /** Remove the memstick's PSP tree so a phase starts from a clean stick. */
  cleanMemstick(): void;
  /** Run fn with the save dir read-only, then restore it. */
  withReadOnlySaveDir(fn: () => void): void;
  /** Read and unwrap a logical save relative to the save dir, falling back
   * to its validated backup, or return null when both copies are absent. */
  readSaveFile(rel: string): string | null;
  /** Whether a save file relative to the save dir exists. */
  saveFileExists(rel: string): boolean;
}

/** The documented phases. `all` runs every one of them. */
export const PHASES = ["save", "load", "autosave", "failure"] as const;
export type Phase = (typeof PHASES)[number] | "all";

/** The opening tape plays through the bedroom intro question and the Paper
 *  Scoop storekeeper dialogs; a prefix of it leaves the player in Paper
 *  Town at a safe save point. Both the save and load tapes start from this
 *  prefix so they reach the same pre-menu state. */
export const OPENING_PREFIX = 1406;

// Button masks (framework input bits).
const START = 0x0008;
const DOWN = 0x0040;
const CIRCLE = 0x2000;

/** Press one button for one frame, then release for `gap` frames. */
function press(masks: number[], button: number, gap = 8): void {
  masks.push(button);
  for (let i = 0; i < gap; i++) masks.push(0);
}

export function openingMasks(): number[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const journey = JSON.parse(readFileSync(join(import.meta.dir, "../../data/g6-journey.json"), "utf8")) as { masks: number[] };
  return journey.masks.slice(0, OPENING_PREFIX);
}

function fullOpeningMasks(): number[] {
  const journey = JSON.parse(readFileSync(join(import.meta.dir, "../../data/g6-journey.json"), "utf8")) as { masks: number[] };
  return journey.masks;
}

/** Boot settle, dismiss the bedroom intro question (answer "yes" to skip the
 *  intro, which teleports to Paper Scoop), then open the START menu. Returns
 *  the masks so far. */
function bootAndOpenMenu(): number[] {
  const masks = openingMasks();
  // The opening prefix ends mid-Paper-Town; a few zero frames let any last
  // dialog settle before the menu opens.
  for (let i = 0; i < 30; i++) masks.push(0);
  press(masks, START, 10); // open the save menu
  return masks;
}

export function saveTape(): Tape {
  const masks = bootAndOpenMenu();
  press(masks, CIRCLE, 8); // root row 0: Save to slot
  // The save executes on this CIRCLE; logAt is the next frame so the logged
  // state is the snapshot (the world stays paused while the menu is open).
  masks.push(CIRCLE);
  return { masks, logAt: masks.length, label: "save" };
}

export function loadTape(): Tape {
  const masks = bootAndOpenMenu();
  press(masks, DOWN, 8); // root row 1: Load from slot
  press(masks, CIRCLE, 8); // slots-load page (row 0 = slot 1, no autosave yet)
  // The load executes on this CIRCLE and closes the menu; logAt is the next
  // frame, before the world advances, so the logged state is the restored
  // snapshot.
  masks.push(CIRCLE);
  return { masks, logAt: masks.length, label: "load" };
}

/** The opening tape crosses the Paper Town autosave point; log the state at
 *  that frame so it can be compared with the restored state after restart. */
export function autosaveTriggerTape(autosaveFrame: number): Tape {
  return { masks: fullOpeningMasks(), logAt: autosaveFrame, label: "autosave-trigger" };
}

export function autosaveContinueTape(): Tape {
  const masks = bootAndOpenMenu();
  press(masks, DOWN, 8); // root row 1: Load from slot
  press(masks, CIRCLE, 8); // slots-load page (row 0 = Automatic Save)
  // The autosave load executes on this CIRCLE and closes the menu; logAt is
  // the next frame, before the world advances.
  masks.push(CIRCLE);
  return { masks, logAt: masks.length, label: "autosave-continue" };
}

/** Same as the save tape; the failure is injected by a read-only memstick. */
export function failureTape(): Tape {
  return saveTape();
}

// --- state comparison --------------------------------------------------------

/** Compare two session states for save/load identity. The top-level `frame`
 *  is the host frame counter, not reducer state: the snapshot carries
 *  `interp.frame` (the reducer clock), and the restore sets the host frame
 *  from it, so the two runs legitimately differ there (the same normalization
 *  verify:save uses). `interp.hostActions` is a one-frame host output queue
 *  (the autosave request itself); the snapshot normalizes it away, so the
 *  autosave phase strips it too. Everything else must be field-by-field
 *  identical. */
export function digestsEqual(a: unknown, b: unknown, stripHostActions = false): boolean {
  const strip = (s: unknown) => {
    const copy = { ...(s as Record<string, unknown>) };
    delete copy.frame;
    if (stripHostActions) {
      const interp = { ...((copy.interp as Record<string, unknown>) ?? {}) };
      delete interp.hostActions;
      copy.interp = interp;
    }
    return copy;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

/** A short human-readable summary of a session state, for the report. */
function summarize(state: SessionState): string {
  const move = state.move as { tx?: number; ty?: number } | undefined;
  return `map=${state.mapId} pos=[${move?.tx},${move?.ty}] frame=${(state.interp as { frame?: number })?.frame}`;
}

export function stateFromLog(entries: LogEntry[], kind: "marked" | "terminal"): SessionState {
  const entry = entries.find((e) => e.kind === kind);
  if (!entry || !entry.state) throw new Error(`no ${kind} log entry with a state`);
  return entry.state;
}

export function menuFromMarked(entries: LogEntry[]): MenuStateShape | null {
  const entry = entries.find((e) => e.kind === "marked");
  if (!entry) throw new Error("no marked log entry");
  return entry.menu ?? null;
}

// --- phases ------------------------------------------------------------------

const SAVED_ARTIFACT = "saved-state.json";

/** The save half: boot, save to slot 1, log the state and the slot file.
 *  Writes the saved state to an artifact so a later load phase can compare
 *  without re-running the save. Returns the saved state. */
function runSaveHalf(deps: PspSaveVerifyDeps): SessionState {
  console.log("\n--- save: boot -> save to slot 1 ---");
  deps.cleanMemstick();
  deps.build(saveTape());
  const log = deps.run("save", deps.memstick);
  const saved = stateFromLog(log, "marked");
  if (!deps.saveFileExists("save/slot-1.json")) {
    throw new Error("save/slot-1.json was not written to the memstick");
  }
  const bytes = deps.readSaveFile("save/slot-1.json") ?? "";
  console.log(`# saved: ${summarize(saved)} (${bytes.length} bytes in slot-1.json)`);
  return saved;
}

/** The load half: boot with the same memstick, load slot 1, compare. */
function runLoadHalf(deps: PspSaveVerifyDeps, saved: SessionState): void {
  console.log("\n--- load: boot -> load slot 1 -> compare ---");
  deps.build(loadTape());
  const log = deps.run("load", deps.memstick);
  const loaded = stateFromLog(log, "marked");
  console.log(`# loaded: ${summarize(loaded)}`);
  if (!digestsEqual(saved, loaded)) {
    throw new Error("save/load state mismatch: the loaded state differs from the saved state");
  }
  console.log("# PASS: loaded state is field-by-field identical to the saved state");
}

export function phaseSave(deps: PspSaveVerifyDeps): void {
  const saved = runSaveHalf(deps);
  // Persist the saved state so a standalone --phase=load can compare against
  // the exact bytes this phase saved.
  writeFileSync(join(deps.work, SAVED_ARTIFACT), JSON.stringify(saved));
}

export function phaseLoad(deps: PspSaveVerifyDeps): void {
  // A load needs a slot; run the save half first so the phase is
  // self-contained, unless a previous save phase left its artifact.
  const artifact = join(deps.work, SAVED_ARTIFACT);
  let saved: SessionState;
  if (existsSync(artifact)) {
    saved = JSON.parse(readFileSync(artifact, "utf8")) as SessionState;
  } else {
    saved = runSaveHalf(deps);
  }
  runLoadHalf(deps, saved);
}

export function phaseAutosave(deps: PspSaveVerifyDeps): void {
  console.log("\n=== autosave point -> restart -> continue ===");
  deps.cleanMemstick();
  deps.build(autosaveTriggerTape(deps.autosaveFrame));
  const triggerLog = deps.run("autosave-trigger", deps.memstick);
  const atAutosave = stateFromLog(triggerLog, "marked");
  const envelopeText = deps.readSaveFile("save/autosave.json");
  if (envelopeText === null) {
    throw new Error("save/autosave.json was not written (the opening crossed no autosave point?)");
  }
  const envelope = JSON.parse(envelopeText) as { frame?: number };
  console.log(`# autosave written: ${summarize(atAutosave)} (${envelopeText.length} bytes)`);
  // Guard: the marked state must be the autosave point itself. If the tape
  // shifted, the logged frame is no longer the autosave frame.
  const markedClock = (atAutosave.interp as { frame?: number })?.frame;
  if (envelope.frame !== undefined && markedClock !== envelope.frame) {
    throw new Error(
      `autosave frame drift: logged state interp.frame=${String(markedClock)} but autosave.json frame=${String(envelope.frame)}`,
    );
  }

  deps.build(autosaveContinueTape());
  const continueLog = deps.run("autosave-continue", deps.memstick);
  const continued = stateFromLog(continueLog, "marked");
  console.log(`# continued from autosave: ${summarize(continued)}`);
  // Same caliber as the manual phase: the state at the autosave point and the
  // restored state must be field-by-field identical (minus the host frame and
  // the one-frame hostActions queue the snapshot normalizes away).
  if (!digestsEqual(atAutosave, continued, true)) {
    throw new Error("autosave state mismatch: the continued state differs from the autosave point");
  }
  if (continued.mapId === "spyder_bedroom") {
    throw new Error("autosave continue restored the boot bedroom, not the autosave point");
  }
  console.log("# PASS: the Automatic Save row restores the autosave point, field-by-field");
}

export function phaseFailure(deps: PspSaveVerifyDeps): void {
  console.log("\n=== read-only memstick -> visible save failure ===");
  deps.cleanMemstick();
  let log: LogEntry[] = [];
  deps.withReadOnlySaveDir(() => {
    deps.build(failureTape());
    log = deps.run("failure", deps.memstick);
  });
  // The run must complete (the failed save is handled, not a crash) and no
  // slot file may appear.
  const terminal = stateFromLog(log, "terminal");
  if ((terminal.interp as { error?: unknown })?.error !== undefined) {
    throw new Error("the save failure crashed the game (interp.error is set)");
  }
  if (deps.saveFileExists("save/slot-1.json")) {
    throw new Error("slot-1.json appeared despite the read-only memstick");
  }
  // The save menu must show the failure, not a silent success.
  const menu = menuFromMarked(log);
  if (!menu || menu.kind !== "message" || menu.title !== "SAVE FAILED") {
    throw new Error(`the save did not fail visibly (menu=${JSON.stringify(menu)})`);
  }
  console.log("# PASS: the save failed visibly (SAVE FAILED menu, no file, no crash)");
}

/** Dispatch a phase by name. Unknown phases throw instead of silently
 *  passing (the dispatcher once had no `load` branch, so --phase=load printed
 *  ALL PHASES PASS without running anything). */
export function runPhase(phase: string, deps: PspSaveVerifyDeps): void {
  switch (phase) {
    case "save":
      phaseSave(deps);
      return;
    case "load":
      phaseLoad(deps);
      return;
    case "autosave":
      phaseAutosave(deps);
      return;
    case "failure":
      phaseFailure(deps);
      return;
    case "all":
      phaseSave(deps);
      phaseLoad(deps);
      phaseAutosave(deps);
      phaseFailure(deps);
      return;
    default:
      throw new Error(`unknown phase ${JSON.stringify(phase)} (expected one of: ${PHASES.join(", ")}, all)`);
  }
}

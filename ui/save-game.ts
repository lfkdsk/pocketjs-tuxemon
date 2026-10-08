// Save and load for the running game, kept free of JSX so tests and the
// headless verifiers use exactly the code the menu runs.
//
// A save is the kit's checksummed envelope (engine/save.ts) over the whole
// reducer state: map, player, interpreter banks and fibers, screen layers,
// audio intent and the game extension state (party, kennel, clock, weather,
// battle history). Three storage channels share that one envelope:
//
//   - desktop (data.fs mounted): save/slot-N.json through the kit's fs store
//   - browser (localStorage reachable from the game bundle): three slots
//     under "pocket-tuxemon/save/slot-N"
//   - everywhere: the URL-safe save code, exported and imported in the menu
//
// The sharded production session passes `session.content`, so a save from
// another build (other map manifest or schema) is rejected on load.
//
// The kit's snapshot carries the current map's runtime (character cells,
// facing, routes, the wander RNG, a player route and a fade-in), so an NPC
// an event walked or turned stays where it was. Saves written before the kit
// stored it kept the character table in the game's extension slot instead
// ({format: LEGACY_SAVE_EXT_FORMAT, ext, chars}); restoreSave() migrates
// them to the kit's map runtime, and the Tuxemon codec also accepts the
// wrapper, so a generic kit restore still loads such a save (without the
// table).

import {
  canSave,
  createSessionSnapshot,
  decodeEnvelopeText,
  decodeSaveCode,
  encodeSaveCode,
  loadFromStore,
  SaveError,
  saveToStore,
  summarizeEnvelope,
  type SaveSnapshot,
  type SaveStore,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { validateSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-validate.ts";
import type { CharsState } from "../vendor/pocket-rpgkit/src/engine/chars.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { isBusy } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { MapContentIdentity } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { SAVE_MENU_UI_TEXT } from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";
import type { Session, SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { withUiText, type UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import {
  hasFsSave,
  inspectAutosaveFs,
  loadAutosaveFs,
  saveAutosaveFs,
  fsSaveStore,
  type FsSlotInfo,
} from "../vendor/pocket-rpgkit/src/host/save-fs.ts";
import {
  autosaveBridge,
  inspectAutosaveHost,
  loadAutosaveHost,
  writeAutosaveHost,
  type AutosaveSlotStatus,
} from "../vendor/pocket-rpgkit/src/host/autosave.ts";
import { pspSaveHost, pspSaveStore } from "./save-psp.ts";

export const SAVE_SLOTS = 3;
export const BROWSER_SAVE_KEY_PREFIX = "pocket-tuxemon/save/slot-";

export type SlotListing = (FsSlotInfo | { slot: number; error: string } | null)[];

/** Where slot saves live on this target. */
export type SaveChannel = "desktop" | "browser" | "psp";

export interface SlotStore {
  readonly channel: SaveChannel;
  readonly store: SaveStore;
}

export type AutosaveChannel = "desktop" | "browser" | "psp";
export type AutosaveListing = AutosaveSlotStatus | FsSlotInfo | { slot: 0; error: string };

/** The subset of the Web Storage API the browser channel needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Thrown when the current moment is not a save point. The message is the
 * player-facing reason. */
export class SaveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveRefused";
  }
}

/**
 * Why the game cannot be saved right now, or null at a save point. The kit's
 * canSave() is the authority; the extra input-lock and fade checks match the
 * chapter snapshots, so a save never lands inside a scripted scene or a
 * screen transition. Reasons are short enough for one menu line.
 */
export function saveBlockReason(
  state: Readonly<SessionState>,
  uiText?: UiTextOverrides,
): string | null {
  const text = withUiText(SAVE_MENU_UI_TEXT, uiText);
  const interp = state.interp;
  if (interp.error !== undefined) return text["save.refusedEventError"];
  if (state.scene !== null || interp.pendingBattles.length > 0) return text["save.refusedBattle"];
  if (interp.modal !== null) return text["save.refusedConversation"];
  if (interp.pendingTransfer !== null || state.fade !== null) return text["save.refusedMapChange"];
  if (interp.inputLocked || isBusy(interp) && interp.main?.mode !== "screenWait") {
    return text["save.refusedScene"];
  }
  if (state.move.moving || state.move.phase !== 0) return text["save.refusedWalking"];
  // Queued move routes or placements: an event is still arranging actors.
  if (!canSave(state.move, interp, state.scene)) return text["save.refusedScene"];
  return null;
}

/** The extension-slot wrapper of saves written before the kit's snapshot
 * carried the map runtime. Only read, never written. */
export const LEGACY_SAVE_EXT_FORMAT = "pocket-tuxemon/save-ext/v1";

interface LegacySavedExt {
  format: typeof LEGACY_SAVE_EXT_FORMAT;
  ext: JsonValue;
  chars: CharsState;
}

/** True when a saved `ext` is the old wrapper around the extension state and
 * the character table. */
export function isLegacySaveExt(value: unknown): value is LegacySavedExt {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as { format?: unknown }).format === LEGACY_SAVE_EXT_FORMAT;
}

/** Snapshot the session for saving, or throw SaveRefused off a save point.
 * `held` is the button mask folded on the save frame; a load uses it as the
 * previous mask so press edges continue exactly as they would have. */
export function takeSaveSnapshot(
  session: Session,
  state: SessionState,
  held: number,
  uiText?: UiTextOverrides,
): SaveSnapshot {
  const reason = saveBlockReason(state, uiText);
  if (reason !== null) throw new SaveRefused(reason);
  return createSessionSnapshot(session, state, held >>> 0);
}

/** Rewrite an old wrapped save into the kit's form: the extension state goes
 * back into `ext` and the character table becomes the map runtime. The old
 * menu only saved with no player route, fade or path search running, so
 * those are empty. Other snapshots are returned unchanged. */
export function migrateLegacySave(snapshot: SaveSnapshot): SaveSnapshot {
  if (!isLegacySaveExt(snapshot.ext) || snapshot.mapRuntime !== undefined) return snapshot;
  const saved = snapshot.ext;
  const migrated: SaveSnapshot = {
    ...snapshot,
    ext: saved.ext,
    mapRuntime: { chars: saved.chars, playerRoute: null, fade: null },
  };
  const problem = validateSnapshot(migrated);
  if (problem !== null) throw new SaveError("shape", `save character table is invalid: ${problem}`);
  return migrated;
}

/** Rebuild reducer state from a decoded save (acquires an evicted map). Old
 * wrapped saves are migrated first; the kit restores the map runtime, or
 * rebuilds the characters from the map for a snapshot without one. */
export function restoreSave(session: Session, snapshot: SaveSnapshot): SessionState {
  return restoreSessionSnapshot(session, migrateLegacySave(snapshot));
}

export function exportSaveCode(session: Session, snapshot: SaveSnapshot): string {
  return encodeSaveCode(snapshot, session.content);
}

export function importSaveCode(session: Session, code: string): SaveSnapshot {
  return decodeSaveCode(code, session.content);
}

function slotKey(slot: number): string {
  return `${BROWSER_SAVE_KEY_PREFIX}${slot}`;
}

/** Three save slots over a Web Storage object. */
export function browserSaveStore(storage: StorageLike): SaveStore {
  return {
    exists: (slot) => storage.getItem(slotKey(slot)) !== null,
    read: (slot) => storage.getItem(slotKey(slot)),
    write: (slot, envelope) => storage.setItem(slotKey(slot), envelope),
    remove: (slot) => storage.removeItem(slotKey(slot)),
  };
}

function reachableStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;
    // Private modes can expose the object but refuse writes; probe once.
    const probe = `${BROWSER_SAVE_KEY_PREFIX}probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** Slot storage for this target: data.fs first, then the PSP memory stick,
 * then browser storage, else null (the save code is then the only channel). */
export function detectSlotStore(): SlotStore | null {
  const fs = fsSaveStore();
  if (fs) return { channel: "desktop", store: fs };
  const psp = pspSaveStore();
  if (psp) return { channel: "psp", store: psp };
  const storage = reachableStorage();
  return storage ? { channel: "browser", store: browserSaveStore(storage) } : null;
}

/** Dedicated automatic-save channel. Desktop uses data.fs, the PSP uses its
 * memory-stick bridge, and the generated web player installs the app-scoped
 * browser bridge. A target with none of the three treats the command as a
 * quiet no-op. */
export function detectAutosaveChannel(): AutosaveChannel | null {
  if (hasFsSave()) return "desktop";
  if (pspSaveHost()) return "psp";
  return autosaveBridge() ? "browser" : null;
}

/** Persist an engine-owned recoverable autosave without entering a numbered
 * manual slot. False means this target has no channel or storage refused it. */
export function persistAutosave(
  snapshot: Readonly<SaveSnapshot>,
  content: MapContentIdentity | null,
): boolean {
  if (hasFsSave()) {
    try {
      saveAutosaveFs(snapshot as SaveSnapshot, content);
      return true;
    } catch (error) {
      globalThis.console?.debug?.("pocket-tuxemon: desktop autosave write failed", error);
      return false;
    }
  }
  return writeAutosaveHost(snapshot, content);
}

/** Decode the target's automatic slot. Passing null peeks without applying
 * the content identity, used to show a language mismatch before build skew. */
export function loadAutosaveSlot(content: MapContentIdentity | null): SaveSnapshot | null {
  return hasFsSave() ? loadAutosaveFs(content) : loadAutosaveHost(content);
}

/** Menu summary of the read-only automatic slot, including visible damage. */
export function inspectAutosaveSlot(content: MapContentIdentity | null): AutosaveListing {
  return hasFsSave() ? inspectAutosaveFs(content) : inspectAutosaveHost(content);
}

export function saveSlot(
  slots: SlotStore,
  slot: number,
  snapshot: SaveSnapshot,
  content: MapContentIdentity | null,
): void {
  saveToStore(slots.store, slot, snapshot, content);
}

export function loadSlot(slots: SlotStore, slot: number, content: MapContentIdentity | null): SaveSnapshot {
  return loadFromStore(slots.store, slot, content);
}

/** Decode a slot skipping content identity. The load path peeks at the
 *  save's language here first, so a save from the other language build is
 *  reported as a language mismatch instead of failing the content check. */
export function peekSlot(slots: SlotStore, slot: number): SaveSnapshot {
  return loadFromStore(slots.store, slot, null);
}

/** Decode a save code skipping content identity, for the same language
 *  pre-check as peekSlot. */
export function peekSaveCode(code: string): SaveSnapshot {
  return decodeSaveCode(code, null);
}

/** Menu summaries of the three slots. Each file runs the full load
 *  validation, so a damaged or foreign save lists as an error, not a slot.
 *  A save from the other language build is intact but foreign: it lists
 *  with its real summary (selecting it shows the language mismatch prompt)
 *  instead of a raw content-manifest error. */
export function listSlots(
  slots: SlotStore | null,
  content: MapContentIdentity | null,
  lang: "en_US" | "zh_CN" = "en_US",
): SlotListing {
  const out: SlotListing = [];
  for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
    if (!slots) {
      out.push(null);
      continue;
    }
    let text: string | null;
    try {
      text = slots.store.read(slot);
    } catch (error) {
      out.push({ slot, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (text === null) {
      out.push(null);
      continue;
    }
    try {
      out.push(summarizeEnvelope(slot, text, content));
    } catch (error) {
      if (error instanceof SaveError && error.code === "content") {
        // Same bytes, other language build: list the real summary so the
        // player can pick the slot and get the mismatch prompt.
        try {
          const peeked = decodeEnvelopeText(text, null);
          if (snapshotLang(peeked) !== lang) {
            out.push(summarizeEnvelope(slot, text, null));
            continue;
          }
        } catch { /* not a language mismatch: fall through to the error */ }
      }
      out.push({ slot, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** The language a save was written with, read from its encoded extension
 *  envelope. Saves written before the language was recorded default to
 *  en_US (the game was English-only then). */
export function snapshotLang(snapshot: SaveSnapshot): "en_US" | "zh_CN" {
  const ext = snapshot.ext as { format?: unknown; lang?: unknown } | null;
  const lang = ext && typeof ext === "object" ? ext.lang : undefined;
  return lang === "zh_CN" ? "zh_CN" : "en_US";
}

/** One-line, player-facing explanation of a failed load. */
export function describeLoadError(error: unknown, uiText?: UiTextOverrides): string {
  const text = withUiText(SAVE_MENU_UI_TEXT, uiText);
  if (error instanceof SaveError) {
    switch (error.code) {
      case "content":
        return text["save.loadErrorContent"];
      case "checksum":
        return text["save.loadErrorChecksum"];
      case "version":
        return text["save.loadErrorVersion"];
      case "bad-json":
      case "format":
        return text["save.loadErrorInvalid"];
      case "shape":
        return text["save.loadErrorShape"];
    }
  }
  return text["save.loadErrorRead"];
}

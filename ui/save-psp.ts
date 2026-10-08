// PSP memory-stick save bridge over the host's __pspSave FFI.
//
// The PSP host (vendor pocketjs hosts/psp/src/save.rs) exposes three
// synchronous ops rooted at ms0:/PSP/COMMON/pocketjs/save/: read a file as
// UTF-8 text (null when absent), atomically replace one (a framed/checksummed
// .tmp is synced and validated before it replaces the live file, with the
// previous valid generation retained as .bak), and remove one. Writes are
// bounded to 1 MiB and failures
// throw, so the save menu can show "SAVE FAILED" instead of dropping the
// save. The host mounts no fs module on PSP and the build has no
// localStorage, so this is the only writable channel there.
//
// The ops are synchronous, so the store implements the same sync SaveStore
// port as the desktop and browser channels: a save menu read or write
// completes inside the frame that asked for it.

import {
  slotPath,
  type SaveStore,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { AUTOSAVE_FS_PATH } from "../vendor/pocket-rpgkit/src/host/save-fs.ts";
import type { AutosaveBridge } from "../vendor/pocket-rpgkit/src/host/autosave.ts";

/** The host's save bridge. Registered by the PSP host on every build;
 *  absent on every other target. `read` returns null for a missing file and
 *  throws on an I/O failure; `write`/`remove` throw on failure. */
export interface PspSaveHost {
  read(path: string): string | null | undefined;
  write(path: string, data: string): unknown;
  remove(path: string): unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __pspSave: PspSaveHost | undefined;
}

/** The host bridge when the running target registered one, else null. */
export function pspSaveHost(): PspSaveHost | null {
  const host = (globalThis as { __pspSave?: unknown }).__pspSave;
  if (
    !host || typeof host !== "object"
    || typeof (host as PspSaveHost).read !== "function"
    || typeof (host as PspSaveHost).write !== "function"
    || typeof (host as PspSaveHost).remove !== "function"
  ) {
    return null;
  }
  return host as PspSaveHost;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Three numbered slots over the PSP memory stick. The host ops are
 *  synchronous, so this implements the same sync SaveStore as desktop. */
export function pspSaveStore(): SaveStore | null {
  const host = pspSaveHost();
  if (!host) return null;
  return {
    exists(slot) {
      try {
        return host.read(slotPath(slot)) != null;
      } catch {
        return false;
      }
    },
    read(slot) {
      try {
        const text = host.read(slotPath(slot));
        return text == null ? null : text;
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    write(slot, envelope) {
      host.write(slotPath(slot), envelope);
    },
    remove(slot) {
      host.remove(slotPath(slot));
    },
  };
}

/** The dedicated automatic-save slot (save/autosave.json, the same relative
 *  path the desktop fs store uses). Absence returns null, but a read failure
 *  stays an error so inspection can show a damaged automatic save. A failed
 *  write returns false, so autosave logs it instead of throwing through the
 *  reducer. Returns null without a host bridge. */
export function pspAutosaveBridge(): AutosaveBridge | null {
  const host = pspSaveHost();
  if (!host) return null;
  return {
    read() {
      const text = host.read(AUTOSAVE_FS_PATH);
      return text == null ? null : text;
    },
    write(envelope) {
      try {
        host.write(AUTOSAVE_FS_PATH, envelope);
        return true;
      } catch (error) {
        globalThis.console?.debug?.("pocket-tuxemon: PSP autosave write failed", error);
        return false;
      }
    },
  };
}

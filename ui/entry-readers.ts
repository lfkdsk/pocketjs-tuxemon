// Entry-keyed shard readers shared by every streamed payload: maps, battle
// runtime, animated tiles, NPC sprite frames, and terrain streams. The
// desktop launcher stages entries in data.fs; web and consoles install the
// pak before this bundle evaluates.
//
// KP2 (PocketJS 9eda4b5b): desktop hosts may offer the optional native
// readText op, which returns a whole file as one UTF-8 string and skips the
// paged base64 transfer plus guest-side byte decoding. The map repository
// gets that channel through readText; the byte reader stays the fallback
// (and the only path on pak-only hosts). The framework's readFileSync with
// an encoding probes for the op and falls back to paged reads on older
// hosts, so the text channel is safe everywhere a filesystem is mounted.
import { pakGet } from "@pocketjs/framework";
import { fsHost, readFileSync } from "@pocketjs/framework/fs";
import { createJsonMapRepository } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import type { MapIndexEntry, MapRepository } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { browserPakChunks, type BrowserPakChunks } from "./web-pak.ts";

export interface GameEntryReaders {
  /** Byte reader for every entry-keyed shard (desktop data.fs, web/console pak). */
  read: (entry: string) => Uint8Array;
  /** Native UTF-8 channel for the map repository; undefined on pak-only hosts. */
  readText?: (entry: string) => string;
}

export const createGameEntryReaders = (host: ReturnType<typeof fsHost>): GameEntryReaders => ({
  read: (entry) => (host ? readFileSync(entry) : pakGet(entry)),
  readText: host ? (entry) => readFileSync(entry, "utf8") : undefined,
});

export interface GameMapRepository {
  repository: MapRepository;
  readEntry: (entry: string) => Uint8Array;
}

export function createGameMapEntrySource(
  readers: GameEntryReaders,
  chunks: BrowserPakChunks | null,
): {
  read: (entry: string) => Uint8Array | undefined;
  readText?: (entry: string) => string | undefined;
    prefetch?: (entry: string) => Promise<void>;
  prepare?: (entry: string) => Promise<void>;
} {
  if (!chunks) return readers;
  return {
    read: (entry) => chunks.ready(entry) ? readers.read(entry) : undefined,
    prefetch: (entry) => chunks.prefetch(entry),
    prepare: (entry) => chunks.prepare(entry),
  };
}

export const createGameMapRepository = (
  entries: readonly MapIndexEntry[],
  host: ReturnType<typeof fsHost>,
): GameMapRepository => {
  const readers = createGameEntryReaders(host);
  const source = createGameMapEntrySource(readers, host ? null : browserPakChunks());
  return {
    repository: createJsonMapRepository(entries, source),
    readEntry: readers.read,
  };
};

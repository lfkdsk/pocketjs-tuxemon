// Desktop startup-pak sidecar policy.
//
// The native desktop host reads the complete application pak before it can
// compile the JavaScript bundle. Audio is already lazy at the game layer, so
// keeping lazy QOA payloads or data.fs-backed JSON shards in that startup
// read only adds cold-I/O and pak-copy latency. Desktop builds stage those
// entries under the app's data.fs root and repack the startup pak without
// duplicate data. UI textures, fonts and small WAV effects stay packed.
// Web and console builds do not call this helper and keep the complete pak.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  pack,
  unpack,
  type PakBlob,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";

export interface DesktopPakPartition {
  readonly startup: PakBlob[];
  readonly sidecar: PakBlob[];
  readonly audio: PakBlob[];
  readonly dataBytes: number;
  readonly audioBytes: number;
}

export interface DesktopPakExternalization {
  readonly entries: number;
  readonly dataEntries: number;
  readonly audioEntries: number;
  readonly dataBytes: number;
  readonly audioBytes: number;
  readonly fullPakBytes: number;
  readonly startupPakBytes: number;
}

export function isDesktopAudioEntry(key: string): boolean {
  return key.startsWith("audio:qoa.");
}

const DESKTOP_DATA_PREFIXES = [
  "animated/",
  "battle/",
  "battle-zh/",
  "choice-icons/",
  "demo/",
  "feature/",
  "l10n/",
  "maps/",
  "maps-zh/",
  "npc-src/",
  "portraits/",
  "terrain-stream/",
] as const;

const DESKTOP_DATA_FILES = new Set(["game:battle-db", "world-index.json"]);

export function isDesktopDataEntry(key: string): boolean {
  return DESKTOP_DATA_FILES.has(key)
    || DESKTOP_DATA_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isDesktopSidecarEntry(key: string): boolean {
  return isDesktopAudioEntry(key) || isDesktopDataEntry(key);
}

export function partitionDesktopPakEntries(
  entries: readonly PakBlob[],
): DesktopPakPartition {
  const startup: PakBlob[] = [];
  const sidecar: PakBlob[] = [];
  const audio: PakBlob[] = [];
  let dataBytes = 0;
  let audioBytes = 0;
  for (const entry of entries) {
    if (isDesktopAudioEntry(entry.key)) {
      audio.push(entry);
      audioBytes += entry.data.length;
      sidecar.push(entry);
    } else if (isDesktopDataEntry(entry.key)) {
      dataBytes += entry.data.length;
      sidecar.push(entry);
    } else {
      startup.push(entry);
    }
  }
  return { startup, sidecar, audio, dataBytes, audioBytes };
}

function dataPath(root: string, key: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, key);
  if (!target.startsWith(absoluteRoot + sep)) {
    throw new Error(`desktop: unsafe sidecar entry key '${key}'`);
  }
  return target;
}

/** Move lazy payloads from a built desktop pak into its data.fs tree. */
export function externalizeDesktopPak(
  pakPath: string,
  appDataRoot: string,
): DesktopPakExternalization {
  const fullPak = new Uint8Array(readFileSync(pakPath));
  const partition = partitionDesktopPakEntries(unpack(fullPak));
  if (partition.sidecar.length === 0 || partition.audio.length === 0) {
    throw new Error("desktop: built pak contains no data/audio entries to externalize");
  }

  mkdirSync(appDataRoot, { recursive: true });
  // Remove obsolete managed roots from an earlier build while preserving
  // saves and the user-selected lang.json file.
  for (const entry of readdirSync(appDataRoot, { withFileTypes: true })) {
    if (
      entry.name.startsWith("audio:qoa.")
      || DESKTOP_DATA_FILES.has(entry.name)
      || DESKTOP_DATA_PREFIXES.some((prefix) => entry.name === prefix.slice(0, -1))
    ) {
      rmSync(resolve(appDataRoot, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of partition.sidecar) {
    const target = dataPath(appDataRoot, entry.key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }

  const startupPak = pack(partition.startup);
  writeFileSync(pakPath, startupPak);
  return {
    entries: partition.sidecar.length,
    dataEntries: partition.sidecar.length - partition.audio.length,
    audioEntries: partition.audio.length,
    dataBytes: partition.dataBytes,
    audioBytes: partition.audioBytes,
    fullPakBytes: fullPak.length,
    startupPakBytes: startupPak.length,
  };
}

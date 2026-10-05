// Desktop audio sidecar policy.
//
// The native desktop host reads the complete application pak before it can
// compile the JavaScript bundle. Audio is already lazy at the game layer, so
// keeping large QOA payloads in that startup read only adds cold-I/O latency.
// Desktop builds stage music under the app's data.fs root and repack the
// startup pak without it. The small WAV effects stay packed so one-shot cues
// do not wait for the incremental sidecar reader. Web and console builds do
// not call this helper and continue to carry every audio entry in their pak.

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
  readonly audio: PakBlob[];
  readonly audioBytes: number;
}

export interface DesktopAudioExternalization {
  readonly entries: number;
  readonly audioBytes: number;
  readonly fullPakBytes: number;
  readonly startupPakBytes: number;
}

export function isDesktopAudioEntry(key: string): boolean {
  return key.startsWith("audio:qoa.");
}

export function partitionDesktopPakEntries(
  entries: readonly PakBlob[],
): DesktopPakPartition {
  const startup: PakBlob[] = [];
  const audio: PakBlob[] = [];
  let audioBytes = 0;
  for (const entry of entries) {
    if (isDesktopAudioEntry(entry.key)) {
      audio.push(entry);
      audioBytes += entry.data.length;
    } else {
      startup.push(entry);
    }
  }
  return { startup, audio, audioBytes };
}

function dataPath(root: string, key: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, key);
  if (!target.startsWith(absoluteRoot + sep)) {
    throw new Error(`desktop: unsafe audio entry key '${key}'`);
  }
  return target;
}

/** Move QOA music payloads from a built desktop pak into its data.fs tree. */
export function externalizeDesktopAudio(
  pakPath: string,
  appDataRoot: string,
): DesktopAudioExternalization {
  const fullPak = new Uint8Array(readFileSync(pakPath));
  const partition = partitionDesktopPakEntries(unpack(fullPak));
  if (partition.audio.length === 0) {
    throw new Error("desktop: built pak contains no audio entries to externalize");
  }

  mkdirSync(appDataRoot, { recursive: true });
  // Remove obsolete audio sidecar roots from an earlier build while leaving
  // maps, saves, language choice and the other data.fs namespaces intact.
  for (const entry of readdirSync(appDataRoot, { withFileTypes: true })) {
    if (entry.name.startsWith("audio:")) {
      rmSync(resolve(appDataRoot, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of partition.audio) {
    const target = dataPath(appDataRoot, entry.key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }

  const startupPak = pack(partition.startup);
  writeFileSync(pakPath, startupPak);
  return {
    entries: partition.audio.length,
    audioBytes: partition.audioBytes,
    fullPakBytes: fullPak.length,
    startupPakBytes: startupPak.length,
  };
}

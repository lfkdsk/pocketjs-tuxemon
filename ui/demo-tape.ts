// Lazy demo chapter loading: the mainline tape and the chapter snapshots
// live in the pak as compact entries (see importer/demo-data.ts) and are
// read on demand when a chapter is first selected, so the bundle keeps only
// the tiny generated index (ui/demo-index.ts). Every chapter names the same
// tape provider with its own window; the kit's demo runtime calls that
// provider once and windows the decoded tape without copying it.
//
// The Chinese build has its own tape and chapter saves: the English tape
// transcribed for Chinese dialog pages, and saves taken from the Chinese
// session on the same frames (tools/transcribe-zh-tape.ts), so a chapter
// never resumes Chinese play with English event text.

import { decodeEnvelopeText, type SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { utf8ToString } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/bytes.ts";
import type { DemoChapter, DemoOptions, DemoSpawn } from "../vendor/pocket-rpgkit/src/ui/demo/types.ts";
import {
  DEMO_CHAPTER_INDEX,
  DEMO_CHAPTER_INDEX_ZH,
  DEMO_SNAPSHOTS_ENTRY,
  DEMO_SNAPSHOTS_ENTRY_ZH,
  DEMO_TAPE_ENTRY,
  DEMO_TAPE_ENTRY_ZH,
  DEMO_WARP_SPAWNS,
} from "./demo-index.ts";
import type { Lang } from "./language.ts";

const TAPE_FMT_NIBBLE = 1;
const TAPE_FMT_RAW = 2;
const TAPE_DICT_MASK = 0x1f;
const TAPE_TRAVERSAL_SHIFT = 5;

interface DecodedDemoTape {
  masks: Uint16Array;
  worldTraversal: WorldTraversalMode;
}

function worldTraversal(value: unknown, label: string): WorldTraversalMode {
  const identity = value ?? "legacy-transfer";
  if (identity !== "legacy-transfer" && identity !== "seamless-v1") {
    throw new Error(`${label}: unsupported worldTraversal ${String(identity)}`);
  }
  return identity;
}

function traversalFromCode(code: number): WorldTraversalMode {
  if (code === 0) return "legacy-transfer";
  if (code === 1) return "seamless-v1";
  throw new Error(`demo tape: unknown traversal code ${code}`);
}

/** Decode the self-describing tape binary (nibble dictionary or raw u16)
 *  into one contiguous u16 mask stream. */
export function decodeDemoTape(bytes: Uint8Array): DecodedDemoTape {
  if (bytes.byteLength < 8 || bytes[0] !== 0x54) throw new Error("demo tape: bad magic or truncated header");
  const version = bytes[1];
  if (version !== 1 && version !== 2) throw new Error(`demo tape: unsupported version ${version}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = dv.getUint32(4, true);
  const format = bytes[2];
  // Version 1 had no identity and is intentionally the legacy timeline.
  const worldTraversal = version === 1
    ? "legacy-transfer"
    : traversalFromCode(bytes[3]! >> TAPE_TRAVERSAL_SHIFT);
  if (format === TAPE_FMT_RAW) {
    if (version === 2 && (bytes[3]! & TAPE_DICT_MASK) !== 0) {
      throw new Error("demo tape: raw format has a dictionary size");
    }
    const expected = 8 + frames * 2;
    if (bytes.byteLength !== expected) {
      throw new Error(`demo tape: raw payload length ${bytes.byteLength} != ${expected}`);
    }
    const out = new Uint16Array(frames);
    for (let i = 0; i < frames; i++) out[i] = dv.getUint16(8 + i * 2, true);
    return { masks: out, worldTraversal };
  }
  if (format !== TAPE_FMT_NIBBLE) throw new Error(`demo tape: unknown format ${format}`);
  const dictSize = version === 1 ? bytes[3]! : bytes[3]! & TAPE_DICT_MASK;
  if (dictSize > 16 || (frames > 0 && dictSize === 0)) {
    throw new Error(`demo tape: invalid dictionary size ${dictSize}`);
  }
  const expected = 8 + dictSize * 2 + ((frames + 1) >> 1);
  if (bytes.byteLength !== expected) {
    throw new Error(`demo tape: nibble payload length ${bytes.byteLength} != ${expected}`);
  }
  const dict = new Uint16Array(dictSize);
  for (let i = 0; i < dictSize; i++) dict[i] = dv.getUint16(8 + i * 2, true);
  const base = 8 + dictSize * 2;
  const out = new Uint16Array(frames);
  for (let i = 0; i < frames; i++) {
    const byte = bytes[base + (i >> 1)]!;
    out[i] = dict[(i & 1) === 0 ? byte & 0xf : byte >> 4]!;
  }
  return { masks: out, worldTraversal };
}

/** True when the build has demo chapters for this language. */
export function hasDemoChapters(lang: Lang): boolean {
  return (lang === "zh_CN" ? DEMO_CHAPTER_INDEX_ZH : DEMO_CHAPTER_INDEX).length > 0;
}

/** Which pak entries a language's demo chapters read their tape and saves
 *  from. The Chinese build has its own transcribed tape and chapter saves,
 *  so a Chinese boot must never read the English entries. */
export interface DemoResources {
  tapeEntry: string;
  snapshotsEntry: string;
}

export function demoResourcesForLang(lang: Lang): DemoResources {
  const zh = lang === "zh_CN";
  return {
    tapeEntry: zh ? DEMO_TAPE_ENTRY_ZH : DEMO_TAPE_ENTRY,
    snapshotsEntry: zh ? DEMO_SNAPSHOTS_ENTRY_ZH : DEMO_SNAPSHOTS_ENTRY,
  };
}

/** Build the kit DemoOptions from the generated index. All chapters share
 *  one provider for the combined tape and window it by their index entry;
 *  the snapshot getter decodes the envelope on first selection. Neither
 *  touches the pak at boot. The returned object also carries `demoResources`
 *  (the entries the options were built from) so the game can publish what a
 *  boot selected for the built-game demo verification. */
export function createDemoOptions(
  read: (entry: string) => Uint8Array,
  expectedWorldTraversal: WorldTraversalMode = "seamless-v1",
  lang: Lang = "en_US",
): DemoOptions & { demoResources: DemoResources } {
  const expected = worldTraversal(expectedWorldTraversal, "demo index");
  const zh = lang === "zh_CN";
  const index = zh ? DEMO_CHAPTER_INDEX_ZH : DEMO_CHAPTER_INDEX;
  const { tapeEntry, snapshotsEntry } = demoResourcesForLang(lang);
  for (const entry of index) {
    const actual = worldTraversal(entry.worldTraversal, `demo chapter ${entry.id}`);
    if (actual !== expected) {
      throw new Error(`demo chapter ${entry.id}: worldTraversal ${actual} != expected ${expected}`);
    }
  }

  const tape = (): Uint16Array => {
    const decoded = decodeDemoTape(read(tapeEntry));
    if (decoded.worldTraversal !== expected) {
      throw new Error(`demo tape: worldTraversal ${decoded.worldTraversal} != expected ${expected}`);
    }
    return decoded.masks;
  };
  let snapshotsCache: Record<string, string> | null = null;
  const snapshots = (): Record<string, string> => {
    if (!snapshotsCache) {
      const text = utf8ToString(read(snapshotsEntry));
      const manifest = JSON.parse(text) as {
        format?: unknown;
        worldTraversal?: unknown;
        snapshots?: unknown;
      };
      if (manifest.format !== undefined && manifest.format !== "pocket-tuxemon/demo-snapshots/v1") {
        throw new Error(`demo snapshots: unexpected format ${String(manifest.format)}`);
      }
      const actual = worldTraversal(manifest.worldTraversal, "demo snapshots");
      if (actual !== expected) {
        throw new Error(`demo snapshots: worldTraversal ${actual} != expected ${expected}`);
      }
      if (!manifest.snapshots || typeof manifest.snapshots !== "object" || Array.isArray(manifest.snapshots)) {
        throw new Error("demo snapshots: missing snapshots record");
      }
      snapshotsCache = manifest.snapshots as Record<string, string>;
    }
    return snapshotsCache;
  };
  const chapters: DemoChapter[] = index.map((entry) => ({
    id: entry.id,
    title: entry.title,
    get snapshot(): SaveSnapshot {
      return decodeEnvelopeText(snapshots()[entry.id]!);
    },
    timelineFrame: entry.timelineFrame,
    tape,
    tapeStart: entry.frame,
    tapeFrames: entry.suffixFrames,
  }));
  const spawns: Record<string, DemoSpawn> = {};
  for (const spawn of DEMO_WARP_SPAWNS) spawns[spawn.id] = { x: spawn.x, y: spawn.y };
  return { chapters, warp: { spawns }, demoResources: { tapeEntry, snapshotsEntry } };
}

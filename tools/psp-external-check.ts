// PSP external-pak validation. The PSP host (vendor/.../hosts/psp/src/
// pak_external.rs) accepts a sidecar `assets.pak` only when its declared
// length matches the file and the embedded `pocket:external-index` is a
// byte-for-byte prefix of the sidecar; it then locates entries by binary
// search over the directory and reads their payloads at the recorded
// offsets. This module reproduces those rules build-side so `build:psp`
// fails fast on a mismatched index, and so a test can exercise the logic
// without the PSP toolchain.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";

export const PAK_MAGIC = 0x4b504344; // 'DCPK' LE
export const PAK_VERSION = 1;
export const PAK_HEADER_SIZE = 32;
const PAK_ENTRY_SIZE = 24;

function u32(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! * 0x1000000);
}
function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

/** The host's acceptance rules: index is a well-formed header, its declared
 *  total length equals the sidecar's, and the index is a byte-for-byte prefix
 *  of the sidecar. Returns null when valid, or an error string. */
export function indexMismatch(sidecar: Uint8Array, index: Uint8Array): string | null {
  if (index.length < PAK_HEADER_SIZE) return `index too short (${index.length} < ${PAK_HEADER_SIZE})`;
  if (u32(index, 0) !== PAK_MAGIC) return "index magic mismatch";
  if (u16(index, 4) !== PAK_VERSION) return "index version mismatch";
  // The embedded index is the whole directory: header, entry table and
  // names, up to the first blob (the header's data offset). A shorter index
  // can still be a byte prefix of the sidecar while losing entries or names.
  const dataOffset = u32(index, 20);
  if (index.length !== dataOffset) {
    return `index length ${index.length} != directory length (data offset) ${dataOffset}`;
  }
  const declared = u32(index, 24);
  if (declared !== sidecar.length) {
    return `declared length ${declared} != sidecar length ${sidecar.length}`;
  }
  if (index.length > sidecar.length) return "index longer than sidecar";
  for (let i = 0; i < index.length; i++) {
    if (index[i] !== sidecar[i]) return `index differs from sidecar at byte ${i}`;
  }
  return null;
}

/** Binary-search the directory for `key`, mirroring pak_external.rs locate().
 *  Returns the entry's [offset, length] or null. */
export function locateEntry(sidecar: Uint8Array, key: string): [number, number] | null {
  const count = u32(sidecar, 8);
  const dir = u32(sidecar, 12);
  const names = u32(sidecar, 16);
  const target = Buffer.from(key, "utf8");
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const e = dir + mid * PAK_ENTRY_SIZE;
    const nameOff = u32(sidecar, e + 12);
    const nameLen = u16(sidecar, e + 16);
    const nameStart = names + nameOff;
    let cmp = 0;
    for (let i = 0; i < nameLen && i < target.length; i++) {
      const a = sidecar[nameStart + i]!;
      const b = target[i]!;
      if (a !== b) { cmp = a < b ? -1 : 1; break; }
    }
    if (cmp === 0 && nameLen !== target.length) cmp = nameLen < target.length ? -1 : 1;
    if (cmp === 0) return [u32(sidecar, e + 4), u32(sidecar, e + 8)];
    if (cmp < 0) lo = mid + 1; else hi = mid;
  }
  return null;
}

/** Read an entry's payload through the host's read_at path (bounded range
 *  check + copy). Throws if the entry is missing or out of range. */
export function readEntry(sidecar: Uint8Array, key: string): Uint8Array {
  const located = locateEntry(sidecar, key);
  if (!located) throw new Error(`sidecar entry not found: ${key}`);
  const [off, len] = located;
  if (off + len > sidecar.length) throw new Error(`sidecar entry ${key} out of range`);
  return sidecar.slice(off, off + len);
}

/** Every key in a pak's directory (header + entry table + names region). */
export function listKeys(pak: Uint8Array): string[] {
  const count = u32(pak, 8);
  const dir = u32(pak, 12);
  const names = u32(pak, 16);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = dir + i * PAK_ENTRY_SIZE;
    const nameOff = u32(pak, e + 12);
    const nameLen = u16(pak, e + 16);
    out.push(Buffer.from(pak.subarray(names + nameOff, names + nameOff + nameLen)).toString("utf8"));
  }
  return out;
}

/** Locate `key` in the EMBEDDED index and read its payload from the sidecar —
 *  the PSP host's locate + read_at path. Throws when the embedded directory
 *  cannot locate the key (e.g. an index truncated to its header). */
export function readEntryVia(index: Uint8Array, sidecar: Uint8Array, key: string): Uint8Array {
  const located = locateEntry(index, key);
  if (!located) throw new Error(`embedded index cannot locate: ${key}`);
  const [off, len] = located;
  if (off + len > sidecar.length) throw new Error(`sidecar entry ${key} out of range`);
  return sidecar.slice(off, off + len);
}

/** Full self-check for a built PSP output directory: the embedded index
 *  matches the sidecar, and one real map, one real audio entry and one real
 *  battle tile are located THROUGH THE EMBEDDED DIRECTORY (the same binary
 *  search the PSP host runs) and read from the sidecar. Returns a summary
 *  object. */
export interface RequiredAudioEntry {
  key: string;
  bytes: number;
  sha256: string;
}

export function checkExternalPak(
  outDir: string,
  requiredAudio: readonly RequiredAudioEntry[] = [],
): {
  sidecarBytes: number;
  indexBytes: number;
  entries: number;
  samples: { kind: string; key: string; bytes: number }[];
} {
  const sidecar = readFileSync(join(outDir, "assets.pak"));
  const bootPak = readFileSync(join(outDir, "pocket-tuxemon.pak"));
  const bootEntries = unpack(bootPak);
  const indexEntry = bootEntries.find((e) => e.key === "pocket:external-index");
  if (!indexEntry) throw new Error("boot pak has no pocket:external-index");
  const index = new Uint8Array(indexEntry.data);
  const mismatch = indexMismatch(sidecar, index);
  if (mismatch) throw new Error(`PSP external index mismatch: ${mismatch}`);
  // Pick one entry of each kind the game needs at runtime, locating it in the
  // embedded directory the way the host does. A truncated embedded index
  // (header only) still satisfies indexMismatch — it is a byte prefix of the
  // sidecar with the right declared length — but locates nothing, so the
  // picks below are where that mutation is caught.
  const keys = listKeys(index);
  const pick = (pred: (key: string) => boolean, label: string): string => {
    const key = keys.find(pred);
    if (!key) throw new Error(`embedded index has no ${label} entry`);
    return key;
  };
  const mapKey = pick(
    (k) => /^maps(?:-[^/]+)?\/.+\.rkm$/.test(k),
    "real map (maps[-locale]/*.rkm)",
  );
  const audioKey = pick((k) => k.startsWith("audio:qoa."), "real audio (audio:qoa.*)");
  const battleKey = pick((k) => k.startsWith("ui:tile.battle/"), "real battle tile (ui:tile.battle/*)");
  const samples = [mapKey, audioKey, battleKey].map((key) => {
    const bytes = readEntryVia(index, sidecar, key);
    return { kind: key.split(/[:/]/)[0]!, key, bytes: bytes.length };
  });
  // Battle lifecycle cues are contractual, not random samples: locate each
  // exact manifest key through the embedded PSP directory and bind its bytes
  // to the committed transcode hash. This catches missing, swapped and stale
  // battle/victory/defeat payloads before the emulator boots.
  for (const expected of requiredAudio) {
    const bytes = readEntryVia(index, sidecar, expected.key);
    if (bytes.length !== expected.bytes) {
      throw new Error(
        `PSP battle audio ${expected.key} has ${bytes.length} bytes, expected ${expected.bytes}`,
      );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected.sha256) {
      throw new Error(
        `PSP battle audio ${expected.key} sha256 ${actual}, expected ${expected.sha256}`,
      );
    }
    samples.push({ kind: "battle-audio", key: expected.key, bytes: bytes.length });
  }
  return {
    sidecarBytes: sidecar.length,
    indexBytes: index.length,
    entries: keys.length,
    samples,
  };
}

// Incremental desktop reader for QOA sidecars.
//
// data.fs transports binary data as bounded base64 pages. Reading a whole
// music file synchronously can therefore monopolize one QuickJS frame. Keep
// the reader synchronous for AudioDriver, but fill its cache one native page
// per game frame before allowing the driver to open the track.

import { FS_BLOB_KEY, FS_MAX_IO_BYTES } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/fs.ts";
import type { AudioResourceReader } from "../vendor/pocket-rpgkit/src/ui/audio/index.ts";

export interface AudioChunkHost {
  read(path: string, offset: number, maxBytes: number): string;
}

interface ReadResult {
  data?: { [FS_BLOB_KEY]: string };
  size?: number;
  eof?: boolean;
  error?: string;
}

interface PendingAudio {
  readonly key: string;
  offset: number;
  bytes?: Uint8Array;
}

export type AudioPumpResult =
  | { readonly kind: "progress"; readonly key: string }
  | { readonly kind: "ready"; readonly key: string }
  | { readonly kind: "failed"; readonly key: string; readonly error: string };

export interface StagedDesktopAudioReader {
  readonly read: AudioResourceReader;
  /** True only while a sidecar has a page left to read. */
  hasPending(): boolean;
  /** Read exactly one native data.fs page. Call only while hasPending(). */
  pump(): AudioPumpResult;
  /** Drop a completed resource when the new driver did not consume it. */
  releaseReady(key: string): void;
}

const isSidecarMusic = (key: string): boolean => key.startsWith("audio:qoa.");

/**
 * A corrupt data.fs response must not make QuickJS allocate an arbitrary
 * buffer. The largest shipped QOA is 2,051,760 bytes; 4 MiB leaves roughly
 * 2x headroom for replacement music while keeping one in-flight/ready file
 * explicitly bounded. A ready file is handed off once and then released.
 */
export const MAX_STAGED_AUDIO_BYTES = 4 * 1024 * 1024;

const BASE64_VALUES = new Int16Array(128);
BASE64_VALUES.fill(-1);
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let index = 0; index < BASE64_ALPHABET.length; index++) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
}

function base64ByteLength(encoded: string): number {
  if (encoded.length % 4 !== 0) throw new Error("malformed base64 page length");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const firstPadding = encoded.indexOf("=");
  if (firstPadding !== -1 && firstPadding !== encoded.length - padding) {
    throw new Error("malformed base64 page padding");
  }
  return encoded.length / 4 * 3 - padding;
}

/** Decode directly into the long-lived staging buffer.
 *
 * The shared SDK decoder allocates a page-sized Uint8Array and performs four
 * string-keyed object lookups for every three bytes. On desktop QuickJS a
 * full 64 KiB page took about 14 ms before the copy into the final buffer.
 * A dense ASCII lookup table plus direct writes avoids both the temporary
 * allocation and that copy/GC pressure.
 */
function decodeBase64Into(encoded: string, output: Uint8Array, offset: number): number {
  const length = base64ByteLength(encoded);
  if (offset + length > output.length) throw new Error("base64 page exceeds declared file size");
  const meaningful = encoded.length - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  let cursor = offset;
  for (let index = 0; index < encoded.length; index += 4) {
    const aCode = encoded.charCodeAt(index);
    const bCode = encoded.charCodeAt(index + 1);
    const cCode = encoded.charCodeAt(index + 2);
    const dCode = encoded.charCodeAt(index + 3);
    const a = aCode < BASE64_VALUES.length ? BASE64_VALUES[aCode]! : -1;
    const b = bCode < BASE64_VALUES.length ? BASE64_VALUES[bCode]! : -1;
    const c = cCode === 61 ? 0 : cCode < BASE64_VALUES.length ? BASE64_VALUES[cCode]! : -1;
    const d = dCode === 61 ? 0 : dCode < BASE64_VALUES.length ? BASE64_VALUES[dCode]! : -1;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("malformed base64 page data");
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (cursor - offset < length) output[cursor++] = packed >> 16;
    if (cursor - offset < length) output[cursor++] = (packed >> 8) & 0xff;
    if (cursor - offset < length) output[cursor++] = packed & 0xff;
  }
  if (meaningful < 2 && length !== 0) throw new Error("malformed base64 page data");
  return length;
}

export function createStagedDesktopAudioReader(
  host: AudioChunkHost,
  readPacked: AudioResourceReader,
  chunkBytes = FS_MAX_IO_BYTES,
): StagedDesktopAudioReader {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > FS_MAX_IO_BYTES) {
    throw new RangeError(`desktop audio chunk size must be 1..${FS_MAX_IO_BYTES}`);
  }

  const ready = new Map<string, Uint8Array>();
  const failed = new Map<string, string>();
  const requested = new Set<string>();
  const pending: PendingAudio[] = [];

  const finish = (entry: PendingAudio, bytes: Uint8Array): AudioPumpResult => {
    ready.set(entry.key, bytes);
    requested.delete(entry.key);
    pending.shift();
    return { kind: "ready", key: entry.key };
  };

  const fail = (entry: PendingAudio, message: string): AudioPumpResult => {
    const detail = `${entry.key}: ${message}`;
    failed.set(entry.key, detail);
    requested.delete(entry.key);
    pending.shift();
    // Preserve a machine-readable diagnostic even though AudioDriver treats
    // optional audio as non-fatal. The caller also logs the returned event.
    (globalThis as typeof globalThis & { __pocketTuxemonAudioError?: string })
      .__pocketTuxemonAudioError = detail;
    return { kind: "failed", key: entry.key, error: detail };
  };

  const request = (key: string): void => {
    if (!isSidecarMusic(key) || ready.has(key) || failed.has(key) || requested.has(key)) return;
    if (!requested.has(key)) {
      requested.add(key);
      pending.push({ key, offset: 0 });
    }
  };

  const read: AudioResourceReader = (key) => {
    if (!isSidecarMusic(key)) return readPacked(key);
    const bytes = ready.get(key);
    if (bytes) {
      // QoaFile keeps this Uint8Array. Removing our reference transfers
      // ownership instead of retaining every song for the whole session.
      ready.delete(key);
      return bytes;
    }
    const failure = failed.get(key);
    if (failure) throw new Error(`desktop audio sidecar failed: ${failure}`);
    request(key);
    throw new Error(`desktop audio sidecar is not ready: ${key}`);
  };

  const pump = (): AudioPumpResult => {
    if (ready.size > 0) {
      throw new Error("desktop audio pump is awaiting driver handoff");
    }
    const entry = pending[0];
    if (!entry) throw new Error("desktop audio pump called without pending work");

    let result: ReadResult;
    try {
      const response = host.read(entry.key, entry.offset, chunkBytes);
      result = JSON.parse(response) as ReadResult;
    } catch (error) {
      return fail(entry, error instanceof Error ? error.message : String(error));
    }
    if (result === null || typeof result !== "object") {
      return fail(entry, "malformed data.fs response");
    }
    if (result.error !== undefined) return fail(entry, result.error);
    if (
      !result.data || typeof result.data[FS_BLOB_KEY] !== "string" ||
      typeof result.size !== "number" || !Number.isSafeInteger(result.size) || result.size < 0 ||
      typeof result.eof !== "boolean"
    ) {
      return fail(entry, "malformed data.fs response");
    }

    const encoded = result.data[FS_BLOB_KEY];
    let decodedLength: number;
    try {
      if (result.size > MAX_STAGED_AUDIO_BYTES) {
        return fail(
          entry,
          `declared size ${result.size} exceeds ${MAX_STAGED_AUDIO_BYTES} byte limit`,
        );
      }
      if (!entry.bytes) {
        entry.bytes = new Uint8Array(result.size);
      }
      if (entry.bytes.length !== result.size) {
        return fail(entry, "inconsistent data.fs file size");
      }
      decodedLength = decodeBase64Into(encoded, entry.bytes, entry.offset);
    } catch (error) {
      return fail(entry, error instanceof Error ? error.message : String(error));
    }
    entry.offset += decodedLength;

    if (!result.eof) {
      return decodedLength === 0
        ? fail(entry, "empty non-final data.fs page")
        : { kind: "progress", key: entry.key };
    }
    if (entry.offset !== entry.bytes.length) {
      return fail(entry, `truncated data.fs file (${entry.offset}/${entry.bytes.length})`);
    }
    return finish(entry, entry.bytes);
  };

  return {
    read,
    // Do not assemble a second file until the sole ready buffer has either
    // moved into QoaFile or been rejected as stale. Together with the 4 MiB
    // file limit this is also the total staging-cache byte bound.
    hasPending: () => ready.size === 0 && pending.length > 0,
    pump,
    releaseReady(key) {
      ready.delete(key);
    },
  };
}

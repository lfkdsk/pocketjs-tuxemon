// verify:audio must read the committed blobs that actually
// ship and compare their byte counts and SHA-256 against the manifest, so a
// corrupted or swapped file fails the gate. The re-encode check alone cannot
// notice a tampered committed blob.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TUXEMON_SRC } from "../importer/terrain.ts";
import {
  audioBlobMetadata,
  sha256,
  verifyCommittedBlobs,
  type Manifest,
} from "../tools/audio-manifest.ts";
import { encodeQoa } from "../tools/qoa.ts";

const TMP = join(import.meta.dir, "..", ".tmp-audio-verify-test");
const ROOT = resolve(import.meta.dir, "..");

function manifestFor(files: Record<string, Uint8Array>): Manifest {
  return {
    format: "pocket-tuxemon/audio-manifest/v2",
    ffmpeg: "test",
    rate: 22050,
    channels: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([rel, bytes]) => {
        const metadata = audioBlobMetadata(rel, bytes);
        const kind = rel.startsWith("music/") ? "music" as const : "sfx" as const;
        return [rel, {
          slug: rel.split("/").pop()!.replace(/\.(qoa|wav)$/, ""),
          kind,
          source: "test",
          pakKey: `audio:${kind === "music" ? "qoa" : "wav"}.${rel}`,
          bytes: bytes.length,
          sha256: sha256(bytes),
          frames: metadata.frames,
          durationSeconds: metadata.durationSeconds,
          ...(kind === "music" ? { loopStartFrame: 0, loopEndFrame: metadata.frames } : {}),
        }];
      }),
    ),
  };
}

function writeFixture(files: Record<string, Uint8Array>): Manifest {
  rmSync(TMP, { recursive: true, force: true });
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(join(TMP, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(TMP, rel), bytes);
  }
  return manifestFor(files);
}

function wav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + samples.byteLength, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 44100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, samples.byteLength, true);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return bytes;
}

const A = encodeQoa(new Int16Array([1, -2, 3, -4, 5, -6, 7, -8]), 1, 22050);
const B = wav(new Int16Array([5, 6, 7, 8, 9]));

describe("verifyCommittedBlobs", () => {
  test("passes when every blob matches the manifest", () => {
    const manifest = writeFixture({ "music/a.qoa": A, "sounds/b.wav": B });
    expect(verifyCommittedBlobs(TMP, manifest)).toEqual([]);
  });

  test("fails when a blob is corrupted (same length, different bytes)", () => {
    const manifest = writeFixture({ "music/a.qoa": A, "sounds/b.wav": B });
    const corrupted = A.slice();
    corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(join(TMP, "music/a.qoa"), corrupted);
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors.some((e) => e.includes("sha256 mismatch") && e.includes("music/a.qoa"))).toBe(true);
  });

  test("fails when a blob is replaced by a different-length file", () => {
    const manifest = writeFixture({ "music/a.qoa": A, "sounds/b.wav": B });
    writeFileSync(join(TMP, "sounds/b.wav"), new Uint8Array([5, 6, 7]));
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors.some((e) => e.includes("byte count mismatch") && e.includes("sounds/b.wav"))).toBe(true);
    expect(errors.some((e) => e.includes("sha256 mismatch"))).toBe(true);
  });

  test("fails when duration or loop metadata differs from the container", () => {
    const manifest = writeFixture({ "music/a.qoa": A });
    manifest.files["music/a.qoa"]!.durationSeconds += 1;
    manifest.files["music/a.qoa"]!.loopEndFrame! -= 1;
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors.some((error) => error.includes("duration mismatch"))).toBe(true);
    expect(errors.some((error) => error.includes("loop range mismatch"))).toBe(true);
  });

  test("fails inconsistent and unsafe manifest identities", () => {
    const manifest = writeFixture({ "music/a.qoa": A, "sounds/b.wav": B });
    manifest.files["music/a.qoa"]!.pakKey = "audio:wav.sounds/b.wav";
    manifest.files["sounds/b.wav"]!.source = "../b.wav";
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors.some((error) => error.includes("pak key mismatch"))).toBe(true);
    expect(errors.some((error) => error.includes("duplicate audio pak key"))).toBe(true);
    expect(errors.some((error) => error.includes("unsafe audio source path"))).toBe(true);
  });

  test("fails when a blob is missing", () => {
    const manifest = writeFixture({ "music/a.qoa": A, "sounds/b.wav": B });
    rmSync(join(TMP, "music/a.qoa"));
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors).toContain("missing committed blob: music/a.qoa");
  });

  test("fails when an extra blob is present", () => {
    const manifest = writeFixture({ "music/a.qoa": A });
    mkdirSync(join(TMP, "sounds"), { recursive: true });
    writeFileSync(join(TMP, "sounds/extra.wav"), B);
    const errors = verifyCommittedBlobs(TMP, manifest);
    expect(errors).toContain("extra committed blob not in manifest: sounds/extra.wav");
  });
});

describe("committed audio assets", () => {
  test("all shipped containers match their manifest metadata", () => {
    const audioDir = join(ROOT, "assets/audio");
    const manifest = JSON.parse(readFileSync(join(audioDir, "manifest.json"), "utf8")) as Manifest;
    expect(verifyCommittedBlobs(audioDir, manifest)).toEqual([]);
    expect(Object.values(manifest.files).filter((entry) => entry.kind === "music")).toHaveLength(24);
    expect(Object.values(manifest.files).filter((entry) => entry.kind === "sfx")).toHaveLength(3);
  });
});

describe("verify:audio integration", () => {
  // Runs the real command against the real committed assets. This is the
  // end-to-end proof that the gate is green on the shipped files (and the
  // unit tests above prove it goes red when they are tampered).
  // verify:audio re-transcodes from the pinned Tuxemon checkout with ffmpeg,
  // so it needs the same source the importer reads (TUXEMON_SRC, else
  // .tuxemon-src) and an ffmpeg on PATH. The committed-blob checks above run
  // everywhere.
  const source = process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC;
  const runnable = existsSync(source) && Bun.which("ffmpeg") !== null;
  test.skipIf(!runnable)("bun run verify:audio passes on the committed assets", () => {
    const env = { ...process.env, TUXEMON_SRC: source };
    const out = execFileSync("bun", ["run", "verify:audio"], {
      cwd: join(import.meta.dir, ".."),
      env,
      encoding: "utf8",
    });
    expect(out).toContain(
      "verify:audio: two scratch passes are byte-identical; all committed hashes, durations and loop ranges match",
    );
  }, 300_000);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

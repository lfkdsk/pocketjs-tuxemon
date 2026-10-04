#!/usr/bin/env bun
// tools/transcode-audio.ts — transcode all imported-content music and used SFX
// from the Tuxemon source into the committed audio assets.
//
// Music: ffmpeg decodes ogg/mp3 to s16le mono 22.05 kHz PCM, then the QOA
// encoder (tools/qoa.ts) produces .qoa files. SFX: the same decode, written
// as uncompressed s16 mono 22.05 kHz WAV. Outputs land in assets/audio/ and
// are committed: ffmpeg output is not bit-exact across versions, so the
// importer reads the committed files, never the source tree. A manifest
// records the ffmpeg version, encoded dimensions, loop range and per-file
// SHA-256. `bun run verify:audio` performs two clean scratch transcodes,
// requires them to be byte-identical, then validates the committed blobs and
// their container metadata against the manifest.
//
// The music list is derived from map and environment content. The three SFX
// slugs are the complete set played by map events.
//
// Usage:
//   bun tools/transcode-audio.ts
//   bun run verify:audio
//
// TUXEMON_SRC defaults to the repo-local checkout created by
// tools/fetch-tuxemon.sh.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  durationSeconds,
  verifyCommittedBlobs,
  type Manifest,
  type ManifestFile,
} from "./audio-manifest.ts";
import { buildMusicCatalog } from "./music-catalog.ts";
import { encodeQoa } from "./qoa.ts";

const ROOT = resolve(import.meta.dir, "..");
const SRC = process.env.TUXEMON_SRC ?? resolve(ROOT, ".tuxemon-src");
const OUT = join(ROOT, "assets", "audio");
const RATE = 22050;

// GM0 §1.2: the only three SFX slugs any map event plays.
const SFX_SLUGS = [
  "japanese_temple_bell_small",
  "sound_confirm",
  "coinecho",
];

/** Parse every `- file: … / slug: …` pair in a DB directory's yamls. */
function loadSlugIndex(dbDir: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of readdirSync(dbDir).sort()) {
    if (!name.endsWith(".yaml")) continue;
    const text = readFileSync(join(dbDir, name), "utf8");
    for (const m of text.matchAll(/^- file: (.+)\n  slug: (\S+)/gm)) {
      const file = m[1]!.trim();
      const slug = m[2]!.trim();
      if (!index.has(slug)) index.set(slug, file);
    }
  }
  return index;
}

function ffmpegVersion(): string {
  return execFileSync("ffmpeg", ["-version"], { encoding: "utf8" })
    .split("\n")[0]!.trim();
}

/** Decode any source ffmpeg understands to mono s16 PCM at RATE. */
function decodeToMonoPcm(file: string): Int16Array {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
    { maxBuffer: 1 << 28 },
  );
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

/** Minimal s16 PCM WAV writer (44-byte header + data). */
function writeWav(path: string, samples: Int16Array, rate: number): void {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(buf, 44);
  writeFileSync(path, buf);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function transcode(outDir: string): Manifest {
  const musicCatalog = buildMusicCatalog(SRC);
  const musicDb = new Map(musicCatalog.resolved.map((entry) => [entry.slug, entry.source]));
  const soundsDb = loadSlugIndex(join(SRC, "mods", "tuxemon", "db", "sounds"));
  mkdirSync(join(outDir, "music"), { recursive: true });
  mkdirSync(join(outDir, "sounds"), { recursive: true });

  const files: Record<string, ManifestFile> = {};
  const transcodeOne = (slug: string, kind: "music" | "sfx"): void => {
    const db = kind === "music" ? musicDb : soundsDb;
    const source = db.get(slug);
    if (!source) throw new Error(`${kind} slug not in DB: ${slug}`);
    const srcPath = join(SRC, "mods", "tuxemon", kind === "music" ? "music" : "sounds", source);
    const pcm = decodeToMonoPcm(srcPath);
    const rel = kind === "music" ? `music/${slug}.qoa` : `sounds/${slug}.wav`;
    const outPath = join(outDir, rel);
    if (kind === "music") {
      writeFileSync(outPath, encodeQoa(pcm, 1, RATE));
    } else {
      writeWav(outPath, pcm, RATE);
    }
    const bytes = readFileSync(outPath);
    files[rel] = {
      slug,
      kind,
      source,
      pakKey: kind === "music" ? `audio:qoa.${rel}` : `audio:wav.${rel}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      frames: pcm.length,
      durationSeconds: durationSeconds(pcm.length, RATE),
      ...(kind === "music" ? { loopStartFrame: 0, loopEndFrame: pcm.length } : {}),
    };
    console.log(`${rel}: ${(bytes.length / 1024).toFixed(0)} KB (${(pcm.length / RATE).toFixed(1)} s)`);
  };

  for (const entry of musicCatalog.resolved) transcodeOne(entry.slug, "music");
  for (const slug of SFX_SLUGS) transcodeOne(slug, "sfx");

  return {
    format: "pocket-tuxemon/audio-manifest/v2",
    ffmpeg: ffmpegVersion(),
    rate: RATE,
    channels: 1,
    files,
  };
}

const verify = process.argv.includes("--verify");
// Per-process scratch path avoids collisions when Bun runs test files in
// parallel. dist/ is ignored and the finally block removes this directory.
const verifyRoot = join(ROOT, "dist", `audio-verify-${process.pid}`);

function writeManifest(outDir: string, manifest: Manifest): void {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function compareTranscodes(firstDir: string, first: Manifest, secondDir: string, second: Manifest): string[] {
  const errors: string[] = [];
  const paths = [...new Set([...Object.keys(first.files), ...Object.keys(second.files)])].sort();
  for (const rel of paths) {
    const a = first.files[rel];
    const b = second.files[rel];
    if (!a || !b) {
      errors.push(`scratch manifest differs: ${rel}`);
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) errors.push(`scratch metadata differs: ${rel}`);
    const aBytes = readFileSync(join(firstDir, rel));
    const bBytes = readFileSync(join(secondDir, rel));
    if (!aBytes.equals(bBytes)) errors.push(`scratch bytes differ: ${rel}`);
  }
  return errors;
}

if (!verify) {
  const manifest = transcode(OUT);
  writeManifest(OUT, manifest);
  const total = Object.values(manifest.files).reduce((n, file) => n + file.bytes, 0);
  console.log(`wrote ${Object.keys(manifest.files).length} files, ${(total / 1024 / 1024).toFixed(2)} MB to ${OUT}`);
} else {
  rmSync(verifyRoot, { recursive: true, force: true });
  let failures = 0;
  try {
    const firstDir = join(verifyRoot, "pass-1");
    const secondDir = join(verifyRoot, "pass-2");
    const first = transcode(firstDir);
    const second = transcode(secondDir);
    writeManifest(firstDir, first);
    writeManifest(secondDir, second);
    for (const error of compareTranscodes(firstDir, first, secondDir, second)) {
      console.error(error);
      failures++;
    }

    const committedPath = join(OUT, "manifest.json");
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as Manifest;
    for (const rel of [...new Set([...Object.keys(first.files), ...Object.keys(committed.files)])].sort()) {
      const generated = first.files[rel];
      const shipped = committed.files[rel];
      if (!generated) {
        console.error(`extra in committed manifest: ${rel}`);
        failures++;
      } else if (!shipped) {
        console.error(`missing in committed manifest: ${rel}`);
        failures++;
      } else if (JSON.stringify(generated) !== JSON.stringify(shipped)) {
        console.error(`committed metadata differs: ${rel}`);
        failures++;
      }
    }
    for (const error of verifyCommittedBlobs(OUT, committed)) {
      console.error(error);
      failures++;
    }
  } finally {
    rmSync(verifyRoot, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`verify:audio: ${failures} mismatch(es) — re-run transcode:audio and commit`);
    process.exit(1);
  }
  console.log("verify:audio: two scratch passes are byte-identical; all committed hashes, durations and loop ranges match");
}

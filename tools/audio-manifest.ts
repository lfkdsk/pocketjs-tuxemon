// tools/audio-manifest.ts — manifest types + committed-blob verification.
//
// `bun run verify:audio` must prove the blobs that actually ship in
// assets/audio/{music,sounds} are the ones the manifest describes. Re-
// transcoding to a temp dir and comparing those hashes only proves the
// pipeline is reproducible; it does not notice a corrupted or swapped
// committed blob. This module reads each committed file directly and
// compares its byte count and SHA-256 against the manifest.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { decodeWav } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/audio-api.ts";
import { QoaFile } from "../vendor/pocket-rpgkit/src/ui/audio/qoa.ts";

export interface ManifestFile {
  slug: string;
  kind: "music" | "sfx";
  source: string;
  pakKey: string;
  bytes: number;
  sha256: string;
  /** Sample frames per channel, read from the encoded container. */
  frames: number;
  durationSeconds: number;
  /** Music loops over the complete authored file; SFX omit these fields. */
  loopStartFrame?: number;
  loopEndFrame?: number;
}

export interface Manifest {
  format: "pocket-tuxemon/audio-manifest/v2";
  ffmpeg: string;
  rate: number;
  channels: 1;
  files: Record<string, ManifestFile>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AudioBlobMetadata {
  rate: number;
  channels: number;
  frames: number;
  durationSeconds: number;
}

export function durationSeconds(frames: number, rate: number): number {
  return Number((frames / rate).toFixed(6));
}

/** Parse a shipped container with the same decoders the runtime uses. */
export function audioBlobMetadata(rel: string, bytes: Uint8Array): AudioBlobMetadata {
  if (rel.endsWith(".qoa")) {
    const file = new QoaFile(bytes);
    // Decode both ends as well as parsing the complete frame index. This
    // catches damaged slice data without expanding a whole song into memory.
    const headFrames = Math.min(20, file.frames);
    file.stream().readInto(new Int16Array(headFrames * file.channels), 0, 0, headFrames);
    const tailFrames = Math.min(20, file.frames);
    file.stream().readInto(
      new Int16Array(tailFrames * file.channels),
      0,
      file.frames - tailFrames,
      tailFrames,
    );
    return {
      rate: file.sampleRate,
      channels: file.channels,
      frames: file.frames,
      durationSeconds: durationSeconds(file.frames, file.sampleRate),
    };
  }
  if (rel.endsWith(".wav")) {
    const pcm = decodeWav(bytes);
    return {
      rate: pcm.sampleRate,
      channels: pcm.channels,
      frames: pcm.frames,
      durationSeconds: durationSeconds(pcm.frames, pcm.sampleRate),
    };
  }
  throw new Error(`unsupported audio container: ${rel}`);
}

/**
 * Read every committed blob the manifest names and compare its byte count
 * and SHA-256. Also reports files present under music/ or sounds/ that the
 * manifest does not name. Returns a list of human-readable errors (empty
 * when everything matches).
 */
export function verifyCommittedBlobs(audioDir: string, manifest: Manifest): string[] {
  const errors: string[] = [];
  const pakKeys = new Set<string>();
  const logicalIds = new Set<string>();
  if (manifest.format !== "pocket-tuxemon/audio-manifest/v2") {
    errors.push(`unsupported audio manifest format: ${String(manifest.format)}`);
  }
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const extension = entry.kind === "music" ? "qoa" : "wav";
    const expectedRel = `${entry.kind === "music" ? "music" : "sounds"}/${entry.slug}.${extension}`;
    const expectedPakKey = `audio:${extension}.${expectedRel}`;
    if (rel !== expectedRel) errors.push(`path/slug/kind mismatch: ${rel} (expected ${expectedRel})`);
    if (entry.pakKey !== expectedPakKey) {
      errors.push(`pak key mismatch: ${rel} (manifest ${entry.pakKey}, expected ${expectedPakKey})`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(entry.slug)) errors.push(`unsafe audio slug: ${entry.slug}`);
    if (entry.source.startsWith("/") || entry.source.includes("\\") || entry.source.split("/").includes("..")) {
      errors.push(`unsafe audio source path: ${entry.source}`);
    }
    const logicalId = entry.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (logicalIds.has(logicalId)) errors.push(`duplicate logical audio id: ${logicalId}`);
    logicalIds.add(logicalId);
    if (pakKeys.has(entry.pakKey)) errors.push(`duplicate audio pak key: ${entry.pakKey}`);
    pakKeys.add(entry.pakKey);
    const path = join(audioDir, rel);
    if (!existsSync(path)) {
      errors.push(`missing committed blob: ${rel}`);
      continue;
    }
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes) {
      errors.push(`byte count mismatch: ${rel} (manifest ${entry.bytes}, on disk ${bytes.length})`);
    }
    const hash = sha256(bytes);
    if (hash !== entry.sha256) {
      errors.push(`sha256 mismatch: ${rel}\n  manifest ${entry.sha256}\n  on disk  ${hash}`);
    }
    try {
      const metadata = audioBlobMetadata(rel, bytes);
      if (metadata.rate !== manifest.rate) {
        errors.push(`sample rate mismatch: ${rel} (manifest ${manifest.rate}, container ${metadata.rate})`);
      }
      if (metadata.channels !== manifest.channels) {
        errors.push(`channel count mismatch: ${rel} (manifest ${manifest.channels}, container ${metadata.channels})`);
      }
      if (metadata.frames !== entry.frames) {
        errors.push(`frame count mismatch: ${rel} (manifest ${entry.frames}, container ${metadata.frames})`);
      }
      if (metadata.durationSeconds !== entry.durationSeconds) {
        errors.push(
          `duration mismatch: ${rel} (manifest ${entry.durationSeconds}, container ${metadata.durationSeconds})`,
        );
      }
      if (entry.kind === "music") {
        if (entry.loopStartFrame !== 0 || entry.loopEndFrame !== metadata.frames) {
          errors.push(
            `loop range mismatch: ${rel} (expected 0..${metadata.frames}, got ${String(entry.loopStartFrame)}..${String(entry.loopEndFrame)})`,
          );
        }
      } else if (entry.loopStartFrame !== undefined || entry.loopEndFrame !== undefined) {
        errors.push(`unexpected SFX loop range: ${rel}`);
      }
    } catch (error) {
      errors.push(`invalid audio container: ${rel} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const named = new Set(Object.keys(manifest.files));
  for (const sub of ["music", "sounds"]) {
    const dir = join(audioDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const rel = `${sub}/${name}`;
      if (!named.has(rel)) errors.push(`extra committed blob not in manifest: ${rel}`);
    }
  }
  return errors;
}

/** All committed blob paths relative to the audio dir, sorted. */
export function committedBlobPaths(audioDir: string): string[] {
  const out: string[] = [];
  for (const sub of ["music", "sounds"]) {
    const dir = join(audioDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      out.push(relative(audioDir, join(dir, name)).split(sep).join("/"));
    }
  }
  return out;
}

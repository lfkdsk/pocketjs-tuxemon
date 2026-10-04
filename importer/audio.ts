// importer/audio.ts — audio asset resolution for the importer.
//
// The transcode pipeline (tools/transcode-audio.ts) commits every music track
// referenced by imported map/environment content (QOA) and the three used
// SFX (s16 WAV) to assets/audio/. The importer reads its manifest to build the
// Project.audio table: a logical audio id -> pak key map. Invalid upstream
// music arguments get no entry, so they stay silent just as they do in
// Tuxemon while the reducer state machine still tracks them.

import { readFileSync } from "node:fs";

export interface AudioManifestFile {
  slug: string;
  kind: "music" | "sfx";
  source: string;
  pakKey: string;
  bytes: number;
  sha256: string;
  frames: number;
  durationSeconds: number;
  loopStartFrame?: number;
  loopEndFrame?: number;
}

interface AudioManifest {
  format: "pocket-tuxemon/audio-manifest/v2";
  ffmpeg: string;
  rate: number;
  channels: 1;
  files: Record<string, AudioManifestFile>;
}

let cached: AudioManifest | undefined;

/** The committed audio manifest (assets/audio/manifest.json). */
export function audioManifest(): AudioManifest {
  if (cached) return cached;
  cached = JSON.parse(
    readFileSync(new URL("../assets/audio/manifest.json", import.meta.url), "utf8"),
  ) as AudioManifest;
  return cached;
}

/** Sanitize a Tuxemon audio slug into a logical audio id. Mirrors the
 *  play_sound sanitization the importer already used. */
export function audioId(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/** Project.audio table: logical id -> pak key, for every committed asset. */
export function audioTable(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const file of Object.values(audioManifest().files)) {
    table[audioId(file.slug)] = file.pakKey;
  }
  return table;
}

/** Logical ids with a committed asset, for coverage accounting. */
export function audioAssetIds(): Set<string> {
  return new Set(Object.values(audioManifest().files).map((f) => audioId(f.slug)));
}

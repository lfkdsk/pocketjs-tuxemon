// Split the ordinary Web build into one small gzip-compressed startup pack
// plus content-addressed map and music chunks. The startup pack carries the
// complete external directory, so PocketJS keeps its ordinary synchronous pak
// API after the browser host has made a chunk resident.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  pack,
  unpack,
  type PakBlob,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";

export const WEB_PAK_MANIFEST = "pocket-tuxemon.pak-manifest.json";
export const WEB_PAK_REPORT = "pocket-tuxemon.pak-report.json";
export const WEB_STARTUP_MAPS = new Set(["spyder_bedroom"]);
export const WEB_STARTUP_QOA = new Set([
  "audio:qoa.music/music_home.qoa",
  "audio:qoa.music/music_battle_loop.qoa",
  "audio:qoa.music/music_win_battle_boss.qoa",
  "audio:qoa.music/music_gameover.qoa",
]);

const CONTENT_FORMAT = "pocket-pak-chunks/v1" as const;
const MANIFEST_VERSION = 1 as const;
const PAK_HEADER_SIZE = 32;
const PAK_ENTRY_SIZE = 24;
const PAK_ALIGN = 16;

interface ChunkAsset {
  file: string;
  encoding: "gzip";
  bytes: number;
  unpackedBytes: number;
  sha256: string;
}

export interface WebPakChunk extends ChunkAsset {
  id: string;
  entries: string[];
  background: true;
  requires: string[];
}

export interface WebPakManifest {
  version: typeof MANIFEST_VERSION;
  format: typeof CONTENT_FORMAT;
  startup: ChunkAsset;
  chunks: WebPakChunk[];
}

export interface WebPakBuildResult {
  manifest: WebPakManifest;
  manifestPath: string;
  reportPath: string;
  sourceBytes: number;
  startupBytes: number;
  chunkBytes: number;
  entries: number;
}

export interface WebPakBuildOptions {
  pakPath: string;
  projectShellPath: string;
  outDir: string;
  /** Delete the original monolithic pak after every chunk and report exists. */
  removeSource?: boolean;
}

interface ProjectShellAudio {
  audio?: Record<string, string>;
  tileSize?: number;
  worldLayout?: {
    components: Array<{
      placements: Array<{
        mapId: string;
        originTileX: number;
        originTileY: number;
        width: number;
        height: number;
      }>;
    }>;
  };
}

const WEB_VIEWPORT = { w: 480, h: 272 } as const;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const align = (value: number): number => (value + PAK_ALIGN - 1) & ~(PAK_ALIGN - 1);
const textBytes = (value: string): number => Buffer.byteLength(value, "utf8");

function mapEntryId(key: string): string | undefined {
  const match = /^(?:maps|maps-zh)\/([^/]+)\.(?:json|rkm)$/.exec(key);
  return match?.[1];
}

function mapTileId(key: string, idsByLength: readonly string[]): string | undefined {
  const prefix = "ui:tile.tuxemon-";
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  return idsByLength.find((id) => rest === id || rest.startsWith(`${id}-`));
}

function collectStrings(value: unknown, into: Set<string>): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      into.add(next);
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next && typeof next === "object") {
      for (const item of Object.values(next)) pending.push(item);
    }
  }
}

function mapAudioDependencies(
  entries: readonly PakBlob[],
  audio: Readonly<Record<string, string>>,
  audioChunkByKey: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.key.startsWith("maps/")) continue;
    const mapId = mapEntryId(entry.key)!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(entry.data));
    } catch {
      throw new Error(`web chunks: ${entry.key} is not JSON`);
    }
    const strings = new Set<string>();
    collectStrings(parsed, strings);
    const required = new Set<string>();
    for (const id of strings) {
      const pakKey = audio[id];
      const chunk = pakKey ? audioChunkByKey.get(pakKey) : undefined;
      if (chunk) required.add(chunk);
    }
    dependencies.set(mapId, [...required].sort());
  }
  return dependencies;
}

/**
 * Conservative presentation working set for a placed map. Any placement
 * within one Web viewport of the active placement can become visible while
 * the camera follows the player or settles at a component edge. Those
 * TILESET chunks must be resident before the reducer publishes the map: the
 * synchronous renderer treats a missing TILESET as transparent and cannot
 * let background-network timing decide which pixels a recorded frame sees.
 */
function mapVisualDependencies(
  project: ProjectShellAudio,
  mapIds: ReadonlySet<string>,
): Map<string, string[]> {
  const tileSize = project.tileSize ?? 16;
  if (!Number.isSafeInteger(tileSize) || tileSize < 1) {
    throw new Error(`web chunks: project tileSize must be a positive integer, got ${tileSize}`);
  }
  const dependencies = new Map<string, string[]>();
  for (const component of project.worldLayout?.components ?? []) {
    for (const active of component.placements) {
      if (!mapIds.has(active.mapId)) continue;
      const left = active.originTileX * tileSize - WEB_VIEWPORT.w;
      const top = active.originTileY * tileSize - WEB_VIEWPORT.h;
      const right = (active.originTileX + active.width) * tileSize + WEB_VIEWPORT.w;
      const bottom = (active.originTileY + active.height) * tileSize + WEB_VIEWPORT.h;
      const visible = component.placements.flatMap((candidate) => {
        if (!mapIds.has(candidate.mapId)) return [];
        const candidateLeft = candidate.originTileX * tileSize;
        const candidateTop = candidate.originTileY * tileSize;
        const candidateRight = (candidate.originTileX + candidate.width) * tileSize;
        const candidateBottom = (candidate.originTileY + candidate.height) * tileSize;
        return candidateLeft < right && candidateRight > left &&
            candidateTop < bottom && candidateBottom > top
          ? [candidate.mapId]
          : [];
      });
      dependencies.set(active.mapId, [...new Set(visible)].sort());
    }
  }
  return dependencies;
}

function categoryOf(key: string, mapTile: boolean): string {
  if (key.startsWith("maps/") || key.startsWith("maps-zh/") ||
      key.startsWith("terrain-stream/") || key.startsWith("animated/") || mapTile) {
    return "maps-and-tiles";
  }
  if (key.startsWith("audio:qoa.")) return "bgm";
  if (key.startsWith("audio:wav.")) return "sound-effects";
  if (key.startsWith("ui:font.") || key.startsWith("license:NotoSansCJK")) return "fonts";
  if (key.startsWith("demo/")) return "demo-tapes";
  if (key.startsWith("l10n/") || key.startsWith("battle-zh/")) return "localization";
  if (key.startsWith("battle/") || key === "game:battle-db" ||
      key.startsWith("portraits/") || key.startsWith("choice-icons/") ||
      key.startsWith("ui:tile.battle/")) return "battle-art-and-data";
  if (key.startsWith("ui:img.") || key.startsWith("ui:sprite.") || key.startsWith("npc-src/")) {
    return "character-and-ui-art";
  }
  return "other";
}

function pakCategoryBytes(
  entries: readonly PakBlob[],
  idsByLength: readonly string[],
): Record<string, { entries: number; bytes: number }> {
  const categories: Record<string, { entries: number; bytes: number }> = {};
  const namesBytes = entries.reduce((sum, entry) => sum + textBytes(entry.key), 0);
  const globalBytes = PAK_HEADER_SIZE + align(PAK_HEADER_SIZE + entries.length * PAK_ENTRY_SIZE + namesBytes) -
    (PAK_HEADER_SIZE + entries.length * PAK_ENTRY_SIZE + namesBytes);
  categories.container = { entries: 0, bytes: globalBytes };
  for (const entry of entries) {
    const category = categoryOf(entry.key, mapTileId(entry.key, idsByLength) !== undefined);
    const current = categories[category] ?? (categories[category] = { entries: 0, bytes: 0 });
    current.entries++;
    current.bytes += PAK_ENTRY_SIZE + textBytes(entry.key) + align(entry.data.byteLength);
  }
  return Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)));
}

function writeCompressedPak(
  chunksDir: string,
  stem: string,
  entries: readonly PakBlob[],
): { asset: ChunkAsset; entries: string[] } {
  const unpacked = pack([...entries]);
  const compressed = gzipSync(unpacked, { level: 9 });
  const hash = sha256(compressed);
  const name = `${stem}-${hash}.pak.gz`;
  writeFileSync(join(chunksDir, name), compressed);
  return {
    asset: {
      file: `chunks/${name}`,
      encoding: "gzip",
      bytes: compressed.byteLength,
      unpackedBytes: unpacked.byteLength,
      sha256: hash,
    },
    entries: entries.map((entry) => entry.key).sort(),
  };
}

const MAP_BACKGROUND_PRIORITY = [
  "spyder_downstairs",
  "spyder_paper_town",
  "spyder_paper_rival_downstairs",
  "spyder_paper_rival_bedroom",
  "spyder_route1",
];

function mapOrder(a: string, b: string): number {
  const ai = MAP_BACKGROUND_PRIORITY.indexOf(a);
  const bi = MAP_BACKGROUND_PRIORITY.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
    (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  return a.localeCompare(b);
}

export function buildWebPakChunks(options: WebPakBuildOptions): WebPakBuildResult {
  const source = readFileSync(options.pakPath);
  const entries = unpack(source);
  const mapIds = entries.flatMap((entry) => entry.key.startsWith("maps/")
    ? [mapEntryId(entry.key)!]
    : []);
  const mapIdSet = new Set(mapIds);
  if (mapIdSet.size !== mapIds.length || mapIds.length === 0) {
    throw new Error("web chunks: the ordinary pak has missing or duplicate map entries");
  }
  for (const startup of WEB_STARTUP_MAPS) {
    if (!mapIdSet.has(startup)) throw new Error(`web chunks: startup map ${startup} is missing`);
  }
  const idsByLength = [...mapIds].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const project = JSON.parse(readFileSync(options.projectShellPath, "utf8")) as ProjectShellAudio;
  const audio = project.audio ?? {};
  const placedMaps = new Set(
    project.worldLayout?.components.flatMap((component) =>
      component.placements.map((placement) => placement.mapId)) ?? [],
  );

  const mapGroups = new Map<string, PakBlob[]>();
  const visualGroups = new Map<string, PakBlob[]>();
  const audioGroups = new Map<string, PakBlob[]>();
  const startupEntries: PakBlob[] = [];
  const deferredEntries: PakBlob[] = [];
  const audioChunkByKey = new Map<string, string>();
  for (const entry of entries) {
    if (entry.key.startsWith("audio:qoa.") && !WEB_STARTUP_QOA.has(entry.key)) {
      const id = `audio:${entry.key.slice("audio:qoa.".length)}`;
      audioGroups.set(id, [entry]);
      audioChunkByKey.set(entry.key, id);
    }
  }
  for (const entry of entries) {
    const entryMap = mapEntryId(entry.key);
    const tileMap = mapTileId(entry.key, idsByLength);
    const mapId = entryMap ?? tileMap;
    if (mapId && !WEB_STARTUP_MAPS.has(mapId)) {
      const groups = tileMap && placedMaps.has(mapId) ? visualGroups : mapGroups;
      const group = groups.get(mapId) ?? [];
      group.push(entry);
      groups.set(mapId, group);
      deferredEntries.push(entry);
    } else if (audioChunkByKey.has(entry.key)) {
      deferredEntries.push(entry);
    } else {
      startupEntries.push(entry);
    }
  }

  for (const mapId of mapIds) {
    if (WEB_STARTUP_MAPS.has(mapId)) continue;
    const group = mapGroups.get(mapId);
    if (!group || !group.some((entry) => entry.key.startsWith("maps/")) ||
        !group.some((entry) => entry.key.startsWith("maps-zh/"))) {
      throw new Error(`web chunks: map chunk ${mapId} does not contain both language shards`);
    }
  }
  if (startupEntries.length + deferredEntries.length !== entries.length) {
    throw new Error("web chunks: partition did not cover the full pak");
  }

  const externalPak = pack(deferredEntries);
  const dataOffset = new DataView(
    externalPak.buffer,
    externalPak.byteOffset,
    externalPak.byteLength,
  ).getUint32(20, true);
  if (dataOffset < PAK_HEADER_SIZE || dataOffset > externalPak.byteLength) {
    throw new Error("web chunks: external pak has an invalid directory prefix");
  }
  startupEntries.push({
    key: "pocket:external-index",
    dtype: 0,
    data: externalPak.slice(0, dataOffset),
  });

  const chunksDir = join(options.outDir, "chunks");
  rmSync(chunksDir, { recursive: true, force: true });
  mkdirSync(chunksDir, { recursive: true });
  const startup = writeCompressedPak(chunksDir, "startup", startupEntries).asset;
  const dependencies = mapAudioDependencies(entries, audio, audioChunkByKey);
  const visualDependencies = mapVisualDependencies(project, mapIdSet);
  const chunks: WebPakChunk[] = [];
  for (const mapId of [...mapGroups.keys()].sort(mapOrder)) {
    const written = writeCompressedPak(chunksDir, `map-${mapId}`, mapGroups.get(mapId)!);
    chunks.push({
      id: `map:${mapId}`,
      ...written.asset,
      entries: written.entries,
      background: true,
      requires: [
        ...(visualDependencies.get(mapId) ?? [])
          .filter((candidate) => visualGroups.has(candidate))
          .map((candidate) => `visual:${candidate}`),
        ...(dependencies.get(mapId) ?? []),
      ].sort(),
    });
    const visuals = visualGroups.get(mapId);
    if (visuals) {
      const visual = writeCompressedPak(chunksDir, `visual-${mapId}`, visuals);
      chunks.push({
        id: `visual:${mapId}`,
        ...visual.asset,
        entries: visual.entries,
        background: true,
        requires: [],
      });
    }
  }
  for (const [id, group] of [...audioGroups].sort(([a], [b]) => a.localeCompare(b))) {
    const safeId = id.slice("audio:".length).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const written = writeCompressedPak(chunksDir, `audio-${safeId}`, group);
    chunks.push({
      id,
      ...written.asset,
      entries: written.entries,
      background: true,
      requires: [],
    });
  }
  const manifest: WebPakManifest = {
    version: MANIFEST_VERSION,
    format: CONTENT_FORMAT,
    startup,
    chunks,
  };
  const manifestPath = join(options.outDir, WEB_PAK_MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const chunkBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const report = {
    format: "pocket-tuxemon-web-pak-report/v1",
    source: {
      file: basename(options.pakPath),
      entries: entries.length,
      bytes: source.byteLength,
      sha256: sha256(source),
      categories: pakCategoryBytes(entries, idsByLength),
    },
    startup: {
      maps: [...WEB_STARTUP_MAPS].sort(),
      qoa: [...WEB_STARTUP_QOA].sort(),
      entries: startupEntries.length,
      bytes: startup.bytes,
      unpackedBytes: startup.unpackedBytes,
      file: startup.file,
    },
    deferred: {
      entries: deferredEntries.length,
      chunks: chunks.length,
      mapChunks: mapGroups.size,
      visualChunks: visualGroups.size,
      audioChunks: audioGroups.size,
      bytes: chunkBytes,
      unpackedBytes: chunks.reduce((sum, chunk) => sum + chunk.unpackedBytes, 0),
    },
  };
  const reportPath = join(options.outDir, WEB_PAK_REPORT);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (startup.bytes > 10_000_000) {
    throw new Error(`web chunks: startup pack is ${startup.bytes} bytes (limit 10000000)`);
  }
  if (options.removeSource) unlinkSync(options.pakPath);
  return {
    manifest,
    manifestPath,
    reportPath,
    sourceBytes: source.byteLength,
    startupBytes: startup.bytes,
    chunkBytes,
    entries: entries.length,
  };
}

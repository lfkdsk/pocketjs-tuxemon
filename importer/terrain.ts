// Tuxemon TMX terrain importer.
//
// The source checkout is immutable input.  Every visible tile layer is
// composited in document order, with pytmx layer indices 0..2 below actors
// and indices >2 above them.  The resulting 256px RGBA chunks are handed to
// Pocket RPG Kit's canonical CLUT8 + PackBits encoder.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { gunzipSync, gzipSync, inflateSync } from "node:zlib";
import { blitTile } from "../vendor/pocket-rpgkit/tools/lib/chunks.ts";
import {
  encodeStreamedLayer,
  pakManifest,
  streamEntryFile,
  type PakManifestEntry,
  type StreamEntry,
  type StreamedLayer,
  type StreamManifestMap,
} from "../vendor/pocket-rpgkit/tools/lib/stream.ts";
import { pack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { PAK_DTYPE } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import type { Dir, MapDef, Project, Sheet, TileId } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { decodePng, type RgbaImage } from "./png.ts";
import { child, children, parseXml, type XmlNode } from "./xml.ts";

export const TILE_PX = 16;
export const TERRAIN_SHEET_ID = "tuxemon-passage";
export const TERRAIN_FORMAT = "tuxemon-terrain/v1";
// Defaults to the repo-local checkout created by tools/fetch-tuxemon.sh;
// set TUXEMON_SRC to point at an existing Tuxemon checkout instead.
export const DEFAULT_TUXEMON_SRC = resolve(import.meta.dir, "../.tuxemon-src");

const FLIP_H = 0x8000_0000;
const FLIP_V = 0x4000_0000;
const FLIP_D = 0x2000_0000;
const GID_MASK = 0x1fff_ffff;
const LAYER_TAGS = new Set(["layer", "objectgroup", "imagelayer", "group"]);
const ALL_DIRS = ["down", "left", "up", "right"] as const satisfies readonly Dir[];
const DIR_BIT: Readonly<Record<Dir, number>> = { down: 1, left: 2, up: 4, right: 8 };
const OPPOSITE: Readonly<Record<Dir, Dir>> = { down: "up", left: "right", up: "down", right: "left" };
const DX: Readonly<Record<Dir, number>> = { down: 0, left: -1, up: 0, right: 1 };
const DY: Readonly<Record<Dir, number>> = { down: 1, left: 0, up: -1, right: 0 };
const REGION_KEYS = new Set([
  "enter_from", "exit_from", "endure", "key", "push_direction",
  "push_strength", "speed_modifier", "hop",
]);
const SURFACE_KEYS = new Set(["surfable", "walkable", "climbable"]);

interface AnimationFrame {
  tileId: number;
  durationMs: number;
}
interface TileTemplate {
  name: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  tileCount: number;
  imagePath: string;
  properties: Map<number, Readonly<Record<string, string>>>;
  animations: Map<number, readonly AnimationFrame[]>;
  cells: Map<string, Uint8Array>;
}

interface MapTileset extends TileTemplate {
  firstGid: number;
}

interface TileLayer {
  node: XmlNode;
  index: number;
  visible: boolean;
  opacity: number;
  gids: Uint32Array;
}

interface Region {
  enterFrom: ReadonlySet<Dir>;
  exitFrom: ReadonlySet<Dir>;
  endure: readonly Dir[];
  key: string | null;
}

type CollisionCell = Region | null | undefined;

export interface AnimatedTerrainCell {
  x: number;
  y: number;
  above: boolean;
  /** Stable in-memory/cooked sequence id used by the R2 atlas manifest. */
  sequence: string;
  frames: readonly { tile: number; durationMs: number }[];
}

export interface TerrainAnimationSequence {
  id: string;
  frames: readonly { rgba: Uint8Array; durationMs: number }[];
}

export interface TerrainMapPatch extends Pick<MapDef, "id" | "width" | "height" | "ground"> {
  passage: [number, "pass" | "block"][];
  sheets: [typeof TERRAIN_SHEET_ID];
  /** Label -> row-major cells. G1 turns these into removable blocking events. */
  collisionLabels: Readonly<Record<string, readonly number[]>>;
  /** Tuxemon surface property -> every row-major cell carrying that key. */
  surfaceLabels: Readonly<Record<string, readonly number[]>>;
}

export interface TerrainFragment {
  format: typeof TERRAIN_FORMAT;
  sourceRevision: string;
  tileSize: typeof TILE_PX;
  sheet: Sheet;
  maps: TerrainMapPatch[];
}

export interface LayerReport {
  colours: number;
  split: boolean;
  absent: number;
  entries: number;
  bytes: number;
  quantized: number;
}

export interface TerrainMapReport {
  width: number;
  height: number;
  tileLayers: number;
  hiddenLayers: number;
  opacityLayers: number;
  groundDraws: number;
  upperDraws: number;
  flipCells: number;
  animatedCells: number;
  collisionCells: number;
  directionalCells: number;
  collisionLineEdges: number;
  yamlCollisionCells: number;
  labelledCollisionCells: number;
  oneWayEdges: number;
  directedEdgeMismatches: number;
  ground: LayerReport;
  upper: LayerReport;
}

export interface TerrainReport {
  source: string;
  sourceRevision: string;
  chunkPx: number;
  maps: number;
  cells: number;
  entries: number;
  rawEntryBytes: number;
  pakBytes: number;
  gzipBytes: number;
  quantizedChunks: number;
  animatedCellsBakedAtFirstFrame: number;
  flipCells: number;
  collisionCells: number;
  directionalCells: number;
  collisionLineEdges: number;
  yamlCollisionCells: number;
  labelledCollisionCells: number;
  oneWayEdgesEncoded: number;
  directedEdgeMismatches: number;
  byMap: Record<string, TerrainMapReport>;
}

export interface TerrainBuild {
  entries: StreamEntry[];
  streamMaps: StreamManifestMap[];
  fragment: TerrainFragment;
  animations: Readonly<Record<string, readonly AnimatedTerrainCell[]>>;
  /** Pixel frames stay in memory for the asset cooker; terrain-animations.json
   *  records only placements/tile ids and therefore remains inspectable. */
  animationSequences: readonly TerrainAnimationSequence[];
  report: TerrainReport;
}

export interface StreamRefIndexEntry {
  id: string;
  entry: string;
}

export interface TerrainStreamMeta {
  chunkPx: number;
  columns: Readonly<Record<string, number>>;
}

interface StreamRefSplitEntry {
  path: string;
  bytes: Uint8Array;
  meta: StreamRefIndexEntry;
}

interface StreamRefSplit {
  groundIndex: readonly StreamRefIndexEntry[];
  upperIndex: readonly StreamRefIndexEntry[];
  columns: Readonly<Record<string, number>>;
  chunkPx: number;
  entries: readonly StreamRefSplitEntry[];
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + "\n");
}

/** GP1 fix 1: `StreamedGameAssets.ground`/`.upper` used to bundle every
 * map's chunk-ref list as one eager literal (~90 KB — the largest remaining
 * game-repo input after animated tiles and NPC sprites). StreamedChunkLayer
 * and OccludingUpperLayer only ever read `refs[mapId]`/`stream.upper[mapId]`
 * for the current map (see vendor/pocket-rpgkit/src/ui/StreamedChunkLayer.tsx
 * and OccludingUpperLayer.tsx), never an enumeration, so this splits both
 * tables the same way animated tiles and NPC sprites are split: one
 * canonical entry per map id per layer. `columns`/`chunkPx` stay inline —
 * they are small (one integer per map) and every map needs its own.
 * streamManifestSource (vendor/pocket-rpgkit/tools/lib/stream.ts) still
 * produces the single-literal form; it is unused on this split path. */
function splitStreamRefs(maps: readonly StreamManifestMap[], chunkPx: number): StreamRefSplit {
  const groundIndex: StreamRefIndexEntry[] = [];
  const upperIndex: StreamRefIndexEntry[] = [];
  const columns: Record<string, number> = {};
  const entries: StreamRefSplitEntry[] = [];
  for (const map of [...maps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    columns[map.id] = map.ground.columns;
    for (const [kind, layer, index] of [
      ["ground", map.ground, groundIndex],
      ["upper", map.upper, upperIndex],
    ] as const) {
      const path = `terrain-stream/${kind}/${map.id}.json`;
      const meta: StreamRefIndexEntry = { id: map.id, entry: path };
      index.push(meta);
      entries.push({ path, bytes: jsonBytes(layer.refs), meta });
    }
  }
  return { groundIndex, upperIndex, columns, chunkPx, entries };
}

/** GP1 fix 2: the TILESET pak keys one ground/upper stream shard's refs
 *  resolve to (each ref is `<pak key>#<frame>`; absent chunks are `null`).
 *  encodeStreamedLayer (vendor/pocket-rpgkit/tools/lib/stream.ts) always
 *  pairs a produced ref with a same-keyed pak entry, so this set should
 *  equal the shard's map of `ui:tile.*` keys in pak.json — used to
 *  cross-check that terrain-stream shards never reference a pak entry that
 *  was pruned or renamed. */
export function collectStreamRefKeys(refs: readonly (string | null)[]): readonly string[] {
  return refs.filter((ref): ref is string => ref !== null).map((ref) => ref.replace(/#\d+$/, ""));
}

export interface GenerateTerrainOptions {
  sourceRoot?: string;
  sourceRevision?: string;
  chunkPx?: number;
  mapIds?: readonly string[];
}

export interface WriteTerrainOptions extends GenerateTerrainOptions {
  outputRoot: string;
}

function requiredAttr(node: XmlNode, name: string): string {
  const value = node.attrs[name];
  if (value === undefined) throw new Error(`<${node.name}> is missing ${name}`);
  return value;
}

function integerAttr(node: XmlNode, name: string, fallback?: number): number {
  const raw = node.attrs[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`<${node.name}> has invalid ${name}=${JSON.stringify(raw)}`);
  return value;
}

function numberAttr(node: XmlNode, name: string, fallback = 0): number {
  const raw = node.attrs[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`<${node.name}> has invalid ${name}=${JSON.stringify(raw)}`);
  return value;
}

function readXml(path: string): XmlNode {
  return parseXml(readFileSync(path, "utf8"), path);
}

function nodeProperties(node: XmlNode): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const root = child(node, "properties");
  if (!root) return out;
  for (const property of children(root, "property")) {
    const name = requiredAttr(property, "name");
    out[name] = property.attrs.value ?? property.text.trim();
  }
  return out;
}

function directionList(raw: string | undefined): Dir[] {
  if (!raw?.trim()) return [];
  const found = new Set<Dir>();
  for (const value of raw.split(",")) {
    const direction = value.trim().toLowerCase();
    if (!ALL_DIRS.includes(direction as Dir)) throw new Error(`unknown direction ${JSON.stringify(value)}`);
    found.add(direction as Dir);
  }
  return ALL_DIRS.filter((direction) => found.has(direction));
}

function regionFromProperties(properties: Readonly<Record<string, string>>): Region | undefined {
  if (![...REGION_KEYS].some((key) => Object.hasOwn(properties, key))) return undefined;
  const key = properties.key?.trim().toLowerCase() || null;
  if (key === "slide") {
    return { enterFrom: new Set(ALL_DIRS), exitFrom: new Set(ALL_DIRS), endure: ALL_DIRS, key };
  }
  let enterFrom = directionList(properties.enter_from);
  const exitFrom = directionList(properties.exit_from);
  const endure = directionList(properties.endure);
  if (exitFrom.length && !enterFrom.length && !properties.enter_from?.trim()) {
    enterFrom = ALL_DIRS.filter((direction) => !exitFrom.includes(direction));
  }
  return { enterFrom: new Set(enterFrom), exitFrom: new Set(exitFrom), endure, key };
}

function parseTilesetTemplate(node: XmlNode, baseDir: string): TileTemplate {
  const image = child(node, "image");
  if (!image) throw new Error(`tileset ${node.attrs.name ?? "?"} has no sheet image`);
  const properties = new Map<number, Readonly<Record<string, string>>>();
  const animations = new Map<number, readonly AnimationFrame[]>();
  for (const tile of children(node, "tile")) {
    const id = integerAttr(tile, "id");
    const props = nodeProperties(tile);
    if (Object.keys(props).length) properties.set(id, props);
    const animation = child(tile, "animation");
    if (animation) {
      animations.set(id, children(animation, "frame").map((frame) => ({
        tileId: integerAttr(frame, "tileid"),
        durationMs: integerAttr(frame, "duration"),
      })));
    }
  }
  return {
    name: node.attrs.name ?? "unnamed",
    tileWidth: integerAttr(node, "tilewidth"),
    tileHeight: integerAttr(node, "tileheight"),
    columns: integerAttr(node, "columns", 0),
    tileCount: integerAttr(node, "tilecount", 0),
    imagePath: normalize(join(baseDir, requiredAttr(image, "source"))),
    properties,
    animations,
    cells: new Map(),
  };
}

function parseMapTilesets(root: XmlNode, mapDir: string, cache: Map<string, TileTemplate>): MapTileset[] {
  const out: MapTileset[] = [];
  for (const mapNode of children(root, "tileset")) {
    const firstGid = integerAttr(mapNode, "firstgid");
    const source = mapNode.attrs.source;
    let template: TileTemplate;
    if (source) {
      const path = normalize(join(mapDir, source));
      const hit = cache.get(path);
      if (hit) template = hit;
      else {
        const tsx = readXml(path);
        if (tsx.name !== "tileset") throw new Error(`${path}: expected <tileset>`);
        template = parseTilesetTemplate(tsx, dirname(path));
        cache.set(path, template);
      }
    } else {
      template = parseTilesetTemplate(mapNode, mapDir);
    }
    if (template.tileWidth !== TILE_PX || template.tileHeight !== TILE_PX) {
      throw new Error(`tileset ${template.name} is ${template.tileWidth}x${template.tileHeight}, expected 16x16`);
    }
    out.push({ ...template, firstGid });
  }
  return out.sort((a, b) => a.firstGid - b.firstGid);
}

function decodeLayerData(layer: XmlNode, width: number, height: number): Uint32Array {
  const data = child(layer, "data");
  if (!data) throw new Error(`layer ${layer.attrs.name ?? "?"} has no data`);
  let out: Uint32Array;
  if (data.attrs.encoding === "base64") {
    let bytes = new Uint8Array(Buffer.from(data.text.replace(/\s/g, ""), "base64"));
    if (data.attrs.compression === "zlib") bytes = new Uint8Array(inflateSync(bytes));
    else if (data.attrs.compression === "gzip") bytes = new Uint8Array(gunzipSync(bytes));
    else if (data.attrs.compression) throw new Error(`unsupported TMX compression ${data.attrs.compression}`);
    if (bytes.byteLength % 4) throw new Error(`layer byte length ${bytes.byteLength} is not u32-aligned`);
    out = new Uint32Array(bytes.byteLength / 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  } else if (data.attrs.encoding === "csv") {
    out = Uint32Array.from(data.text.split(",").map((value) => value.trim()).filter(Boolean).map(Number));
  } else if (!data.attrs.encoding) {
    out = Uint32Array.from(children(data, "tile").map((tile) => integerAttr(tile, "gid", 0)));
  } else {
    throw new Error(`unsupported TMX encoding ${data.attrs.encoding}`);
  }
  if (out.length !== width * height) throw new Error(`layer has ${out.length} cells, expected ${width * height}`);
  return out;
}

function mapLayers(root: XmlNode, width: number, height: number): TileLayer[] {
  const out: TileLayer[] = [];
  let index = 0;
  for (const node of root.children) {
    if (!LAYER_TAGS.has(node.name)) continue;
    if (node.name === "layer") {
      out.push({
        node,
        index,
        visible: node.attrs.visible !== "0",
        opacity: numberAttr(node, "opacity", 1),
        gids: decodeLayerData(node, width, height),
      });
    }
    index++;
  }
  return out;
}

function resolveTile(tilesets: readonly MapTileset[], gid: number): { tileset: MapTileset; localId: number } {
  for (let i = tilesets.length - 1; i >= 0; i--) {
    const tileset = tilesets[i]!;
    if (gid >= tileset.firstGid) return { tileset, localId: gid - tileset.firstGid };
  }
  throw new Error(`unresolved gid ${gid}`);
}

function imageFor(path: string, cache: Map<string, RgbaImage>): RgbaImage {
  const hit = cache.get(path);
  if (hit) return hit;
  const image = decodePng(new Uint8Array(readFileSync(path)), path);
  cache.set(path, image);
  return image;
}

function baseCell(tileset: MapTileset, localId: number, imageCache: Map<string, RgbaImage>): Uint8Array {
  const key = `base:${localId}`;
  const hit = tileset.cells.get(key);
  if (hit) return hit;
  const image = imageFor(tileset.imagePath, imageCache);
  const columns = tileset.columns || Math.floor(image.width / TILE_PX);
  const x0 = (localId % columns) * TILE_PX;
  const y0 = Math.floor(localId / columns) * TILE_PX;
  const out = new Uint8Array(TILE_PX * TILE_PX * 4);
  if (x0 + TILE_PX <= image.width && y0 + TILE_PX <= image.height) {
    for (let y = 0; y < TILE_PX; y++) {
      const source = ((y0 + y) * image.width + x0) * 4;
      out.set(image.rgba.subarray(source, source + TILE_PX * 4), y * TILE_PX * 4);
    }
  }
  tileset.cells.set(key, out);
  return out;
}

function transformedCell(
  tileset: MapTileset,
  localId: number,
  flags: number,
  opacity: number,
  imageCache: Map<string, RgbaImage>,
): Uint8Array {
  const key = `${localId}:${flags >>> 0}:${opacity}`;
  const hit = tileset.cells.get(key);
  if (hit) return hit;
  const source = baseCell(tileset, localId, imageCache);
  const out = new Uint8Array(source.length);
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      let sx = x;
      let sy = y;
      // Inverse of transpose -> horizontal -> vertical, matching pytmx and
      // the independent S2 reference compositor.
      if (flags & FLIP_V) sy = TILE_PX - 1 - sy;
      if (flags & FLIP_H) sx = TILE_PX - 1 - sx;
      if (flags & FLIP_D) [sx, sy] = [sy, sx];
      const from = (sy * TILE_PX + sx) * 4;
      const to = (y * TILE_PX + x) * 4;
      out[to] = source[from]!;
      out[to + 1] = source[from + 1]!;
      out[to + 2] = source[from + 2]!;
      out[to + 3] = opacity === 1 ? source[from + 3]! : Math.trunc(source[from + 3]! * opacity);
    }
  }
  tileset.cells.set(key, out);
  return out;
}

function chunkGrid(width: number, height: number, chunkPx: number): {
  columns: number;
  rows: number;
  ground: Uint8Array[];
  upper: Uint8Array[];
} {
  const columns = Math.ceil((width * TILE_PX) / chunkPx);
  const rows = Math.ceil((height * TILE_PX) / chunkPx);
  const make = (): Uint8Array[] => Array.from(
    { length: columns * rows },
    () => new Uint8Array(chunkPx * chunkPx * 4),
  );
  return { columns, rows, ground: make(), upper: make() };
}

function drawCell(chunks: Uint8Array[], columns: number, chunkPx: number, x: number, y: number, art: Uint8Array): void {
  const px = x * TILE_PX;
  const py = y * TILE_PX;
  const cx = Math.floor(px / chunkPx);
  const cy = Math.floor(py / chunkPx);
  blitTile(chunks[cy * columns + cx]!, chunkPx, px % chunkPx, py % chunkPx, art);
}

function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function gridPoint(value: number): number {
  return pythonRound(value / TILE_PX);
}

function objectSize(node: XmlNode): { width: number; height: number } {
  if (node.attrs.width !== undefined || node.attrs.height !== undefined) {
    return { width: numberAttr(node, "width"), height: numberAttr(node, "height") };
  }
  const polygon = child(node, "polygon");
  if (!polygon) return { width: 0, height: 0 };
  const points = parsePoints(requiredAttr(polygon, "points"));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function parsePoints(source: string): [number, number][] {
  return source.trim().split(/\s+/).filter(Boolean).map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad point ${JSON.stringify(pair)}`);
    return [x!, y!];
  });
}

function setLineMask(masks: Uint8Array, width: number, height: number, x: number, y: number, direction: Dir): void {
  if (x >= 0 && y >= 0 && x < width && y < height) masks[y * width + x] |= DIR_BIT[direction];
}

function addCollisionLine(
  object: XmlNode,
  lineMasks: Uint8Array,
  width: number,
  height: number,
): number {
  const polyline = child(object, "polyline");
  if (!polyline) return 0;
  const ox = numberAttr(object, "x");
  const oy = numberAttr(object, "y");
  const points = parsePoints(requiredAttr(polyline, "points")).map(([x, y]) => [gridPoint(x + ox), gridPoint(y + oy)] as const);
  let edges = 0;
  for (let p = 0; p + 1 < points.length; p++) {
    let [x0, y0] = points[p]!;
    let [x1, y1] = points[p + 1]!;
    if (x0 > x1 || (x0 === x1 && y0 > y1)) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    if (x0 === x1) {
      for (let y = y0; y < y1; y++) {
        setLineMask(lineMasks, width, height, x0, y, "left");
        setLineMask(lineMasks, width, height, x0 - 1, y, "right");
        edges++;
      }
    } else if (y0 === y1) {
      for (let x = x0; x < x1; x++) {
        setLineMask(lineMasks, width, height, x, y0, "up");
        setLineMask(lineMasks, width, height, x, y0 - 1, "down");
        edges++;
      }
    } else {
      throw new Error(`collision line is not axis-aligned: ${x0},${y0} -> ${x1},${y1}`);
    }
  }
  return edges;
}

function tileCollision(
  root: XmlNode,
  yamlPath: string,
  layers: readonly TileLayer[],
  tilesets: readonly MapTileset[],
  width: number,
  height: number,
): {
  cells: CollisionCell[];
  lineMasks: Uint8Array;
  lineEdges: number;
  yamlCells: number;
  labels: Record<string, number[]>;
  surfaceLabels: Record<string, number[]>;
} {
  const staticCells: CollisionCell[] = new Array(width * height);
  const surfaces: (Readonly<Record<string, string>> | undefined)[] = new Array(width * height);
  for (const layer of layers) {
    if (!layer.visible) continue;
    for (let index = 0; index < layer.gids.length; index++) {
      const raw = layer.gids[index]!;
      const gid = raw & GID_MASK;
      if (!gid) continue;
      const { tileset, localId } = resolveTile(tilesets, gid);
      const props = tileset.properties.get(localId);
      if (!props) continue;
      const surface: Record<string, string> = {};
      for (const key of SURFACE_KEYS) if (Object.hasOwn(props, key)) surface[key] = props[key]!;
      if (Object.keys(surface).length) surfaces[index] = surface;
      const region = regionFromProperties(props);
      if (region) staticCells[index] = region;
    }
  }

  const cells: CollisionCell[] = surfaces.map((surface) =>
    surface && Object.values(surface).some((value) => Number(value) === 0) ? null : undefined,
  );
  for (let i = 0; i < staticCells.length; i++) {
    if (staticCells[i] !== undefined) cells[i] = staticCells[i];
  }

  const lineMasks = new Uint8Array(width * height);
  let lineEdges = 0;
  for (const group of children(root, "objectgroup")) {
    for (const object of children(group, "object")) {
      const type = object.attrs.type?.toLowerCase() ?? "";
      if (!type.startsWith("collision")) continue;
      const polyline = child(object, "polyline");
      if (polyline) {
        lineEdges += addCollisionLine(object, lineMasks, width, height);
        continue;
      }
      const { width: objectWidth, height: objectHeight } = objectSize(object);
      const left = gridPoint(numberAttr(object, "x"));
      const top = gridPoint(numberAttr(object, "y"));
      const right = gridPoint(numberAttr(object, "x") + objectWidth);
      const bottom = gridPoint(numberAttr(object, "y") + objectHeight);
      const props = nodeProperties(object);
      const region = regionFromProperties(props) ?? null;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = region;
        }
      }
    }
  }

  // The map loader overlays same-name YAML collision rectangles after TMX
  // collision data. Keeping that order matters if a legacy YAML cell lands
  // on a directional TMX region.
  let yamlCells = 0;
  if (existsSync(yamlPath)) {
    const document = Bun.YAML.parse(readFileSync(yamlPath, "utf8")) as {
      collisions?: readonly { x?: number; y?: number; width?: number; height?: number }[];
    } | null;
    for (const collision of document?.collisions ?? []) {
      const x0 = Math.trunc(collision.x ?? 0);
      const y0 = Math.trunc(collision.y ?? 0);
      const objectWidth = Math.trunc(collision.width ?? 1);
      const objectHeight = Math.trunc(collision.height ?? 1);
      if (objectWidth < 0 || objectHeight < 0) throw new Error(`${yamlPath}: negative collision extent`);
      for (let y = y0; y < y0 + objectHeight; y++) {
        for (let x = x0; x < x0 + objectWidth; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          cells[y * width + x] = null;
          yamlCells++;
        }
      }
    }
  }

  const labels: Record<string, number[]> = {};
  for (let i = 0; i < cells.length; i++) {
    const region = cells[i];
    if (region?.key && region.key !== "slide") (labels[region.key] ??= []).push(i);
  }
  const surfaceLabels: Record<string, number[]> = {};
  for (let i = 0; i < surfaces.length; i++) {
    for (const label of Object.keys(surfaces[i] ?? {}).sort()) {
      (surfaceLabels[label] ??= []).push(i);
    }
  }
  return { cells, lineMasks, lineEdges, yamlCells, labels, surfaceLabels };
}

function tuxCanStep(
  cells: readonly CollisionCell[],
  lineMasks: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  direction: Dir,
): boolean {
  const nx = x + DX[direction];
  const ny = y + DY[direction];
  if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
  const sourceIndex = y * width + x;
  const targetIndex = ny * width + nx;
  const source = cells[sourceIndex];
  if (source) {
    const exits = new Set(source.exitFrom);
    if (source.endure.length === 1) exits.add(source.endure[0]!);
    else if (source.endure.length > 1) exits.add(direction);
    if (exits.size && !exits.has(direction)) return false;
  }
  if (lineMasks[sourceIndex]! & DIR_BIT[direction]) return false;
  const target = cells[targetIndex];
  if (target === undefined) return true;
  if (target === null) return false;
  return target.enterFrom.has(OPPOSITE[direction]);
}

function compilePassage(
  cells: readonly CollisionCell[],
  lineMasks: Uint8Array,
  width: number,
  height: number,
  dynamicBodyCells: ReadonlySet<number>,
): { ground: TileId[]; passage: [number, "block"][]; masks: Uint8Array; oneWayEdges: number; mismatches: number } {
  const blocked = new Uint8Array(width * height);
  const passage: [number, "block"][] = [];
  for (let i = 0; i < cells.length; i++) {
    const region = cells[i];
    // Labelled collision regions are dynamic blockers: G1 materialises them
    // as invisible blocking events so remove_collision can open them.  Do
    // not also bake those cells into immutable map.passage overrides.
    if (!dynamicBodyCells.has(i) && (region === null || (region !== undefined && region.enterFrom.size === 0))) {
      blocked[i] = 1;
      passage.push([i, "block"]);
    }
  }

  // Collision polylines are true two-sided walls and remain dirBlock masks.
  // Region entry/exit restrictions are one-sided and therefore use K2's
  // dirEdges. Encode all three 4-bit masks in the otherwise-artless terrain
  // cell id: bits 0..3 dirBlock, 4..7 entry, 8..11 exit.
  const masks = lineMasks.slice();
  const entryMasks = new Uint8Array(width * height);
  const exitMasks = new Uint8Array(width * height);
  for (let i = 0; i < cells.length; i++) {
    const region = cells[i];
    if (!region || dynamicBodyCells.has(i)) continue;
    if (region.enterFrom.size > 0) {
      for (const direction of ALL_DIRS) {
        if (!region.enterFrom.has(direction)) entryMasks[i] |= DIR_BIT[direction];
      }
    }
    const exits = new Set(region.exitFrom);
    if (region.endure.length === 1) exits.add(region.endure[0]!);
    // Multiple endure directions make the currently faced direction an
    // explicit exit, so they impose no static source-side restriction.
    if (exits.size && region.endure.length <= 1) {
      for (const direction of ALL_DIRS) {
        if (!exits.has(direction)) exitMasks[i] |= DIR_BIT[direction];
      }
    }
  }

  let oneWayEdges = 0;
  const pairs: readonly [number, number, Dir, Dir][] = [
    [1, 0, "right", "left"],
    [0, 1, "down", "up"],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (const [dx, dy, forward, reverse] of pairs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const a = y * width + x;
        const b = ny * width + nx;
        const wantForward = tuxCanStep(cells, lineMasks, width, height, x, y, forward);
        const wantReverse = tuxCanStep(cells, lineMasks, width, height, nx, ny, reverse);
        const baseForward = blocked[b] === 0 && !dynamicBodyCells.has(b);
        const baseReverse = blocked[a] === 0 && !dynamicBodyCells.has(a);
        // Count exactly the directed steps G5 had to leave permissive because
        // dirBlock could not represent them. K2 now encodes each of them.
        if (!(!wantForward && !wantReverse && (baseForward || baseReverse)) &&
            (wantForward !== baseForward || wantReverse !== baseReverse)) {
          oneWayEdges++;
        }
      }
    }
  }

  const kitCanStep = (x: number, y: number, direction: Dir): boolean => {
    const nx = x + DX[direction];
    const ny = y + DY[direction];
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
    const source = y * width + x;
    const target = ny * width + nx;
    if ((masks[source]! | exitMasks[source]!) & DIR_BIT[direction]) return false;
    if (dynamicBodyCells.has(target)) return false;
    if (blocked[target]) return false;
    return ((masks[target]! | entryMasks[target]!) & DIR_BIT[OPPOSITE[direction]]) === 0;
  };
  let mismatches = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (blocked[y * width + x] || dynamicBodyCells.has(y * width + x)) continue; // unreachable as a standing cell
      for (const direction of ALL_DIRS) {
        if (tuxCanStep(cells, lineMasks, width, height, x, y, direction) !== kitCanStep(x, y, direction)) mismatches++;
      }
    }
  }
  return {
    ground: Array.from(masks, (mask, index) =>
      `${TERRAIN_SHEET_ID}.${mask | (entryMasks[index]! << 4) | (exitMasks[index]! << 8)}`
    ),
    passage,
    masks,
    oneWayEdges,
    mismatches,
  };
}

function passageSheet(maps: readonly TerrainMapPatch[]): Sheet {
  const dirBlock: Record<string, Dir[]> = {};
  const dirEdges: NonNullable<Sheet["dirEdges"]> = {};
  const codes = new Set<number>();
  for (const map of maps) {
    for (const tile of map.ground) {
      if (tile !== null) codes.add(Number(tile.slice(tile.lastIndexOf(".") + 1)));
    }
  }
  for (const code of [...codes].sort((a, b) => a - b)) {
    const block = code & 0xf;
    const enter = (code >> 4) & 0xf;
    const exit = (code >> 8) & 0xf;
    if (block) dirBlock[String(code)] = ALL_DIRS.filter((direction) => (block & DIR_BIT[direction]) !== 0);
    if (enter || exit) {
      dirEdges[String(code)] = {
        ...(enter ? { enter: ALL_DIRS.filter((direction) => (enter & DIR_BIT[direction]) !== 0) } : {}),
        ...(exit ? { exit: ALL_DIRS.filter((direction) => (exit & DIR_BIT[direction]) !== 0) } : {}),
      };
    }
  }
  return {
    id: TERRAIN_SHEET_ID,
    cols: 64,
    rows: 64,
    pak: "chunks",
    defaultPassage: "pass",
    dirBlock,
    dirEdges,
  };
}

function sourceRevision(sourceRoot: string, explicit?: string): string {
  if (explicit) return explicit;
  const head = join(sourceRoot, ".git", "HEAD");
  if (!existsSync(head)) return "9e6258ff";
  const value = readFileSync(head, "utf8").trim();
  if (!value.startsWith("ref: ")) return value.slice(0, 40);
  const ref = join(sourceRoot, ".git", value.slice(5));
  return existsSync(ref) ? readFileSync(ref, "utf8").trim().slice(0, 40) : "9e6258ff";
}

export type TerrainSurfaceLabels = Readonly<
  Record<string, Readonly<Record<string, readonly number[]>>>
>;

/** The final MapDef terrain opinions needed to prove a direct edge crossing.
 * Codes use the same packed dirBlock/entry/exit bits as `passageSheet`; solid
 * cells are the authoritative `map.passage` blocks after labelled dynamic
 * bodies have been left to events. */
export interface TerrainPassageProof {
  width: number;
  height: number;
  codes: readonly number[];
  solid: ReadonlySet<number>;
}

function proofIndex(
  proof: Readonly<TerrainPassageProof>,
  x: number,
  y: number,
): number | null {
  return x < 0 || y < 0 || x >= proof.width || y >= proof.height
    ? null
    : y * proof.width + x;
}

/** Mirrors engine `cellBlocksExit` for a terrain-only MapDef. */
export function terrainCellBlocksExit(
  proof: Readonly<TerrainPassageProof>,
  x: number,
  y: number,
  exit: Dir,
): boolean {
  const index = proofIndex(proof, x, y);
  if (index === null) return false;
  const code = proof.codes[index] ?? 0;
  return ((code & 0xf) | ((code >> 8) & 0xf)) & DIR_BIT[exit] ? true : false;
}

/** Mirrors engine `canEnter` with an explicit entry edge. */
export function terrainCellCanEnter(
  proof: Readonly<TerrainPassageProof>,
  x: number,
  y: number,
  entry: Dir,
): boolean {
  const index = proofIndex(proof, x, y);
  if (index === null || proof.solid.has(index)) return false;
  const code = proof.codes[index] ?? 0;
  return ((((code & 0xf) | ((code >> 4) & 0xf)) & DIR_BIT[entry]) === 0);
}

/** Mirrors engine `canStepFrom` for one adjacent terrain step. */
export function terrainCanStep(
  proof: Readonly<TerrainPassageProof>,
  x: number,
  y: number,
  direction: Dir,
): boolean {
  return !terrainCellBlocksExit(proof, x, y, direction) && terrainCellCanEnter(
    proof,
    x + DX[direction],
    y + DY[direction],
    OPPOSITE[direction],
  );
}

/** Parse just enough TMX/TSX collision data to reproduce the final terrain
 * MapDef's passage table. Unlike the PNG cooker this performs no image,
 * chunk, compression or filesystem output work. */
export function importTerrainPassageProofs(
  mapIds: readonly string[],
  sourceRoot = process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC,
): Readonly<Record<string, TerrainPassageProof>> {
  const mapsDir = join(normalize(sourceRoot), "mods/tuxemon/maps");
  const templates = new Map<string, TileTemplate>();
  const result: Record<string, TerrainPassageProof> = {};
  for (const id of [...new Set(mapIds)].sort()) {
    const path = join(mapsDir, `${id}.tmx`);
    if (!existsSync(path)) throw new Error(`missing TMX map: ${id}`);
    const root = readXml(path);
    if (root.name !== "map") throw new Error(`${path}: expected <map>`);
    const width = integerAttr(root, "width");
    const height = integerAttr(root, "height");
    const tilesets = parseMapTilesets(root, mapsDir, templates);
    const layers = mapLayers(root, width, height);
    const collision = tileCollision(
      root,
      join(mapsDir, `${id}.yaml`),
      layers,
      tilesets,
      width,
      height,
    );
    const dynamicBodyCells = new Set(Object.values(collision.labels).flat());
    const compiled = compilePassage(
      collision.cells,
      collision.lineMasks,
      width,
      height,
      dynamicBodyCells,
    );
    result[id] = {
      width,
      height,
      codes: compiled.ground.map((tile) =>
        tile === null ? 0 : Number(tile.slice(tile.lastIndexOf(".") + 1))
      ),
      solid: new Set(compiled.passage.map(([index]) => index)),
    };
  }
  return result;
}

/** Read only Tuxemon's per-cell surface-key membership. This shares the
 * exact visible-layer/tileset rules with the terrain cooker but skips every
 * PNG, chunk, and pak operation, so standalone importer tests can lower
 * runtime tile-property commands without paying for a full terrain cook. */
export function importTerrainSurfaceLabels(
  mapIds: readonly string[],
  sourceRoot = process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC,
): TerrainSurfaceLabels {
  const mapsDir = join(normalize(sourceRoot), "mods/tuxemon/maps");
  const templates = new Map<string, TileTemplate>();
  const result: Record<string, Record<string, number[]>> = {};
  for (const id of [...new Set(mapIds)].sort()) {
    const path = join(mapsDir, `${id}.tmx`);
    if (!existsSync(path)) throw new Error(`missing TMX map: ${id}`);
    const root = readXml(path);
    if (root.name !== "map") throw new Error(`${path}: expected <map>`);
    const width = integerAttr(root, "width");
    const height = integerAttr(root, "height");
    const tilesets = parseMapTilesets(root, mapsDir, templates);
    const layers = mapLayers(root, width, height);
    result[id] = tileCollision(
      root,
      join(mapsDir, `${id}.yaml`),
      layers,
      tilesets,
      width,
      height,
    ).surfaceLabels;
  }
  return result;
}

/** Import all (or a selected subset of) pinned Tuxemon TMX maps in memory. */
export function importTerrain(options: GenerateTerrainOptions = {}): TerrainBuild {
  const sourceRoot = normalize(options.sourceRoot ?? process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC);
  const mapsDir = join(sourceRoot, "mods/tuxemon/maps");
  const chunkPx = options.chunkPx ?? 256;
  const wanted = options.mapIds ? new Set(options.mapIds) : null;
  const files = readdirSync(mapsDir)
    .filter((name) => name.endsWith(".tmx") && (!wanted || wanted.has(name.slice(0, -4))))
    .sort();
  if (wanted && files.length !== wanted.size) {
    const found = new Set(files.map((file) => file.slice(0, -4)));
    throw new Error(`missing TMX maps: ${[...wanted].filter((id) => !found.has(id)).join(", ")}`);
  }

  const templates = new Map<string, TileTemplate>();
  const images = new Map<string, RgbaImage>();
  const entries: StreamEntry[] = [];
  const streamMaps: StreamManifestMap[] = [];
  const patches: TerrainMapPatch[] = [];
  const animations: Record<string, AnimatedTerrainCell[]> = {};
  const animationSequences = new Map<string, TerrainAnimationSequence>();
  const byMap: Record<string, TerrainMapReport> = {};

  for (const file of files) {
    const id = file.slice(0, -4);
    const path = join(mapsDir, file);
    const root = readXml(path);
    if (root.name !== "map") throw new Error(`${path}: expected <map>`);
    const width = integerAttr(root, "width");
    const height = integerAttr(root, "height");
    if (integerAttr(root, "tilewidth") !== TILE_PX || integerAttr(root, "tileheight") !== TILE_PX) {
      throw new Error(`${path}: expected 16px tiles`);
    }
    const tilesets = parseMapTilesets(root, mapsDir, templates);
    const layers = mapLayers(root, width, height);
    const grid = chunkGrid(width, height, chunkPx);
    const animCells: AnimatedTerrainCell[] = [];
    let groundDraws = 0;
    let upperDraws = 0;
    let flipCells = 0;
    let animatedCells = 0;
    for (const layer of layers) {
      if (!layer.visible) continue;
      const above = layer.index > 2;
      for (let index = 0; index < layer.gids.length; index++) {
        const raw = layer.gids[index]!;
        const gid = raw & GID_MASK;
        if (!gid) continue;
        const flags = (raw & ~GID_MASK) >>> 0;
        const { tileset, localId } = resolveTile(tilesets, gid);
        const animation = tileset.animations.get(localId);
        const renderedId = animation?.[0]?.tileId ?? localId;
        const art = transformedCell(tileset, renderedId, flags, layer.opacity, images);
        const x = index % width;
        const y = Math.floor(index / width);
        drawCell(above ? grid.upper : grid.ground, grid.columns, chunkPx, x, y, art);
        if (above) upperDraws++;
        else groundDraws++;
        if (flags) flipCells++;
        if (animation) {
          animatedCells++;
          const sequenceKey = `${tileset.imagePath}\0${localId}\0${flags}\0${layer.opacity}`;
          let sequence = animationSequences.get(sequenceKey);
          if (!sequence) {
            sequence = {
              id: `terrain-anim-${String(animationSequences.size).padStart(3, "0")}`,
              frames: animation.map((frame) => ({
                rgba: transformedCell(tileset, frame.tileId, flags, layer.opacity, images),
                durationMs: frame.durationMs,
              })),
            };
            animationSequences.set(sequenceKey, sequence);
          }
          animCells.push({
            x,
            y,
            above,
            sequence: sequence.id,
            frames: animation.map((frame) => ({ tile: tileset.firstGid + frame.tileId, durationMs: frame.durationMs })),
          });
        }
      }
    }

    const ground = encodeStreamedLayer(`tuxemon-${id}-ground`, grid.ground, grid.columns, grid.rows, { chunkPx });
    const upper = encodeStreamedLayer(`tuxemon-${id}-upper`, grid.upper, grid.columns, grid.rows, { chunkPx });
    entries.push(...ground.entries, ...upper.entries);
    streamMaps.push({ id, width, height, ground: ground.layer, upper: upper.layer });

    const collision = tileCollision(root, join(mapsDir, `${id}.yaml`), layers, tilesets, width, height);
    const dynamicBodyCells = new Set(Object.values(collision.labels).flat());
    const compiled = compilePassage(collision.cells, collision.lineMasks, width, height, dynamicBodyCells);
    const collisionCells = collision.cells.filter((value) => value !== undefined).length;
    const directionalCells = collision.cells.filter((value) => value !== undefined && value !== null && value.enterFrom.size > 0 && value.enterFrom.size < 4).length;
    const labelledCollisionCells = Object.values(collision.labels).reduce((sum, values) => sum + values.length, 0);
    patches.push({
      id,
      width,
      height,
      sheets: [TERRAIN_SHEET_ID],
      ground: compiled.ground,
      passage: compiled.passage,
      collisionLabels: collision.labels,
      surfaceLabels: collision.surfaceLabels,
    });
    animations[id] = animCells;
    byMap[id] = {
      width,
      height,
      tileLayers: layers.length,
      hiddenLayers: layers.filter((layer) => !layer.visible).length,
      opacityLayers: layers.filter((layer) => layer.visible && layer.opacity !== 1).length,
      groundDraws,
      upperDraws,
      flipCells,
      animatedCells,
      collisionCells,
      directionalCells,
      collisionLineEdges: collision.lineEdges,
      yamlCollisionCells: collision.yamlCells,
      labelledCollisionCells,
      oneWayEdges: compiled.oneWayEdges,
      directedEdgeMismatches: compiled.mismatches,
      ground: ground.report,
      upper: upper.report,
    };
  }

  const revision = sourceRevision(sourceRoot, options.sourceRevision);
  const fragment: TerrainFragment = {
    format: TERRAIN_FORMAT,
    sourceRevision: revision,
    tileSize: TILE_PX,
    sheet: passageSheet(patches),
    maps: patches,
  };
  const pak = pack(entries.map((entry) => ({ key: entry.key, dtype: PAK_DTYPE.u8, data: entry.blob })));
  const report: TerrainReport = {
    // The upstream repository, not the local checkout path: reports must be
    // identical wherever the pinned source is fetched (sourceRevision pins it).
    source: "https://github.com/Tuxemon/Tuxemon",
    sourceRevision: revision,
    chunkPx,
    maps: files.length,
    cells: patches.reduce((sum, map) => sum + map.width * map.height, 0),
    entries: entries.length,
    rawEntryBytes: entries.reduce((sum, entry) => sum + entry.blob.length, 0),
    pakBytes: pak.length,
    gzipBytes: gzipSync(pak, { level: 9 }).length,
    quantizedChunks: Object.values(byMap).reduce((sum, map) => sum + map.ground.quantized + map.upper.quantized, 0),
    animatedCellsBakedAtFirstFrame: Object.values(byMap).reduce((sum, map) => sum + map.animatedCells, 0),
    flipCells: Object.values(byMap).reduce((sum, map) => sum + map.flipCells, 0),
    collisionCells: Object.values(byMap).reduce((sum, map) => sum + map.collisionCells, 0),
    directionalCells: Object.values(byMap).reduce((sum, map) => sum + map.directionalCells, 0),
    collisionLineEdges: Object.values(byMap).reduce((sum, map) => sum + map.collisionLineEdges, 0),
    yamlCollisionCells: Object.values(byMap).reduce((sum, map) => sum + map.yamlCollisionCells, 0),
    labelledCollisionCells: Object.values(byMap).reduce((sum, map) => sum + map.labelledCollisionCells, 0),
    oneWayEdgesEncoded: Object.values(byMap).reduce((sum, map) => sum + map.oneWayEdges, 0),
    directedEdgeMismatches: Object.values(byMap).reduce((sum, map) => sum + map.directedEdgeMismatches, 0),
    byMap,
  };
  return { entries, streamMaps, fragment, animations, animationSequences: [...animationSequences.values()], report };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function assetsSource(build: TerrainBuild, split: StreamRefSplit): string {
  const world = Object.fromEntries(build.fragment.maps.map((map) => [map.id, { w: map.width * TILE_PX, h: map.height * TILE_PX }]));
  const order = build.fragment.maps.map((map) => map.id);
  return (
    "// AUTO-GENERATED by gen-assets.ts — do not edit.\n\n" +
    // GP1 fix 1: the full per-map ground/upper chunk-ref tables are no
    // longer inline literals (see splitStreamRefs above). These INDEX
    // tables (map id -> pak/data.fs entry) plus the small chunkPx/columns
    // meta stay inline; main.tsx builds the lazy StreamedGameAssets via
    // ui/terrain-stream-repository.ts.
    `export const TERRAIN_STREAM_META = ${JSON.stringify({ chunkPx: split.chunkPx, columns: split.columns })} as const;\n\n` +
    `export const TERRAIN_STREAM_GROUND_INDEX: readonly { id: string; entry: string }[] = ${JSON.stringify(split.groundIndex, null, 2)} as const;\n\n` +
    `export const TERRAIN_STREAM_UPPER_INDEX: readonly { id: string; entry: string }[] = ${JSON.stringify(split.upperIndex, null, 2)} as const;\n\n` +
    `export const TERRAIN_WORLD = ${JSON.stringify(world)} as const;\n` +
    `export const TERRAIN_ORDER = ${JSON.stringify(order)} as const;\n`
  );
}

/** Materialise all committed terrain outputs below one game repository. */
export function writeTerrain(options: WriteTerrainOptions): TerrainBuild & { streamPakEntries: PakManifestEntry[] } {
  const outputRoot = normalize(options.outputRoot);
  const streamDir = join(outputRoot, "assets/stream");
  const build = importTerrain(options);
  rmSync(streamDir, { recursive: true, force: true });
  mkdirSync(streamDir, { recursive: true });
  for (const entry of build.entries) {
    const relative = streamEntryFile(entry.key);
    const path = join(outputRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.blob);
  }
  mkdirSync(join(outputRoot, "data"), { recursive: true });
  mkdirSync(join(outputRoot, "ui"), { recursive: true });
  writeFileSync(join(outputRoot, "pak.json"), stableJson(pakManifest(build.entries)));
  writeFileSync(join(outputRoot, "data/terrain.json"), stableJson(build.fragment));
  writeFileSync(join(outputRoot, "data/terrain-animations.json"), stableJson(build.animations));
  writeFileSync(join(outputRoot, "data/terrain-report.json"), stableJson(build.report));

  const split = splitStreamRefs(build.streamMaps, build.report.chunkPx);
  const streamRefDir = join(outputRoot, "dist/terrain-stream");
  rmSync(streamRefDir, { recursive: true, force: true });
  mkdirSync(streamRefDir, { recursive: true });
  for (const entry of split.entries) {
    const path = join(outputRoot, "dist", entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.bytes);
  }
  const streamPakEntries: PakManifestEntry[] = split.entries.map((entry) => ({
    key: entry.meta.entry,
    file: `dist/${entry.path}`,
  }));

  writeFileSync(join(outputRoot, "ui/terrain-assets.ts"), assetsSource(build, split));
  return { ...build, streamPakEntries };
}

/** Replace G1 placeholder terrain without touching imported names/events. */
export function applyTerrain(project: Project, fragment: TerrainFragment): Project {
  const patches = new Map(fragment.maps.map((map) => [map.id, map]));
  const maps = project.maps.map((map) => {
    const patch = patches.get(map.id);
    if (!patch) throw new Error(`terrain: project map ${map.id} has no TMX patch`);
    if (map.width !== patch.width || map.height !== patch.height) {
      throw new Error(`terrain: ${map.id} is ${map.width}x${map.height}, TMX is ${patch.width}x${patch.height}`);
    }
    return {
      ...map,
      sheets: [...new Set([...(map.sheets ?? []), TERRAIN_SHEET_ID])],
      ground: [...patch.ground],
      // The TMX terrain pass is authoritative for every cell. Keeping a G1
      // rectangle merely because the final restriction lives in dirEdges
      // turns one-way stairs back into fully blocked cells.
      passage: [...patch.passage],
    };
  });
  const missing = fragment.maps.filter((map) => !project.maps.some((candidate) => candidate.id === map.id));
  if (missing.length) throw new Error(`terrain: fragment maps absent from project: ${missing.map((map) => map.id).join(", ")}`);
  return {
    ...project,
    sheets: [...project.sheets.filter((sheet) => sheet.id !== TERRAIN_SHEET_ID), fragment.sheet],
    maps,
  };
}

// Deterministic R2 character cooker for Tuxemon's 3x4, 16x32 walkers.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { loadWalkerSheet } from "../vendor/pocket-rpgkit/tools/lib/bake.ts";
import type { CharacterFrames, NpcArt } from "../vendor/pocket-rpgkit/src/ui/game-assets.ts";
import type { PlayerFrames } from "../vendor/pocket-rpgkit/src/ui/PlayerSprite.tsx";
import type { Project, SpriteDef } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { decodePng } from "./png.ts";
import { DEFAULT_TUXEMON_SRC } from "./terrain.ts";
import type { MonsterMenuIconSource } from "./project.ts";

const PSM_8888 = 3;

type Four = [string, string, string, string];

export interface CharacterReport {
  source: string;
  spriteKeys: number;
  walkers: number;
  staticObjects: number;
  tallStaticObjects: number;
  monsterMenuIcons: number;
  placeholders: number;
  playerSheet: string;
  imageFiles: number;
  imageBytes: number;
}

export interface CharacterBuild {
  project: Project;
  npcSrc: Record<string, NpcArt>;
  player: PlayerFrames;
  imagesJson: Record<string, { psm: number }>;
  /** choice_monster row icons as raw RGBA: gen-assets writes them as on-demand
   *  IMG pak entries (dist/choice-icons/<sprite>.img) instead of eager ui:img. */
  menuIcons: Record<string, { rgba: Uint8Array; w: number; h: number }>;
  report: CharacterReport;
}

export interface CharacterCookOptions {
  outputRoot: string;
  sourceRoot?: string;
  /** choice_monster row icons: crop each sheet rect (the monster's menu1
   *  face) and nearest-neighbour scale it to the kit's 16 px icon cell. */
  monsterMenuIcons?: readonly MonsterMenuIconSource[];
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "missing";
}

function four(values: readonly string[]): Four {
  if (values.length !== 4) throw new Error(`character cooker: expected four facings, got ${values.length}`);
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

function placeholderPng(): Uint8Array {
  const width = 16;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const bright = ((x >> 2) + (y >> 2)) % 2 === 0;
      rgba[offset] = bright ? 255 : 30;
      rgba[offset + 1] = bright ? 40 : 0;
      rgba[offset + 2] = bright ? 210 : 40;
      rgba[offset + 3] = 255;
    }
  }
  return encodePNG(rgba, width, height);
}

function portablePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const nextPow2 = (value: number): number => {
    let out = 1;
    while (out < value) out <<= 1;
    return out;
  };
  const outWidth = nextPow2(width);
  const outHeight = nextPow2(height);
  if (outWidth === width && outHeight === height) return encodePNG(rgba, width, height);
  const padded = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < height; y++) {
    padded.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * outWidth * 4);
  }
  return encodePNG(padded, outWidth, outHeight);
}

/** Nearest-neighbour crop+scale of a sheet rect into a size×size RGBA icon.
 *  The destination pixel (dx, dy) samples the rect's centre-weighted source
 *  pixel, the same mapping gen-assets' portableStaticPng uses. */
function cropScaleIcon(
  image: { width: number; height: number; rgba: Uint8Array },
  crop: { x: number; y: number; w: number; h: number },
  size: number,
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let dy = 0; dy < size; dy++) {
    const sy = crop.y + Math.min(crop.h - 1, Math.floor((dy + 0.5) * crop.h / size));
    for (let dx = 0; dx < size; dx++) {
      const sx = crop.x + Math.min(crop.w - 1, Math.floor((dx + 0.5) * crop.w / size));
      const src = (sy * image.width + sx) * 4;
      const dst = (dy * size + dx) * 4;
      out[dst] = image.rgba[src]!;
      out[dst + 1] = image.rgba[src + 1]!;
      out[dst + 2] = image.rgba[src + 2]!;
      out[dst + 3] = image.rgba[src + 3]!;
    }
  }
  return out;
}

interface AppearanceOption {
  template?: { sprite_name?: unknown };
}

function firstPlayerSheet(modRoot: string): string {
  const path = join(modRoot, "db/npc/appearance_options.yaml");
  const options = Bun.YAML.parse(readFileSync(path, "utf8")) as AppearanceOption[] | null;
  const spriteName = options?.[0]?.template?.sprite_name;
  if (typeof spriteName !== "string" || !/^[A-Za-z0-9_-]+$/.test(spriteName)) {
    throw new Error(`${path}: first appearance option has no safe template.sprite_name`);
  }
  return `sprites/${spriteName}.png`;
}

/** Cook all page.sprite art plus the first authored player appearance. */
export async function cookCharacters(project: Project, options: CharacterCookOptions): Promise<CharacterBuild> {
  const outputRoot = normalize(options.outputRoot);
  const sourceRoot = normalize(options.sourceRoot ?? process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC);
  const modRoot = join(sourceRoot, "mods/tuxemon");
  const outputDir = join(outputRoot, "assets/characters");
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const npcSrc: Record<string, NpcArt> = {};
  const imagesJson: Record<string, { psm: number }> = {};
  const rewritten: Record<string, SpriteDef> = {};
  const menuIcons: Record<string, { rgba: Uint8Array; w: number; h: number }> = {};
  let walkers = 0;
  let staticObjects = 0;
  let tallStaticObjects = 0;
  let monsterMenuIcons = 0;
  let placeholders = 0;
  let imageBytes = 0;
  const menuIconBySprite = new Map(
    (options.monsterMenuIcons ?? []).map((icon) => [icon.sprite, icon]),
  );

  const writeImage = (relative: string, bytes: Uint8Array): string => {
    writeFileSync(join(outputRoot, relative), bytes);
    imagesJson[relative] = { psm: PSM_8888 };
    imageBytes += bytes.byteLength;
    return relative;
  };

  const writeWalker = async (stem: string, source: string): Promise<CharacterFrames> => {
    const frames = await loadWalkerSheet(source);
    const paths = {
      idle: [] as string[],
      walkL: [] as string[],
      walkR: [] as string[],
    };
    for (const [pose, bytes] of [
      ["idle", frames.idle],
      ["walk-l", frames.walkL],
      ["walk-r", frames.walkR],
    ] as const) {
      for (let facing = 0; facing < 4; facing++) {
        const relative = `assets/characters/${stem}-${pose}-${facing}.png`;
        const path = writeImage(relative, bytes[facing]!);
        if (pose === "idle") paths.idle.push(path);
        else if (pose === "walk-l") paths.walkL.push(path);
        else paths.walkR.push(path);
      }
    }
    return { idle: four(paths.idle), walkL: four(paths.walkL), walkR: four(paths.walkR), h: 32 };
  };

  for (const [key, def] of Object.entries(project.sprites ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const menuIcon = def.kind === "image" ? menuIconBySprite.get(key) : undefined;
    if (menuIcon) {
      // A choice_monster row icon: the monster's menu1 face cropped from its
      // battle sheet and scaled to the kit's 16 px icon cell. It ships as an
      // on-demand IMG entry (gen-assets writes dist/choice-icons/<sprite>.img),
      // NOT as an eager ui:img, so it is decoded/uploaded only when a choice
      // menu first resolves it. npcSrc carries the texture name the game's
      // choice-icon provider registers on first access (ui/choice-icon-provider.ts).
      const source = join(modRoot, menuIcon.sheet);
      const sheet = decodePng(new Uint8Array(readFileSync(source)), source);
      const { x, y, w, h } = menuIcon.crop;
      if (x + w > sheet.width || y + h > sheet.height) {
        throw new Error(`${source}: monster menu crop ${x},${y},${w},${h} exceeds the ${sheet.width}x${sheet.height} sheet`);
      }
      const rgba = cropScaleIcon(sheet, menuIcon.crop, 16);
      menuIcons[key] = { rgba, w: 16, h: 16 };
      npcSrc[key] = `choice-icon:${key}`;
      rewritten[key] = def;
      monsterMenuIcons++;
      continue;
    }

    if (def.kind === "image" && def.src.startsWith("sprites/")) {
      const source = join(modRoot, def.src);
      const art = await writeWalker(`npc-${safeName(key)}`, source);
      npcSrc[key] = art;
      rewritten[key] = { kind: "walker", sheet: def.src, h: 32 };
      walkers++;
      continue;
    }

    if (def.kind === "image" && def.src !== "missing.png") {
      const source = join(modRoot, def.src);
      const bytes = new Uint8Array(readFileSync(source));
      const image = decodePng(bytes, source);
      // Some upstream objects are indexed-colour PNGs; PocketJS's image
      // compiler accepts RGB/RGBA, so normalise them through our decoder.
      const relative = writeImage(
        `assets/characters/npc-${safeName(key)}-static.png`,
        portablePng(image.rgba, image.width, image.height),
      );
      npcSrc[key] = image.width === 16 && image.height === 32
        ? { idle: [relative, relative, relative, relative], walkL: [relative, relative, relative, relative], walkR: [relative, relative, relative, relative], h: 32 }
        : relative;
      rewritten[key] = def;
      staticObjects++;
      if (image.width === 16 && image.height === 32) tallStaticObjects++;
      continue;
    }

    if (def.kind === "walker" && "sheet" in def) {
      const source = join(modRoot, def.sheet);
      npcSrc[key] = await writeWalker(`npc-${safeName(key)}`, source);
      rewritten[key] = def;
      walkers++;
      continue;
    }

    // Unknown/missing source art remains visible and deterministic.
    const relative = writeImage(`assets/characters/npc-${safeName(key)}-missing.png`, placeholderPng());
    npcSrc[key] = {
      idle: [relative, relative, relative, relative],
      walkL: [relative, relative, relative, relative],
      walkR: [relative, relative, relative, relative],
      h: 32,
    };
    rewritten[key] = { kind: "image", src: "missing.png" };
    placeholders++;
  }

  const playerSheet = firstPlayerSheet(modRoot);
  const playerStem = playerSheet.slice("sprites/".length, -".png".length);
  const playerArt = await writeWalker(`player-${safeName(playerStem)}`, join(modRoot, playerSheet));
  const player: PlayerFrames = {
    idle: playerArt.idle,
    walkL: playerArt.walkL,
    walkR: playerArt.walkR,
  };

  return {
    project: { ...project, sprites: rewritten },
    npcSrc,
    player,
    imagesJson,
    menuIcons,
    report: {
      // Upstream repository, not the local checkout path (see terrain.ts).
      source: "https://github.com/Tuxemon/Tuxemon",
      spriteKeys: Object.keys(project.sprites ?? {}).length,
      walkers,
      staticObjects,
      tallStaticObjects,
      monsterMenuIcons,
      placeholders,
      playerSheet,
      imageFiles: Object.keys(imagesJson).length,
      imageBytes,
    },
  };
}

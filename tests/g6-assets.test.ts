import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodePng } from "../importer/png.ts";
import { DEFAULT_TUXEMON_SRC } from "../importer/terrain.ts";
import { ANIMATED_INDEX, GAME_ASSETS, NPC_SRC_INDEX, PLAYER } from "../ui/game-assets.ts";
import { createMapRepository } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import type { AnimatedTile, NpcArt } from "../vendor/pocket-rpgkit/src/ui/game-assets.ts";
import type { ProjectShell } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const report = JSON.parse(readFileSync(resolve(ROOT, "data/g6-assets-report.json"), "utf8"));
const images = JSON.parse(readFileSync(resolve(ROOT, "images.json"), "utf8")) as Record<string, { psm: number }>;
const sprites = JSON.parse(readFileSync(resolve(ROOT, "sprites.json"), "utf8")) as Record<
  string,
  { cols: number; rows: number; frames: number; step: number; psm: number }
>;

describe("G6 generated game assets", () => {
  test("cover every imported map, character, animation, and labelled collision body", () => {
    const appearances = Bun.YAML.parse(readFileSync(
      resolve(process.env.TUXEMON_SRC ?? DEFAULT_TUXEMON_SRC, "mods/tuxemon/db/npc/appearance_options.yaml"),
      "utf8",
    )) as { template: { sprite_name: string } }[];
    expect(report.project).toMatchObject({
      maps: 263,
      collisionBodies: 14,
      maxActors: 504,
      // The integrated importer recomputes this bound from every reachable
      // map after world/time/name guards, quarantine and bonding-tracker
      // events materialize. Independently coalesced Surf rectangles keep
      // Dryad's Grove within this playable bound; test_npcs remains the
      // excluded global maximum.
      runtimeMaxActors: 292,
      excludedActorStressMaps: [{ id: "test_npcs", slots: 504 }],
      options: {
        areas: true,
        facing: true,
        condAll: true,
        localReset: true,
        place: true,
        inputLock: true,
        routes: true,
        moveControl: true,
        extChoice: true,
        battle: true,
      },
    });
    expect(report.terrain).toMatchObject({ entries: 430, animatedPlacements: 5_785 });
    expect(report.animation).toMatchObject({ sourceSequences: 86, atlases: 86 });
    expect(report.mapAnimations).toMatchObject({ definitions: 5, frames: 67 });
    expect(report.screenLayers).toMatchObject({
      layers: 2,
      variants: 10,
      imageVariants: 7,
    });
    expect(report.characters).toMatchObject({
      spriteKeys: 183,
      walkers: 160,
      staticObjects: 22,
      placeholders: 1,
      imageFiles: 1_955,
      playerSheet: `sprites/${appearances[0]!.template.sprite_name}.png`,
    });
    expect(GAME_ASSETS.order).toHaveLength(263);
    expect(GAME_ASSETS.maxActors).toBe(292);
    expect(NPC_SRC_INDEX).toHaveLength(183);
    for (const { id, entry } of NPC_SRC_INDEX) {
      const art = JSON.parse(readFileSync(resolve(ROOT, "dist", entry), "utf8")) as NpcArt;
      expect(typeof art === "string" ? art.length > 0 : art.idle.length > 0, id).toBeTrue();
    }
    expect(ANIMATED_INDEX).toHaveLength(48);
    const animatedTotal = ANIMATED_INDEX.reduce((sum, { entry }) => {
      const tiles = JSON.parse(readFileSync(resolve(ROOT, "dist", entry), "utf8")) as AnimatedTile[];
      return sum + tiles.length;
    }, 0);
    expect(animatedTotal).toBe(5_785);
    expect(GAME_ASSETS.playerHeight).toBe(32);
    expect(Object.keys(GAME_ASSETS.anims ?? {})).toEqual([
      "tux_bubble_exclamation",
      "tux_dragonbirth_100000us",
      "tux_grass_100000us",
      "tux_grass_blue_100000us",
      "tux_grass_red_100000us",
    ]);
    expect(GAME_ASSETS.layers?.tux_backdrop).toEqual({
      placement: "screen",
      variants: {
        bg_gradient_blue: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue.png",
        },
        bg_gradient_blue_aeble_character: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue_aeble_character.png",
        },
        bg_gradient_blue_spyder_monsters_image: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue_spyder_monsters_image.png",
        },
        bg_gradient_blue_spyder_morph_image: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue_spyder_morph_image.png",
        },
        bg_gradient_blue_spyder_omnichannel_beaverbrook_character: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue_spyder_omnichannel_beaverbrook_character.png",
        },
        bg_gradient_blue_spyder_tumble_image: {
          image: "assets/screen-layers/tux-backdrop-bg_gradient_blue_spyder_tumble_image.png",
        },
      },
    });
    expect(GAME_ASSETS.layers?.tux_overlay).toEqual({
      placement: "screen",
      defaultVisible: false,
      variants: {
        color_0_0_0_255: { color: "#000000ff" },
        color_0_0_128_128: { color: "#00008080" },
        color_102_51_0_128: { color: "#66330080" },
        image_gfx_ui_overlay_torchlight_png: {
          image: "assets/screen-layers/tux-overlay-image_gfx_ui_overlay_torchlight_png.png",
        },
      },
    });
    for (const id of [
      "adventurer",
      "adventurerblack",
      "brownheroine_brown",
      "enbyasian",
      "heroine",
      "invisible",
      "penguin",
      "swimmer",
    ]) {
      expect(NPC_SRC_INDEX.some((entry) => entry.id === id), id).toBeTrue();
    }
  });

  test("sizes the actor pool from every event on every reachable map (KV1)", () => {
    // KV1's collectMapSlots reserves one actor slot per map event — runtime
    // appearance ops can give any event a sprite — so the baked pool must
    // cover the event count of every map a session can load. The test_*
    // stress fixtures stay exempt by design (see gen-assets.ts).
    const shell = JSON.parse(readFileSync(resolve(ROOT, "dist/project-shell.json"), "utf8")) as ProjectShell;
    const repository = createMapRepository(shell.mapIndex, {
      read: (entry) => new Uint8Array(readFileSync(resolve(ROOT, "dist", entry))),
    });
    let playableMax = 0;
    let testNpcsEvents = 0;
    for (const meta of shell.mapIndex) {
      const map = repository.acquire(meta.id);
      const events = map.events?.length ?? 0;
      if (map.id === "test_npcs") {
        testNpcsEvents = events;
      } else if (!map.id.startsWith("test_")) {
        expect(events, `${map.id} needs ${events} actor slots`).toBeLessThanOrEqual(GAME_ASSETS.maxActors!);
        playableMax = Math.max(playableMax, events);
      }
      repository.releaseExcept([]);
    }
    // The pool is exactly the playable max: sprite-based counting would shrink
    // it below the real event counts, and dropping the test_* exemption would
    // inflate it to the fixture's 501.
    expect(playableMax).toBe(GAME_ASSETS.maxActors!);
    expect(testNpcsEvents, "test_npcs stays a real, exempted stress fixture").toBeGreaterThan(GAME_ASSETS.maxActors!);
  });

  test("all R2 character images are portable power-of-two RGBAs", () => {
    const characterImages = Object.entries(images).filter(([relative]) =>
      relative.startsWith("assets/characters/")
    );
    expect(characterImages).toHaveLength(1_955);
    for (const [relative, meta] of characterImages) {
      const path = resolve(ROOT, relative);
      expect(existsSync(path), relative).toBeTrue();
      expect(meta.psm, relative).toBe(3);
      const image = decodePng(new Uint8Array(readFileSync(path)), path);
      expect(image.width & (image.width - 1), relative).toBe(0);
      expect(image.height & (image.height - 1), relative).toBe(0);
      expect(image.width, relative).toBeLessThanOrEqual(512);
      expect(image.height, relative).toBeLessThanOrEqual(512);
    }
    for (const group of [PLAYER.idle, PLAYER.walkL, PLAYER.walkR]) {
      expect(group).toHaveLength(4);
      for (const relative of group) {
        const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
        expect([image.width, image.height]).toEqual([16, 32]);
      }
    }
  }, 30_000);

  test("KA1 map animation frames keep authored geometry in portable textures", () => {
    const anims = GAME_ASSETS.anims ?? {};
    const framePaths = Object.values(anims).flatMap((animation) => animation.frames);
    expect(framePaths).toHaveLength(67);
    expect(new Set(framePaths).size).toBe(framePaths.length);
    expect(Object.keys(images).filter((relative) => relative.startsWith("assets/map-animations/")))
      .toEqual(framePaths);
    for (const [id, animation] of Object.entries(anims)) {
      for (const relative of animation.frames) {
        expect(images[relative], `${id}:${relative}`).toEqual({ psm: 3 });
        const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
        expect(image.width & (image.width - 1), relative).toBe(0);
        expect(image.height & (image.height - 1), relative).toBe(0);
      }
    }
    expect(anims.tux_dragonbirth_100000us).toMatchObject({ w: 48, h: 64 });
    expect(anims.tux_grass_100000us).toMatchObject({ w: 16, h: 16 });
    const dragon = decodePng(new Uint8Array(readFileSync(resolve(
      ROOT,
      anims.tux_dragonbirth_100000us!.frames[0]!,
    ))));
    expect([dragon.width, dragon.height]).toEqual([64, 64]);
  });

  test("KS1 backdrops are composed into registered portable RGBA images", () => {
    const variants = GAME_ASSETS.layers?.tux_backdrop?.variants ?? {};
    const paths = Object.values(variants)
      .map((variant) => variant.image)
      .filter((relative): relative is string => relative !== undefined);
    expect(paths).toHaveLength(6);
    expect(new Set(paths).size).toBe(paths.length);
    expect(Object.keys(images).filter((relative) =>
      relative.startsWith("assets/screen-layers/tux-backdrop-")
    )).toEqual(paths);
    for (const relative of paths) {
      expect(images[relative], relative).toEqual({ psm: 3 });
      const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
      expect([image.width, image.height], relative).toEqual([256, 256]);
      expect(image.rgba.some((channel, index) => index % 4 !== 3 && channel !== 0), relative).toBeTrue();
    }
  });

  test("KV1 packages the torch overlay and dynamic walking appearances", () => {
    const overlay = GAME_ASSETS.layers?.tux_overlay;
    expect(overlay?.placement).toBe("screen");
    if (!overlay || overlay.placement !== "screen") throw new Error("missing tux_overlay");
    const torch = overlay.variants.image_gfx_ui_overlay_torchlight_png?.image;
    expect(torch).toBe("assets/screen-layers/tux-overlay-image_gfx_ui_overlay_torchlight_png.png");
    expect(images[torch!]).toEqual({ psm: 3 });
    const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, torch!))), torch!);
    expect([image.width, image.height]).toEqual([256, 256]);
  });

  test("all R2 terrain animation atlases match their sprite metadata", () => {
    expect(Object.keys(sprites)).toHaveLength(86);
    for (const [relative, sprite] of Object.entries(sprites)) {
      const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
      expect(sprite.psm, relative).toBe(3);
      expect(sprite.rows, relative).toBe(1);
      expect(sprite.frames, relative).toBeGreaterThanOrEqual(2);
      expect(sprite.frames, relative).toBeLessThanOrEqual(sprite.cols);
      expect(sprite.step, relative).toBeGreaterThan(0);
      expect(image.width, relative).toBe(sprite.cols * 16);
      expect(image.height, relative).toBe(16);
    }
  });
});

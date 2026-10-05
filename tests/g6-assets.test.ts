import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng } from "../importer/png.ts";
import { TUXEMON_SRC } from "../importer/source.ts";
import { DEFAULT_TUXEMON_SRC } from "../importer/terrain.ts";
import { ANIMATED_INDEX, GAME_ASSETS, NPC_SRC_INDEX, PLAYER } from "../ui/game-assets.ts";
import { CHOICE_ICON_TEXTURES } from "../ui/choice-icon-textures.ts";
import { NPC_SRC_ASSET_PATHS } from "../ui/npc-src-assets.ts";
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
      variants: 16,
      imageVariants: 7,
    });
    expect(report.characters).toMatchObject({
      spriteKeys: 191,
      walkers: 160,
      staticObjects: 22,
      monsterMenuIcons: 8,
      placeholders: 1,
      imageFiles: 1_955,
      playerSheet: `sprites/${appearances[0]!.template.sprite_name}.png`,
    });
    expect(GAME_ASSETS.order).toHaveLength(263);
    // 292 actors come from the Kernel-quest event growth (main); the 191
    // sprite sources are main's 183 plus the 8 monster menu-face icons.
    expect(GAME_ASSETS.maxActors).toBe(292);
    expect(NPC_SRC_INDEX).toHaveLength(191);
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
        bg_gradient_blue_budaye_monster: {},
        bg_gradient_blue_dollfin_monster: {},
        bg_gradient_blue_grintot_monster: {},
        bg_gradient_blue_ignibus_monster: {},
        bg_gradient_blue_memnomnom_monster: {},
        bg_gradient_blue_rockitten_monster: {},
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
    // The choice_monster menu-face icons are 16x16 on-demand IMG entries and
    // paint a face, not a blank or placeholder square.
    for (const slug of ["budaye", "dollfin", "fruitera", "grintot", "hydrone", "ignibus", "memnomnom", "rockitten"]) {
      const sprite = `tux_monster_menu_${slug}`;
      const imgPath = resolve(ROOT, "dist/choice-icons", `${sprite}.img`);
      const bytes = readFileSync(imgPath);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect([dv.getUint16(0, true), dv.getUint16(2, true)], sprite).toEqual([16, 16]);
      const opaque: number[] = [];
      for (let i = 8; i < bytes.length; i += 4) {
        if (bytes[i + 3]! > 0) opaque.push(bytes[i]! * 65536 + bytes[i + 1]! * 256 + bytes[i + 2]!);
      }
      expect(opaque.length, sprite).toBeGreaterThan(64);
      expect(new Set(opaque).size, sprite).toBeGreaterThan(3);
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
    // The six monster portraits are lazy (on-demand IMG entries, not ui:img),
    // so only the six static backdrops carry an inline image path.
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
    // The monster portraits composite the 64x64 front sprite centred on the
    // 256x144 backdrop: the centremost 64x64 band must paint the monster
    // (opaque, multi-colour pixels above the gradient background).
    for (const slug of ["budaye", "dollfin", "grintot", "ignibus", "memnomnom", "rockitten"]) {
      const relative = `assets/screen-layers/tux-backdrop-bg_gradient_blue_${slug}_monster.png`;
      const image = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
      // The composited backdrop is stored 256x256 (POT); the art occupies its
      // top 256x144. The centred 64x64 sprite sits at x=96, y=40.
      const colours = new Set<number>();
      let opaque = 0;
      for (let y = 40; y < 104; y++) {
        for (let x = 96; x < 160; x++) {
          const i = (y * 256 + x) * 4;
          if (image.rgba[i + 3]! > 0) {
            opaque++;
            colours.add(image.rgba[i]! * 65536 + image.rgba[i + 1]! * 256 + image.rgba[i + 2]!);
          }
        }
      }
      expect(opaque, relative).toBeGreaterThan(500);
      expect(colours.size, relative).toBeGreaterThan(8);
    }
  });

  test("KS2 monster portraits paint the front sprite, rebuilt independently", () => {
    // The six starter portraits must show the monster, not just the story
    // backdrop. Each portrait is diffed against the background-only backdrop
    // (swapping a portrait for the pure gradient must fail), and every pixel
    // must match an independent rebuild from the upstream background and
    // battle sheet, using the same source-over and resample math as
    // gen-assets (copied here on purpose so a pipeline change is caught).
    const sourceRoot = TUXEMON_SRC;
    const background = decodePng(
      new Uint8Array(readFileSync(join(sourceRoot, "mods/tuxemon/gfx/ui/background/gradient_blue.png"))),
      "gradient_blue.png",
    );
    expect([background.width, background.height]).toEqual([256, 144]);
    const plain = decodePng(
      new Uint8Array(readFileSync(resolve(ROOT, "assets/screen-layers/tux-backdrop-bg_gradient_blue.png"))),
      "plain backdrop",
    );
    expect([plain.width, plain.height]).toEqual([256, 256]);
    for (const slug of ["budaye", "dollfin", "grintot", "ignibus", "memnomnom", "rockitten"]) {
      const relative = `assets/screen-layers/tux-backdrop-bg_gradient_blue_${slug}_monster.png`;
      const portrait = decodePng(new Uint8Array(readFileSync(resolve(ROOT, relative))), relative);
      expect([portrait.width, portrait.height]).toEqual([256, 256]);
      // Diff against the background-only backdrop: the subject is exactly
      // the pixels that differ, and it must sit in the centered 64x64 band
      // where the front crop is composited (source x 96..159, y 40..103).
      let subjectPixels = 0;
      let outsideBand = 0;
      for (let y = 0; y < portrait.height; y++) {
        const sourceY = Math.min(
          background.height - 1,
          Math.floor((y + 0.5) * background.height / portrait.height),
        );
        for (let x = 0; x < portrait.width; x++) {
          const i = (y * portrait.width + x) * 4;
          let same = true;
          for (let c = 0; c < 4; c++) {
            if (portrait.rgba[i + c]! !== plain.rgba[i + c]!) {
              same = false;
              break;
            }
          }
          if (!same) {
            subjectPixels++;
            if (x < 96 || x >= 160 || sourceY < 40 || sourceY >= 104) outsideBand++;
          }
        }
      }
      expect(
        subjectPixels,
        `${slug}: portrait must paint the monster; a pure-gradient swap must fail`,
      ).toBeGreaterThan(400);
      expect(outsideBand, `${slug}: subject pixels must stay in the centered front-crop band`).toBe(0);
      // Independent rebuild: composite the sheet's front crop (upstream
      // MonsterSpritesModel default 0,0,64,64) onto the 256x144 background,
      // then resample to the 256x256 portable texture.
      const sheet = decodePng(
        new Uint8Array(readFileSync(join(sourceRoot, `mods/tuxemon/gfx/sprites/battle/${slug}-sheet.png`))),
        `${slug}-sheet.png`,
      );
      const crop = { x: 0, y: 0, w: 64, h: 64 };
      const composed = background.rgba.slice();
      const left = Math.floor((background.width - crop.w) / 2);
      const top = Math.floor((background.height - crop.h) / 2);
      for (let y = 0; y < crop.h; y++) {
        for (let x = 0; x < crop.w; x++) {
          const src = ((crop.y + y) * sheet.width + crop.x + x) * 4;
          const dst = ((top + y) * background.width + left + x) * 4;
          const srcA = sheet.rgba[src + 3]!;
          const dstA = composed[dst + 3]!;
          const outA = srcA + Math.round(dstA * (255 - srcA) / 255);
          for (let c = 0; c < 3; c++) {
            const premultiplied = sheet.rgba[src + c]! * srcA +
              Math.round(composed[dst + c]! * dstA * (255 - srcA) / 255);
            composed[dst + c] = outA === 0 ? 0 : Math.round(premultiplied / outA);
          }
          composed[dst + 3] = outA;
        }
      }
      const rebuilt = new Uint8Array(portrait.width * portrait.height * 4);
      for (let y = 0; y < portrait.height; y++) {
        const sourceY = Math.min(
          background.height - 1,
          Math.floor((y + 0.5) * background.height / portrait.height),
        );
        for (let x = 0; x < portrait.width; x++) {
          const sourceX = Math.min(
            background.width - 1,
            Math.floor((x + 0.5) * background.width / portrait.width),
          );
          rebuilt.set(
            composed.subarray(
              (sourceY * background.width + sourceX) * 4,
              (sourceY * background.width + sourceX) * 4 + 4,
            ),
            (y * portrait.width + x) * 4,
          );
        }
      }
      let mismatches = 0;
      for (let i = 0; i < rebuilt.length; i += 4) {
        for (let c = 0; c < 4; c++) {
          if (portrait.rgba[i + c] !== rebuilt[i + c]) mismatches++;
        }
      }
      expect(mismatches, `${slug}: portrait must match the independent rebuild`).toBe(0);
    }
  }, 30_000);

  test("KS3 lazy monster portraits ship as on-demand IMG entries, not ui:img", () => {
    const { PORTRAIT_BACKDROPS } = require("../ui/portrait-backdrops.ts") as typeof import("../ui/portrait-backdrops.ts");
    const slugs = ["budaye", "dollfin", "grintot", "ignibus", "memnomnom", "rockitten"];
    expect(Object.keys(PORTRAIT_BACKDROPS).sort()).toEqual(
      slugs.map((slug) => `bg_gradient_blue_${slug}_monster`).sort(),
    );
    for (const [variant, def] of Object.entries(PORTRAIT_BACKDROPS)) {
      expect(def.w).toBe(256);
      expect(def.h).toBe(256);
      expect(def.entry).toBe(`portraits/${variant}.img`);
      // The self-contained IMG entry lives in dist/portraits (data.fs / pak blob).
      const imgPath = resolve(ROOT, "dist", "portraits", `${variant}.img`);
      expect(existsSync(imgPath), `${variant}: IMG entry missing`).toBe(true);
      const bytes = readFileSync(imgPath);
      expect(bytes.length, `${variant}: IMG entry size`).toBe(8 + 256 * 256 * 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(dv.getUint16(0, true), `${variant}: width`).toBe(256);
      expect(dv.getUint16(2, true), `${variant}: height`).toBe(256);
      expect(bytes[4], `${variant}: psm`).toBe(3); // PSM_8888
      // The lazy portrait must NOT be baked as an eager ui:img entry.
      const pngRelative = `assets/screen-layers/tux-backdrop-${variant}.png`;
      expect(images[pngRelative], `${variant}: must not be in images.json`).toBeUndefined();
      // The screen-layer variant is imageless (the kit paints nothing; the
      // game's PortraitBackdropEffects binds the on-demand texture).
      expect(GAME_ASSETS.layers?.tux_backdrop?.variants?.[variant]).toEqual({});
    }
  });

  test("KS4 lazy choice_monster icons ship as on-demand IMG entries, not ui:img", () => {
    const slugs = ["budaye", "dollfin", "fruitera", "grintot", "hydrone", "ignibus", "memnomnom", "rockitten"];
    const sprites = slugs.map((slug) => `tux_monster_menu_${slug}`).sort();
    expect(Object.keys(CHOICE_ICON_TEXTURES).sort()).toEqual(sprites);
    const pak = JSON.parse(readFileSync(resolve(ROOT, "pak.json"), "utf8")) as { key: string }[];
    for (const sprite of sprites) {
      const entry = `choice-icons/${sprite}.img`;
      expect(CHOICE_ICON_TEXTURES[sprite]?.entry).toBe(entry);
      // The self-contained IMG entry lives in dist/choice-icons (data.fs / pak blob).
      const imgPath = resolve(ROOT, "dist", "choice-icons", `${sprite}.img`);
      expect(existsSync(imgPath), `${sprite}: IMG entry missing`).toBe(true);
      const bytes = readFileSync(imgPath);
      expect(bytes.length, `${sprite}: IMG entry size`).toBe(8 + 16 * 16 * 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(dv.getUint16(0, true), `${sprite}: width`).toBe(16);
      expect(dv.getUint16(2, true), `${sprite}: height`).toBe(16);
      expect(bytes[4], `${sprite}: psm`).toBe(3); // PSM_8888
      // The lazy icon must NOT be baked as an eager ui:img entry, and its old
      // PNG path must not be kept reachable for the pak scanner either.
      const pngRelative = `assets/characters/npc-${sprite.replace(/_/g, "-")}-static.png`;
      expect(images[pngRelative], `${sprite}: must not be in images.json`).toBeUndefined();
      expect(NPC_SRC_ASSET_PATHS, `${sprite}: must not be a scanned PNG path`).not.toContain(pngRelative);
      // The raw IMG entry is packaged in the root pak (read via pakGet on web,
      // readFileSync from data.fs on desktop).
      expect(pak.some((e) => e.key === entry), `${sprite}: pak entry`).toBe(true);
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

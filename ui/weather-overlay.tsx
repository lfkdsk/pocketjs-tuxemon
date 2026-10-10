// Weather particles mounted through GameView's worldOverlay slot.
//
// It paints rain, snow, wind streaks and fog veils above the world using a
// fixed pool of image nodes repositioned every frame from the saved reference
// tick (see battle/weather-visuals.ts). GameView paints this slot below its
// daylight tint, dialogs, and fades, so those effects composite naturally.
// It hides indoors (the imported TMX `inside` set), while a scene or battle
// is open, while the save/load or demo menu is open, and for weathers without
// a profile.

import { type Component } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch, jump, type JumpBatch } from "@pocketjs/framework/animation";
import { createElement, insertNode, setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { weatherEnvelopeInto, type WeatherEnvelope } from "../battle/extension.ts";
import {
  MAX_WEATHER_PARTICLES,
  WEATHER_PROFILES,
  weatherAgeTicks,
  weatherParticleInto,
  weatherSlugHash,
  type ParticlePlacement,
  type WeatherProfile,
} from "../battle/weather-visuals.ts";
import { INDOOR_MAPS } from "./weather-maps.ts";
import { TERRAIN_WORLD } from "./terrain-assets.ts";

const INDOOR = new Set<string>(INDOOR_MAPS);

/** Profile slugs interned once at module load; the zero-alloc envelope reader
 *  matches the wire's slug region against this table and returns the interned
 *  key, so the per-frame path never allocates a string. */
const PROFILE_SLUGS: readonly string[] = Object.freeze(Object.keys(WEATHER_PROFILES));

export interface WeatherStateBridge {
  get: (() => Readonly<SessionState>) | null;
}

interface Slot {
  node: NodeMirror;
  opacity: number;
  width: number;
  height: number;
  src: string;
  visible: boolean;
}

interface SlotStyle {
  posType: number;
  insetL: number;
  insetT: number;
  width: number;
  height: number;
  opacity: number;
}

const slotStyle = (width: number, height: number): SlotStyle => ({
  posType: 1,
  insetL: 0,
  insetT: 0,
  width,
  height,
  opacity: 0,
});

/**
 * All per-frame state lives in this closure; the component itself renders
 * once and never touches Solid reactivity again.
 */
export const WeatherOverlay: Component<{
  bridge: WeatherStateBridge;
  suspended?: () => boolean;
}> = (props) => {
  const suspended = props.suspended;
  const root = createElement("view");
  setProp(root, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
  setProp(root, "debugName", "tux-weather-overlay");
  const slots: Slot[] = [];
  for (let index = 0; index < MAX_WEATHER_PARTICLES; index++) {
    const node = createElement("image");
    setProp(node, "style", slotStyle(2, 9));
    insertNode(root, node);
    slots.push({ node, opacity: 0, width: 2, height: 9, src: "", visible: false });
  }

  // Preload every profile texture once at mount on a hidden node that keeps
  // its binding for the app's lifetime. The streaming image cache is keyed
  // by texture path and evicts ref-0 entries under budget pressure, so a
  // scratch node that cycles through textures would let the early ones be
  // evicted before activation. One node per texture holds a ref, so the
  // activation-time setProp("src", …) hits the cache and allocates nothing.
  const preloadedTextures: string[] = [];
  for (let tableIndex = 0; tableIndex < PROFILE_SLUGS.length; tableIndex++) {
    const profile = WEATHER_PROFILES[PROFILE_SLUGS[tableIndex]!]!;
    let seen = false;
    for (let seenIndex = 0; seenIndex < preloadedTextures.length; seenIndex++) {
      if (preloadedTextures[seenIndex] === profile.texture) {
        seen = true;
        break;
      }
    }
    if (seen) continue;
    preloadedTextures.push(profile.texture);
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0, opacity: 0 });
    setProp(node, "src", profile.texture);
    insertNode(root, node);
  }

  // Per-profile position batches are built once at mount. A weather
  // activation or map re-entry only selects the pre-built batch, so the
  // activation frame allocates nothing (no slice/flatMap/tuples, no
  // createJumpBatch).
  const profileBatches: Record<string, JumpBatch> = {};
  for (let tableIndex = 0; tableIndex < PROFILE_SLUGS.length; tableIndex++) {
    const slug = PROFILE_SLUGS[tableIndex]!;
    const profile = WEATHER_PROFILES[slug]!;
    const entries: (readonly [NodeMirror, "translateX" | "translateY"])[] = [];
    for (let index = 0; index < profile.count; index++) {
      entries.push([slots[index]!.node, "translateX"]);
      entries.push([slots[index]!.node, "translateY"]);
    }
    profileBatches[slug] = createJumpBatch(entries);
  }

  let activeSlug = "";
  let slugHashValue = 0;
  let positionBatch: JumpBatch | null = null;
  // Reused every frame so the overlay's update/render path allocates nothing
  // per frame (the envelope reader and placement writer fill these in).
  const envelopeScratch: WeatherEnvelope = { slug: "", enteredAtTick: 0, refTick: 0, minuteOfDay: 0 };
  const placementScratch: ParticlePlacement = { x: 0, y: 0, opacity: 0 };

  const hideAll = (): void => {
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      if (slot.visible) {
        jump(slot.node, "opacity", 0);
        slot.visible = false;
      }
      slot.opacity = 0;
    }
  };

  const activate = (profile: WeatherProfile, slug: string): void => {
    slugHashValue = weatherSlugHash(slug);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      if (index < profile.count) {
        if (slot.src !== profile.texture) {
          setProp(slot.node, "src", profile.texture, slot.src);
          slot.src = profile.texture;
        }
        // width/height are animatable props, so jump sets the same host
        // prop the style object would — without setStyleObject's per-key
        // enumeration (which allocates a for-in iterator in QuickJS).
        if (slot.width !== profile.width) {
          jump(slot.node, "width", profile.width);
          slot.width = profile.width;
        }
        if (slot.height !== profile.height) {
          jump(slot.node, "height", profile.height);
          slot.height = profile.height;
        }
        // Force the first frame to re-apply opacity after a profile switch.
        slot.opacity = -1;
      } else if (slot.visible) {
        jump(slot.node, "opacity", 0);
        slot.visible = false;
        slot.opacity = 0;
      }
    }
    positionBatch = profileBatches[slug]!;
  };

  // Allocation-regression control. The QuickJS probe mounts and warms the
  // identical active overlay in both runs, then flips this stable object's
  // field only at the measured window so its diff cannot include divergent
  // texture/layout warm-up.
  const probeGlobals = globalThis as typeof globalThis & {
    __pocketTuxemonWeatherOverlayFrameControl?: { disabled: boolean };
    __pocketTuxemonWeatherOverlayProbe?: () => void;
    __pocketTuxemonWeatherOverlayProbeNoop?: () => void;
  };
  const frameControl = probeGlobals.__pocketTuxemonWeatherOverlayFrameControl;
  const updateWeather = (): void => {
    if (frameControl?.disabled === true) return;
    if (suspended?.()) {
      if (activeSlug !== "") {
        hideAll();
        activeSlug = "";
        positionBatch = null;
      }
      return;
    }
    const get = props.bridge.get;
    if (!get) return;
    const state = get();
    // Zero-alloc wire scan: fills envelopeScratch, returns false for legacy
    // object states (which simply show no overlay).
    if (!weatherEnvelopeInto(state.ext, envelopeScratch, PROFILE_SLUGS)) {
      if (activeSlug !== "") {
        hideAll();
        activeSlug = "";
        positionBatch = null;
      }
      return;
    }
    const envelope = envelopeScratch;
    const profile = WEATHER_PROFILES[envelope.slug];
    if (!profile || state.scene !== null || INDOOR.has(state.mapId)) {
      if (activeSlug !== "") {
        hideAll();
        activeSlug = "";
        positionBatch = null;
      }
      return;
    }
    if (activeSlug !== envelope.slug) {
      activate(profile, envelope.slug);
      activeSlug = envelope.slug;
    }
    const batch = positionBatch;
    if (!batch) return;
    // Match the active map's clipped/letterboxed frame without materializing
    // an object on the QuickJS hot path.
    const viewport = hostViewport(getOps());
    const viewportWidth = viewport?.w ?? 480;
    const viewportHeight = viewport?.h ?? 272;
    const world = (TERRAIN_WORLD as Record<string, { w: number; h: number }>)[state.mapId];
    const sizeW = world ? world.w : viewportWidth;
    const sizeH = world ? world.h : viewportHeight;
    const frameX = Math.max(0, Math.floor((viewportWidth - sizeW) / 2));
    const frameY = Math.max(0, Math.floor((viewportHeight - sizeH) / 2));
    const frameWidth = Math.min(sizeW, viewportWidth);
    const frameHeight = Math.min(sizeH, viewportHeight);
    const age = weatherAgeTicks(envelope.refTick, envelope.enteredAtTick);
    const placement = placementScratch;
    for (let index = 0; index < profile.count; index++) {
      const slot = slots[index]!;
      weatherParticleInto(
        profile,
        slugHashValue,
        index,
        age,
        frameWidth,
        frameHeight,
        1,
        placement,
      );
      batch.set(index * 2, frameX + placement.x);
      batch.set(index * 2 + 1, frameY + placement.y);
      if (placement.opacity !== slot.opacity) {
        jump(slot.node, "opacity", placement.opacity);
        slot.opacity = placement.opacity;
      }
      slot.visible = placement.opacity > 0;
    }
    batch.commit();
  };

  if (frameControl) {
    probeGlobals.__pocketTuxemonWeatherOverlayProbe = updateWeather;
    probeGlobals.__pocketTuxemonWeatherOverlayProbeNoop = (): void => {};
  }
  onFrame(updateWeather);

  return root as never;
};

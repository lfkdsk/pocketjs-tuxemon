// choice_monster row icons, painted from on-demand IMG entries.
//
// The eight menu-face sprites (tux_monster_menu_*) are not baked as eager
// ui:img entries (mount uploads every ui:img before the first frame, so an
// eager icon would pay its decode/upload at boot even in a session that
// never opens the starter choice). Instead gen-assets writes each as a raw
// IMG pak entry (dist/choice-icons/<sprite>.img) and the importer points
// npcSrc at the texture name `choice-icon:<sprite>`. This provider wraps the
// lazy npcSrc table so the first read of a menu sprite uploads its IMG entry
// and registers the texture — the same lazy path ui/portrait-backdrop.tsx
// uses for the monster-intro backdrops. Reads of every other sprite fall
// through to the underlying table unchanged.
//
// The wrapped table is what GameView reads (its choice-icon resolver and
// npcFrame both index npcSrc by sprite). The world-asset cache must receive
// the UNWRAPPED table: its residency/eviction controls key off the original
// lazy proxy (see ui/world-cache.ts).

import { pakGet, registerTexture } from "@pocketjs/framework";
import { getOps } from "@pocketjs/framework/host";
import { fsHost, readFileSync } from "@pocketjs/framework/fs";
import type { NpcArt } from "../vendor/pocket-rpgkit/src/ui/game-assets.ts";
import { CHOICE_ICON_TEXTURES } from "./choice-icon-textures.ts";

const registered = new Set<string>();

/** Upload the sprite's IMG entry once and bind it to `choice-icon:<sprite>`. */
function ensureChoiceIconTexture(sprite: string): string {
  const name = `choice-icon:${sprite}`;
  if (registered.has(name)) return name;
  const def = CHOICE_ICON_TEXTURES[sprite];
  if (!def) throw new Error(`choice icon: no lazy IMG entry for sprite "${sprite}"`);
  const host = fsHost();
  const blob = host ? readFileSync(def.entry) : pakGet(def.entry);
  const upload = getOps().uploadImgEntry;
  if (!upload) throw new Error(`choice icon: host has no uploadImgEntry op`);
  const handle = upload(blob);
  if (!Number.isInteger(handle) || handle < 0) {
    throw new Error(`choice icon: uploadImgEntry failed for ${def.entry}`);
  }
  registerTexture(name, handle);
  registered.add(name);
  return name;
}

/** Wrap the lazy npcSrc table so the eight choice_monster icons upload their
 *  texture on first access instead of at boot. */
export function createChoiceIconNpcSrc(
  base: Readonly<Record<string, NpcArt>>,
): Readonly<Record<string, NpcArt>> {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === "string" && prop in CHOICE_ICON_TEXTURES) {
        return ensureChoiceIconTexture(prop);
      }
      return Reflect.get(target, prop);
    },
    has(target, prop) {
      return (typeof prop === "string" && prop in CHOICE_ICON_TEXTURES) || Reflect.has(target, prop);
    },
  });
}

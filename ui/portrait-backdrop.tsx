// Monster-intro portrait backdrops, painted from on-demand IMG entries.
//
// The kit's ScreenEffectsLayer paints nothing for these imageless variants
// (the importer marks them lazy); this effects-slot component uploads the
// texture the first time the screen shows each variant, registers it under
// a name, and binds it to a full-screen Image via the same `src` path the
// kit's own backdrops use. The blob reads through the same entry readers
// the maps and battle shards use: data.fs on desktop, the pak on
// web/console. The upload is a ~1 ms 256x256 RGBA copy, so the switch
// frame stays well under budget without a prefetch stage.

import { createMemo } from "solid-js";
import { Image } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { pakGet, registerTexture } from "@pocketjs/framework";
import { fsHost, readFileSync } from "@pocketjs/framework/fs";
import type { GameScreenPresentationProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import { PORTRAIT_BACKDROPS } from "./portrait-backdrops.ts";

const registered = new Set<string>();

function ensurePortraitTexture(variant: string, entry: string): string {
  const name = `portrait:${variant}`;
  if (registered.has(name)) return name;
  const host = fsHost();
  const blob = host ? readFileSync(entry) : pakGet(entry);
  const upload = getOps().uploadImgEntry;
  if (!upload) throw new Error(`portrait: host has no uploadImgEntry op`);
  const handle = upload(blob);
  if (!Number.isInteger(handle) || handle < 0) {
    throw new Error(`portrait: uploadImgEntry failed for ${entry}`);
  }
  registerTexture(name, handle);
  registered.add(name);
  return name;
}

export function PortraitBackdropEffects(_props: GameScreenPresentationProps) {
  const src = createMemo(() => {
    const backdrop = _props.screen()?.backdrop;
    if (!backdrop || backdrop.layer !== "tux_backdrop") return "";
    const portrait = PORTRAIT_BACKDROPS[backdrop.variant];
    return portrait ? ensurePortraitTexture(backdrop.variant, portrait.entry) : "";
  });
  return (
    <Image
      class="absolute w-full h-full"
      src={src()}
      style={{ posType: 1, display: src() ? 0 : 1 }}
      debugName="tuxemon-portrait-backdrop"
    />
  );
}

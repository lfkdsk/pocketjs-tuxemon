// GP1 fix 1: GameAssets.npcSrc used to bundle every NPC's sprite-frame paths
// as one eager object literal (175 entries, ~136 KB — the second-largest
// remaining input in ui/game-assets.ts after animated tiles). GameView only
// ever reads `npcSrc[name]` for the specific NPC art id it is currently
// resolving (never an enumeration — see GameView.tsx's npcFrame), so this
// splits the table the same way splitAnimatedTiles splits map tile
// placements: one canonical entry per NPC art id.
import type { NpcArt } from "../vendor/pocket-rpgkit/src/ui/game-assets.ts";

export interface NpcSrcIndexEntry {
  id: string;
  entry: string;
}

export interface NpcSrcSplitEntry {
  path: string;
  bytes: Uint8Array;
  meta: NpcSrcIndexEntry;
}

export interface NpcSrcSplit {
  index: readonly NpcSrcIndexEntry[];
  entries: readonly NpcSrcSplitEntry[];
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 1) + "\n");
}

/** GP1 fix 2: the asset paths one NPC's art entry references, for
 *  cross-checking against NPC_SRC_ASSET_PATHS (ui/npc-src-assets.ts) — the
 *  literal list that keeps PocketJS's pass-1 scanner baking every NPC
 *  sprite texture named here into the app pak. Lazy texture names (the
 *  `choice-icon:` entries) are not baked PNGs, so they are excluded. */
export function collectNpcSrcAssetPaths(art: NpcArt): readonly string[] {
  const paths = typeof art === "string" ? [art] : [...art.idle, ...art.walkL, ...art.walkR];
  return paths.filter((path) => path.startsWith("assets/"));
}

export function splitNpcSrc(npcSrc: Readonly<Record<string, NpcArt>>): NpcSrcSplit {
  const index: NpcSrcIndexEntry[] = [];
  const entries: NpcSrcSplitEntry[] = [];
  for (const id of Object.keys(npcSrc).sort()) {
    const path = `npc-src/${id}.json`;
    const meta: NpcSrcIndexEntry = { id, entry: path };
    index.push(meta);
    entries.push({ path, bytes: jsonBytes(npcSrc[id]), meta });
  }
  return { index, entries };
}

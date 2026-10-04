// Content-driven music catalogue for the audio transcode pipeline.
//
// Tuxemon maps refer to music through play_music actions. Battle-capable
// environments separately name their battle, victory and defeat music. This
// scanner reads both sources and resolves exact slugs through the upstream
// music DB; misspelled slugs and raw filenames stay unresolved, matching
// Tuxemon's own db.get_entry("music", slug) behaviour.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTmx, readYamlEvents } from "../importer/source.ts";

export type MusicReferenceKind = "map" | "environment";

export interface MusicReference {
  slug: string;
  count: number;
  kinds: MusicReferenceKind[];
}

export interface ResolvedMusicReference extends MusicReference {
  source: string;
}

export interface MusicCatalog {
  mapActionCount: number;
  environmentReferenceCount: number;
  resolved: ResolvedMusicReference[];
  unresolved: MusicReference[];
}

function increment(
  refs: Map<string, { count: number; kinds: Set<MusicReferenceKind> }>,
  slug: string,
  kind: MusicReferenceKind,
): void {
  const current = refs.get(slug) ?? { count: 0, kinds: new Set() };
  current.count++;
  current.kinds.add(kind);
  refs.set(slug, current);
}

/** Parse every `- file: ... / slug: ...` pair in the upstream music DB. */
export function loadMusicSlugIndex(sourceRoot: string): Map<string, string> {
  const dbDir = join(sourceRoot, "mods", "tuxemon", "db", "music");
  const index = new Map<string, string>();
  for (const name of readdirSync(dbDir).filter((file) => file.endsWith(".yaml")).sort()) {
    const text = readFileSync(join(dbDir, name), "utf8");
    for (const match of text.matchAll(/^- file: (.+)\n  slug: (\S+)/gm)) {
      const slug = match[2]!.trim();
      if (!index.has(slug)) index.set(slug, match[1]!.trim());
    }
  }
  return index;
}

/** Scan all authored map files once, mirroring the importer's file census. */
function scanMapMusic(
  sourceRoot: string,
  refs: Map<string, { count: number; kinds: Set<MusicReferenceKind> }>,
): number {
  const mapsDir = join(sourceRoot, "mods", "tuxemon", "maps");
  const files = readdirSync(mapsDir).sort();
  let count = 0;
  const visit = (actions: readonly { type: string; args: string[] }[]): void => {
    for (const action of actions) {
      if (action.type !== "play_music" || !action.args[0]) continue;
      increment(refs, action.args[0], "map");
      count++;
    }
  };
  for (const name of files) {
    if (name.endsWith(".tmx")) {
      for (const event of readTmx(join(mapsDir, name)).events) visit(event.acts);
    } else if (name.endsWith(".yaml")) {
      for (const event of readYamlEvents(join(mapsDir, name), "yaml")) visit(event.acts);
    }
  }
  return count;
}

/** Scan battle/victory/defeat music in every authored environment. */
function scanEnvironmentMusic(
  sourceRoot: string,
  refs: Map<string, { count: number; kinds: Set<MusicReferenceKind> }>,
): number {
  const environmentDir = join(sourceRoot, "mods", "tuxemon", "db", "environment");
  let count = 0;
  for (const name of readdirSync(environmentDir).filter((file) => file.endsWith(".yaml")).sort()) {
    const document = Bun.YAML.parse(readFileSync(join(environmentDir, name), "utf8")) as {
      battle_music?: Record<string, { music?: unknown } | null>;
    } | null;
    for (const entry of Object.values(document?.battle_music ?? {})) {
      if (typeof entry?.music !== "string" || entry.music.length === 0) continue;
      increment(refs, entry.music, "environment");
      count++;
    }
  }
  return count;
}

export function buildMusicCatalog(sourceRoot: string): MusicCatalog {
  const refs = new Map<string, { count: number; kinds: Set<MusicReferenceKind> }>();
  const mapActionCount = scanMapMusic(sourceRoot, refs);
  const environmentReferenceCount = scanEnvironmentMusic(sourceRoot, refs);
  const index = loadMusicSlugIndex(sourceRoot);
  const resolved: ResolvedMusicReference[] = [];
  const unresolved: MusicReference[] = [];

  for (const [slug, ref] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
    const base = { slug, count: ref.count, kinds: [...ref.kinds].sort() };
    const source = index.get(slug);
    if (source) resolved.push({ ...base, source });
    else unresolved.push(base);
  }

  return { mapActionCount, environmentReferenceCount, resolved, unresolved };
}

if (import.meta.main) {
  const root = process.env.TUXEMON_SRC ?? resolve(import.meta.dir, "../.tuxemon-src");
  console.log(JSON.stringify(buildMusicCatalog(root), null, 2));
}

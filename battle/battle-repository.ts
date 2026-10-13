// Lazy, sharded BattleDb source. GP1 moves species/technique/item/status
// tables out of the bundle: production imports only the compact
// BattleRuntimeShell (core rules + per-table slug indexes), and this module
// resolves each slug's data from a pak/data.fs entry on first read. Parsed
// shards are cached for the life of the provider — a battle only ever pays
// for the species and techniques it actually touches, and a slug seen again
// later (a rematch, a returning starter) is already resident.
//
// decodeMapEntryBytes is the kit's bounded-chunk ASCII decoder; reusing it
// keeps the QuickJS fast path shared with map entries instead of adding a
// second byte-to-string routine.
import { decodeMapEntryBytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import type {
  BattleDb,
  BattleRuntimeIndexEntry,
  BattleRuntimeShell,
  BattleRuntimeStatusIndexEntry,
} from "../importer/battle-schema.ts";
import type { BattleDbProvider } from "./extension.ts";

export type { BattleRuntimeIndexEntry, BattleRuntimeShell, BattleRuntimeStatusIndexEntry };

export interface BattleEntrySource {
  read(entry: string): string | Uint8Array | undefined;
}

function decodeEntry(input: string | Uint8Array): string {
  return typeof input === "string" ? input : decodeMapEntryBytes(input);
}

/** One shard table (monsters, techniques, items or statuses): a Proxy that
 * parses and caches exactly the slugs read through it. `has`/`in` are
 * answered from the index alone, at zero parse cost. */
function lazyShardTable(
  entries: readonly BattleRuntimeIndexEntry[],
  source: BattleEntrySource,
  label: string,
): Record<string, unknown> {
  const index = new Map(entries.map((meta) => [meta.id, meta.entry]));
  const cache = new Map<string, unknown>();
  const resolveCached = (prop: string): unknown => {
    if (cache.has(prop)) return cache.get(prop);
    const entry = index.get(prop);
    if (entry === undefined) return undefined;
    const input = source.read(entry);
    if (input === undefined) {
      throw new Error(`battle repository: missing ${label} entry '${prop}' (${entry})`);
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeEntry(input));
    } catch {
      throw new Error(`battle repository: ${label} entry '${prop}' (${entry}) is not JSON`);
    }
    cache.set(prop, value);
    return value;
  };
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return typeof prop === "string" ? resolveCached(prop) : undefined;
    },
    has(_target, prop) {
      return typeof prop === "string" && index.has(prop);
    },
    // Only Object.keys/entries/spread (tests, tooling — never the runtime
    // battle path) reach these; they enumerate every slug and therefore
    // force every shard to resolve, same as the plain-object eager path did.
    ownKeys() {
      return [...index.keys()];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string" || !index.has(prop)) return undefined;
      return { value: resolveCached(prop), enumerable: true, configurable: true, writable: false };
    },
  });
}

/** Builds a `BattleDbProvider` over a shell + entry source. `load()` returns
 * the same object on every call for the life of the provider: the core
 * fields are already resident, and the four shard tables keep resolving new
 * slugs lazily and caching them, so a later battle reusing an earlier
 * species/technique never re-reads or re-parses it. There is no `release()`:
 * evicting the caches would only force paying the same parse cost again on
 * the next battle, and the fully-resident worst case is the same 801 KB the
 * bundle used to carry unconditionally. */
export function createTuxemonBattleDbProvider(
  shell: BattleRuntimeShell,
  source: BattleEntrySource,
): BattleDbProvider {
  let db: BattleDb | null = null;
  const statusIcons = Object.fromEntries(
    shell.statusesIndex.map((entry) => [entry.id, entry.icon]),
  );
  return {
    statusIcons,
    load(): BattleDb {
      if (db) return db;
      db = {
        format: shell.format,
        sourceRevision: shell.sourceRevision,
        scope: shell.scope,
        rules: shell.rules,
        shapes: shell.shapes,
        elements: shell.elements,
        elementOrder: shell.elementOrder,
        tastes: shell.tastes,
        tasteOrder: shell.tasteOrder,
        encounters: shell.encounters,
        battleMusic: shell.battleMusic,
        environments: shell.environments,
        weather: shell.weather,
        plagues: shell.plagues ?? {},
        npcs: shell.npcs,
        ui: shell.ui,
        monsters: lazyShardTable(shell.monstersIndex, source, "monster") as BattleDb["monsters"],
        techniques: lazyShardTable(shell.techniquesIndex, source, "technique") as BattleDb["techniques"],
        items: lazyShardTable(shell.itemsIndex, source, "item") as BattleDb["items"],
        statuses: lazyShardTable(shell.statusesIndex, source, "status") as BattleDb["statuses"],
      } as unknown as BattleDb;
      return db;
    },
  };
}

import {
  createWorldPrefetcher,
  type WorldPrefetchStats,
  type WorldPrefetcher,
} from "../vendor/pocket-rpgkit/src/engine/world-prefetch.ts";
import {
  componentOfMap,
  workingSet,
  type ImminentMap,
  type WorldWorkingSet,
} from "../vendor/pocket-rpgkit/src/engine/world-working-set.ts";
import {
  releaseSessionMapLayers,
  releaseSessionMapsExcept,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  CameraState,
  WorldLayout,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type {
  WorldCacheDriver,
  WorldCacheDriverOptions,
} from "../vendor/pocket-rpgkit/src/ui/world-cache-driver.ts";

/** Zero makes the prefetcher advance exactly one indivisible preparation
 * stage per production frame. The 12-map two-hop set therefore settles within
 * the pressure route's 64-frame bound without bunching parse/validation and
 * world compilation on one frame. */
export const GAME_WORLD_PREFETCH_BUDGET_MS = 0;
/** Entry autoruns/parallels are most expensive during their first few ticks.
 * Keep derived-cache parse/compile work off those ticks, while leaving 52 of
 * the 64 pressure-route frames available for the bounded two-hop prefetch. */
export const GAME_WORLD_ENTRY_SETTLE_FRAMES = 12;
/** Keep the two confirmation frames after the final prefetch stage clear, so
 * deferred sidecar decoding cannot refill the heap while the prepared map is
 * first presented. */
export const GAME_WORLD_PREFETCH_AUDIO_COOLDOWN_FRAMES = 2;

export type WorldLookaheadIndex = ReadonlyMap<string, readonly string[]>;

export interface GameWorldCacheDriverOptions extends WorldCacheDriverOptions {
  /** Reports whether transition settling or synchronous prefetch work owns
   * this frame, so unrelated deferred work can yield. */
  onPrefetchActivity?(active: boolean): void;
}

/** Stable direct-neighbour index for the immutable outdoor topology. */
export function createWorldLookaheadIndex(layout: Readonly<WorldLayout>): WorldLookaheadIndex {
  const mutable = new Map<string, Set<string>>();
  for (const component of layout.components) {
    for (const placement of component.placements) {
      mutable.set(placement.mapId, new Set());
    }
    for (const opening of component.openings) {
      mutable.get(opening.source.mapId)?.add(opening.target.mapId);
    }
  }
  return new Map([...mutable].map(([mapId, neighbours]) => [
    mapId,
    [...neighbours].sort(),
  ]));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function pausedPrefetchStats(
  sess: Session,
  set: Readonly<WorldWorkingSet>,
  prefetcher: WorldPrefetcher,
): WorldPrefetchStats {
  let staged = 0;
  let pending = 0;
  for (const mapId of set.compiledKeep) {
    if (sess.maps.has(mapId) && sess.worlds.has(mapId) && sess.tables.has(mapId)) continue;
    const preparation = sess.preparingMaps.get(mapId);
    if (preparation?.map && preparation.world && preparation.table) staged++;
    else pending++;
  }
  return {
    staged,
    pending,
    stages: 0,
    stageMs: 0,
    failures: prefetcher.failures(),
  };
}

/** Add one stable lookahead hop through every direct exit. The kit already
 * keeps those direct neighbours; retaining their targets prevents player
 * facing changes from repeatedly evicting and recompiling the same second-hop
 * worlds while still bounding residency to two graph hops. */
export function withTwoHopWorldLookahead(
  set: Readonly<WorldWorkingSet>,
  index: WorldLookaheadIndex,
): WorldWorkingSet {
  const compiled = new Set(set.compiledKeep);
  const seen = new Set<string>();
  const lookahead: ImminentMap[] = [];
  for (const via of set.imminent) {
    for (const mapId of index.get(via.mapId) ?? []) {
      if (compiled.has(mapId) || seen.has(mapId)) continue;
      seen.add(mapId);
      lookahead.push({
        mapId,
        portalId: `lookahead:${via.mapId}:${mapId}`,
        side: via.side,
        distance: Number.MAX_SAFE_INTEGER,
        compatibility: "coordinate-preserving",
      });
    }
  }
  if (lookahead.length === 0) return set;
  const extra = lookahead.map((entry) => entry.mapId);
  return {
    ...set,
    imminent: [...set.imminent, ...lookahead],
    parsedKeep: sortedUnique([...set.parsedKeep, ...extra]),
    compiledKeep: sortedUnique([...set.compiledKeep, ...extra]),
  };
}

/** Game-specific seamless cache policy: preserve the kit's authoritative
 * active/visible/direct-neighbour sets, add one bounded two-hop lookahead
 * hop, and advance synchronous preparation within a narrow frame budget. All
 * touched data is derived cache state and never enters reducer snapshots. */
export function createGameWorldCacheDriver(
  sess: Session,
  layout: Readonly<WorldLayout>,
  options: GameWorldCacheDriverOptions = {},
): WorldCacheDriver {
  const tile = sess.cfg.tile;
  const lookahead = createWorldLookaheadIndex(layout);
  const prefetcher = createWorldPrefetcher(sess, {
    budgetMs: options.budgetMs ?? GAME_WORLD_PREFETCH_BUDGET_MS,
    now: options.now,
  });
  let lastActive: string | null = null;
  let releaseDeferred = false;
  let audioCooldownFrames = 0;

  return {
    sync(state: Readonly<SessionState>, camera: Readonly<CameraState>, viewport) {
      const changed = lastActive !== state.mapId;
      const mapChanged = lastActive !== null && changed;
      if (mapChanged) releaseDeferred = true;
      const entryFrame = state.interp?.frame;
      const entrySettling = entryFrame !== undefined && entryFrame < GAME_WORLD_ENTRY_SETTLE_FRAMES;
      const transitionBusy = mapChanged || entrySettling ||
        state.fade != null || state.handoff !== undefined || state.scene != null;
      const releaseNow = releaseDeferred && !transitionBusy;
      const component = componentOfMap(layout, state.mapId);
      if (!component) {
        options.onPrefetchActivity?.(transitionBusy || releaseDeferred);
        if ((changed && !releaseDeferred) || releaseNow) {
          releaseSessionMapsExcept(sess, [state.mapId]);
          releaseDeferred = false;
        }
        lastActive = state.mapId;
        return;
      }
      const placement = component.placements.find((entry) => entry.mapId === state.mapId);
      if (!placement) {
        options.onPrefetchActivity?.(transitionBusy || releaseDeferred);
        return;
      }
      const base = workingSet(
        layout,
        state.mapId,
        { x: camera.x, y: camera.y, w: viewport.w, h: viewport.h },
        tile,
        {
          x: placement.originTileX + state.move.tx,
          y: placement.originTileY + state.move.ty,
        },
        state.move.facing,
      );
      const set = withTwoHopWorldLookahead(base, lookahead);
      // Fade-out already prepares its transfer target one stage per reducer
      // tick. Seam handoffs and full-screen scenes are likewise transition
      // frames, so do not stack unrelated derived-cache compilation on top.
      // Retention still uses the full set; ordinary world frames resume the
      // exact same pending preparations without changing simulation state.
      const busyFrame = transitionBusy || releaseDeferred ||
        state.move.moving ||
        state.move.walking ||
        state.playerRoute != null ||
        state.interp?.main != null ||
        state.interp?.modal != null ||
        Object.keys(state.interp?.parallels ?? {}).length > 0;
      const prefetchStats = busyFrame
        ? pausedPrefetchStats(sess, set, prefetcher)
        : prefetcher.update(set);
      const prefetchActive = prefetchStats.stages > 0;
      let audioCooldownActive = false;
      if (prefetchActive) {
        audioCooldownFrames = GAME_WORLD_PREFETCH_AUDIO_COOLDOWN_FRAMES;
      } else if (audioCooldownFrames > 0) {
        audioCooldownFrames--;
        audioCooldownActive = true;
      }
      options.onPrefetchActivity?.(
        transitionBusy || releaseDeferred || prefetchActive || audioCooldownActive,
      );
      if (!releaseDeferred || releaseNow) {
        releaseSessionMapLayers(sess, set.parsedKeep, set.compiledKeep, set.active);
        releaseDeferred = false;
      }
      lastActive = state.mapId;
      options.onStats?.({
        active: set.active,
        visible: set.visible,
        parsedKeep: set.parsedKeep,
        compiledKeep: set.compiledKeep,
        maps: sess.maps.size,
        worlds: sess.worlds.size,
        tables: sess.tables.size,
        staged: prefetchStats.staged,
        pending: prefetchStats.pending,
        preparing: sess.preparingMaps.size,
        runtime: sess.runtimeTables.size,
        repoCached: sess.repository?.stats?.().cached ?? 0,
        failures: prefetchStats.failures,
      });
    },
  };
}

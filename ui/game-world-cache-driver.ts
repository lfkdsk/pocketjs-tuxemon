import {
  createWorldPrefetcher,
  type WorldPrefetchStats,
  type WorldPrefetcher,
} from "../vendor/pocket-rpgkit/src/engine/world-prefetch.ts";
import {
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
  WorldPlacement,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type {
  WorldCacheDriver,
  WorldCacheDriverOptions,
} from "../vendor/pocket-rpgkit/src/ui/world-cache-driver.ts";
/** Zero makes the prefetcher advance exactly one indivisible direct-neighbour
 * preparation stage per production frame, without bunching parse/validation
 * and world compilation on one frame. */
export const GAME_WORLD_PREFETCH_BUDGET_MS = 0;
/** A stage that consumes at least half of a 60 Hz frame is followed by one
 * preparation-free frame. That leaves the host's boundary idle collector a
 * useful window instead of letting the next indivisible stage cross the
 * QuickJS hard threshold and collect inside gameplay. */
export const GAME_WORLD_PREFETCH_RECOVERY_MS = 8;
/** Entry autoruns/parallels are most expensive during their first few ticks.
 * Keep derived-cache parse/compile work off those ticks, while leaving ample
 * room in the pressure route's 64-frame bound for direct-neighbour prefetch. */
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

interface CachedWorkingSet {
  mapId: string;
  cameraLeft: number;
  cameraTop: number;
  cameraRight: number;
  cameraBottom: number;
  viewportW: number;
  viewportH: number;
  playerX: number;
  playerY: number;
  facing: number;
  set: WorldWorkingSet;
  prefetchSet: WorldWorkingSet;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sameRetention(
  a: Readonly<WorldWorkingSet>,
  b: Readonly<WorldWorkingSet> | null,
): boolean {
  return b !== null && (
    a === b || (
      a.active === b.active &&
      sameStrings(a.parsedKeep, b.parsedKeep) &&
      sameStrings(a.compiledKeep, b.compiledKeep)
    )
  );
}

function hasParallelWork(state: Readonly<SessionState>): boolean {
  const parallels = state.interp?.parallels;
  if (!parallels) return false;
  for (const id in parallels) {
    if (Object.prototype.hasOwnProperty.call(parallels, id)) return true;
  }
  return false;
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

/** Retain one stable lookahead hop through every direct exit. The kit already
 * prepares direct neighbours; keeping their targets prevents player-facing
 * changes from evicting previously compiled second-hop worlds without eagerly
 * compiling every speculative branch. */
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
    parsedKeep: sortedUnique([...set.parsedKeep, ...extra]),
    compiledKeep: sortedUnique([...set.compiledKeep, ...extra]),
  };
}

/** Game-specific seamless cache policy: preserve the kit's authoritative
 * active/visible/direct-neighbour sets, add one bounded two-hop retention
 * ring, and advance direct-neighbour preparation within a narrow frame budget.
 * All touched data is derived cache state and never enters reducer snapshots. */
export function createGameWorldCacheDriver(
  sess: Session,
  layout: Readonly<WorldLayout>,
  options: GameWorldCacheDriverOptions = {},
): WorldCacheDriver {
  const tile = sess.cfg.tile;
  const lookahead = createWorldLookaheadIndex(layout);
  const placementByMap = new Map<string, Readonly<WorldPlacement>>();
  for (const component of layout.components) {
    for (const placement of component.placements) {
      placementByMap.set(placement.mapId, placement);
    }
  }
  const prefetcher = createWorldPrefetcher(sess, {
    budgetMs: options.budgetMs ?? GAME_WORLD_PREFETCH_BUDGET_MS,
    now: options.now,
  });
  let lastActive: string | null = null;
  let releaseDeferred = false;
  let audioCooldownFrames = 0;
  let prefetchRecoveryFrames = 0;
  let cached: CachedWorkingSet | null = null;
  let released: WorldWorkingSet | null = null;

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
      const placement = placementByMap.get(state.mapId);
      if (!placement) {
        options.onPrefetchActivity?.(transitionBusy || releaseDeferred);
        if ((changed && !releaseDeferred) || releaseNow) {
          releaseSessionMapsExcept(sess, [state.mapId]);
          releaseDeferred = false;
          released = null;
        }
        cached = null;
        lastActive = state.mapId;
        return;
      }
      const cameraLeft = Math.floor(camera.x / tile);
      const cameraTop = Math.floor(camera.y / tile);
      const cameraRight = Math.ceil((camera.x + viewport.w) / tile);
      const cameraBottom = Math.ceil((camera.y + viewport.h) / tile);
      // Placements are tile-aligned, so sub-tile camera motion cannot change
      // visibility while these four inclusive/exclusive tile bounds stay
      // fixed. Player proximity changes only when its map-local tile or
      // facing changes. Reuse the immutable derived set between those edges.
      const reusable = cached !== null &&
        cached.mapId === state.mapId &&
        cached.cameraLeft === cameraLeft &&
        cached.cameraTop === cameraTop &&
        cached.cameraRight === cameraRight &&
        cached.cameraBottom === cameraBottom &&
        cached.viewportW === viewport.w &&
        cached.viewportH === viewport.h &&
        cached.playerX === state.move.tx &&
        cached.playerY === state.move.ty &&
        cached.facing === state.move.facing;
      let set: WorldWorkingSet;
      let prefetchSet: WorldWorkingSet;
      if (reusable) {
        set = cached!.set;
        prefetchSet = cached!.prefetchSet;
      } else {
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
        prefetchSet = base;
        set = withTwoHopWorldLookahead(base, lookahead);
        cached = {
          mapId: state.mapId,
          cameraLeft,
          cameraTop,
          cameraRight,
          cameraBottom,
          viewportW: viewport.w,
          viewportH: viewport.h,
          playerX: state.move.tx,
          playerY: state.move.ty,
          facing: state.move.facing,
          set,
          prefetchSet,
        };
      }
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
        hasParallelWork(state);
      const recoveryFrame = !busyFrame && prefetchRecoveryFrames > 0;
      let prefetchStats: WorldPrefetchStats;
      if (busyFrame || recoveryFrame) {
        prefetchStats = pausedPrefetchStats(sess, prefetchSet, prefetcher);
        if (recoveryFrame) prefetchRecoveryFrames--;
      } else {
        prefetchStats = prefetcher.update(prefetchSet);
        if (
          prefetchStats.stages > 0 &&
          prefetchStats.stageMs >= GAME_WORLD_PREFETCH_RECOVERY_MS
        ) {
          prefetchRecoveryFrames = 1;
        }
      }
      const prefetchActive = prefetchStats.stages > 0;
      let audioCooldownActive = false;
      if (prefetchActive) {
        audioCooldownFrames = GAME_WORLD_PREFETCH_AUDIO_COOLDOWN_FRAMES;
      } else if (audioCooldownFrames > 0) {
        audioCooldownFrames--;
        audioCooldownActive = true;
      }
      options.onPrefetchActivity?.(
        transitionBusy || releaseDeferred || prefetchActive || recoveryFrame || audioCooldownActive,
      );
      if (!releaseDeferred || releaseNow) {
        if (releaseNow || !sameRetention(set, released)) {
          releaseSessionMapLayers(sess, set.parsedKeep, set.compiledKeep, set.active);
        }
        // Point at the newest equivalent set as well, keeping the ordinary
        // stable-frame comparison on the identity fast path.
        released = set;
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

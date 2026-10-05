import { startSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { MapNotReadyError } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { decodeEnvelopeText, type SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import type { AnimatedTilesStats } from "../vendor/pocket-rpgkit/src/ui/AnimatedTiles.tsx";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { WorldStreamedTerrainStats } from "../vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx";
import type { GameWorldCacheSnapshot } from "./world-cache.ts";

export interface WorldVisitRequest {
  seq: number;
  mapId: string;
  x?: number;
  y?: number;
}

/** Sim-only request used by screenshot tooling. `snapshot` has already been
 * produced by the same pure reducer replay as the mainline verifier; the
 * production bundle decodes and restores it through the ordinary save gate
 * before it paints the requested frame. */
export interface WorldRestoreRequest {
  seq: number;
  snapshot: string;
  timelineFrame: number;
}

/** Mutable diagnostics object installed by sim/QuickJS verification before
 * the production bundle evaluates. Normal launches leave it undefined, so
 * GameView receives none of the diagnostic callbacks or overlay wrapper. */
export interface PocketTuxemonWorldDiagnostics {
  /** Visual-test-only: mount the ordinary demo controller in a zh_CN boot
   *  so its translated chrome can be inspected without making the English
   *  journey tape available to Chinese players. */
  enableZhDemo?: boolean;
  request?: WorldVisitRequest;
  acknowledged?: number;
  restoreRequest?: WorldRestoreRequest;
  restoreAcknowledged?: number;
  maps?: readonly string[];
  links?: Readonly<Record<string, readonly string[]>>;
  cache?: GameWorldCacheSnapshot;
  stream?: Partial<Record<"ground" | "upper", WorldStreamedTerrainStats>>;
  animated?: Partial<Record<"below" | "above", AnimatedTilesStats>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketTuxemonWorldDiagnostics: PocketTuxemonWorldDiagnostics | undefined;
}

/** Wrap the ordinary save overlay with a verification-only map-entry driver.
 * Each request starts from the current persistent switch/extension state and
 * performs the same fresh map-entry construction as a normal session start.
 * It does not alter project data, traversal mode, or the production reducer. */
export function withWorldDiagnostics(
  base: GameViewOverlayConfig,
  diagnostics: PocketTuxemonWorldDiagnostics,
): GameViewOverlayConfig {
  return {
    create(host) {
      const runtime = base.create(host);
      let handled = diagnostics.acknowledged ?? -1;
      let restoreHandled = diagnostics.restoreAcknowledged ?? -1;
      let pendingRestore: {
        request: WorldRestoreRequest;
        snapshot: SaveSnapshot;
        ready: boolean;
        error?: unknown;
      } | null = null;

      const restore = (
        request: WorldRestoreRequest,
        snapshot: SaveSnapshot,
      ): { consumed: true; stateChanged: true } | null => {
        try {
          const restored = restoreSessionSnapshot(host.session, snapshot);
          host.replaceState({ ...restored, frame: request.timelineFrame }, snapshot.held);
          restoreHandled = request.seq;
          diagnostics.restoreAcknowledged = request.seq;
          pendingRestore = null;
          return { consumed: true, stateChanged: true };
        } catch (error) {
          const repository = host.session.repository;
          if (!(error instanceof MapNotReadyError) || !repository?.prepare) throw error;
          const pending = { request, snapshot, ready: false, error: undefined as unknown };
          pendingRestore = pending;
          void repository.prepare(error.mapId).then(
            () => { pending.ready = true; },
            (reason) => { pending.error = reason ?? new Error(`world diagnostics: failed to prepare ${error.mapId}`); },
          );
          return null;
        }
      };
      return {
        isOpen: () => runtime.isOpen(),
        render: (theme, uiText) => runtime.render(theme, uiText),
        step(buttons, pressed) {
          const restoreRequest = diagnostics.restoreRequest;
          if (restoreRequest && restoreRequest.seq !== restoreHandled) {
            if (!Number.isInteger(restoreRequest.timelineFrame) || restoreRequest.timelineFrame < 0) {
              throw new Error("world diagnostics: restore timelineFrame must be a non-negative integer");
            }
            if (!pendingRestore || pendingRestore.request.seq !== restoreRequest.seq) {
              pendingRestore = null;
              const snapshot = decodeEnvelopeText(restoreRequest.snapshot);
              const restored = restore(restoreRequest, snapshot);
              if (restored) return restored;
            }
            if (pendingRestore?.error !== undefined) throw pendingRestore.error;
            if (pendingRestore?.ready) {
              const restored = restore(pendingRestore.request, pendingRestore.snapshot);
              if (restored) return restored;
            }
            return { consumed: true, stateChanged: false };
          }
          const request = diagnostics.request;
          if (request && request.seq !== handled) {
            const meta = host.session.mapIndex?.get(request.mapId);
            if (!meta) throw new Error(`world diagnostics: unknown map ${JSON.stringify(request.mapId)}`);
            const current = host.getState();
            const x = Math.max(0, Math.min(meta.width - 1, request.x ?? Math.floor(meta.width / 2)));
            const y = Math.max(0, Math.min(meta.height - 1, request.y ?? Math.floor(meta.height / 2)));
            const source = {
              ...host.project,
              start: { map: request.mapId, x, y, dir: "down" as const },
            };
            const next = startSession(source, host.session, current.sw, current.ext);
            host.replaceState(next);
            handled = request.seq;
            diagnostics.acknowledged = request.seq;
            return { consumed: true, stateChanged: true };
          }
          return runtime.step(buttons, pressed);
        },
      };
    },
  };
}

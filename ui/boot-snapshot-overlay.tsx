// Boot-snapshot overlay: a PSP journey segment build bakes a chapter save
// envelope into globalThis.__pocketTuxemonBootSnapshot before the first frame
// (tools/psp.ts --journey-segment). This overlay restores it once, so the tape
// replay starts from the chapter instead of a new game. Production builds
// leave the global unset and the overlay is inert.
//
// The overlay sets __pocketTuxemonBootReady after its first step whether or
// not it restored a snapshot, so the segment wrapper knows when to start
// feeding tape masks. The few frames folded before the restore are discarded
// by the session replace.

import type { JSX } from "solid-js";
import type {
  GameViewDemoRuntime,
  GameViewDemoStepResult,
  GameViewOverlayConfig,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { loadSession } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { prepareSessionMap } from "../vendor/pocket-rpgkit/src/engine/session.ts";

declare global {
  // eslint-disable-next-line no-var
  var __pocketTuxemonBootSnapshot: string | undefined;
  // eslint-disable-next-line no-var
  var __pocketTuxemonBootFrame: number | undefined;
  // eslint-disable-next-line no-var
  var __pocketTuxemonBootReady: boolean | undefined;
}

export interface BootSnapshotOverlayOptions {
  /** Keep a browser host/core frame uncommitted while a snapshot map chunk
   * is fetched and compiled. Local/PSP repositories never call this hook. */
  setFrameBlocked?: (blocked: boolean) => void;
}

export function createBootSnapshotOverlay(
  options: BootSnapshotOverlayOptions = {},
): GameViewOverlayConfig {
  return {
    create(host: GameViewSessionHost): GameViewDemoRuntime {
      let done = false;
      let snapshot: Parameters<typeof loadSession>[1] | undefined;
      let pending: { ready: boolean; error?: unknown } | null = null;

      const fail = (message: string): never => {
        done = true;
        options.setFrameBlocked?.(false);
        throw new Error(message);
      };

      return {
        step(_buttons: number, _pressed: number): GameViewDemoStepResult {
          if (done) return { consumed: false };
          const input = globalThis.__pocketTuxemonBootSnapshot;
          if (typeof input === "string" && input.length > 0) {
            // Chapter envelopes are baked as JSON text. Pass the inner
            // SaveSnapshot object (not the envelope string) so the load skips
            // the envelope content-identity check: chapter snapshots are
            // baked from the desktop project and carry no shard manifest.
            if (snapshot === undefined) {
              let parsed: { state?: unknown } | undefined;
              try {
                parsed = JSON.parse(input) as { state?: unknown } | undefined;
              } catch (error) {
                return fail(`boot snapshot restore failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              snapshot = (parsed && typeof parsed === "object" && "state" in parsed
                ? parsed.state
                : parsed) as Parameters<typeof loadSession>[1];
            }
            if (pending) {
              if (pending.error !== undefined) {
                return fail(`boot snapshot map preparation failed: ${
                  pending.error instanceof Error ? pending.error.message : String(pending.error)
                }`);
              }
              if (!pending.ready) return { consumed: true };
              pending = null;
            }
            const result = loadSession(host.session, snapshot);
            if (!result.ok) {
              const mapId = result.error?.mapId;
              if (result.error?.code === "map-not-ready" && mapId && host.session.repository?.prepare) {
                const wait = { ready: false, error: undefined as unknown };
                pending = wait;
                options.setFrameBlocked?.(true);
                void prepareSessionMap(host.session, mapId).then(
                  () => {
                    wait.ready = true;
                    options.setFrameBlocked?.(false);
                  },
                  (error) => {
                    wait.error = error ?? new Error(`map preparation failed: ${mapId}`);
                    options.setFrameBlocked?.(false);
                  },
                );
                return { consumed: true };
              }
              return fail(
                `boot snapshot restore failed: ${result.error?.code ?? "unknown"}`,
              );
            }
            // Chapter snapshots are taken at a safe point whose interpreter
            // tick counter is local to the baking replay; the chapter's
            // timelineFrame is the global position on the concatenated tape.
            // Correct the frame so the suffix replay lines up with the
            // desktop verifier (verifyChapterSuffixes does the same).
            const bootFrame = globalThis.__pocketTuxemonBootFrame;
            if (typeof bootFrame === "number") result.state.frame = bootFrame;
            host.replaceState(result.state, result.held);
            done = true;
            globalThis.__pocketTuxemonBootReady = true;
            return { consumed: true, stateChanged: true };
          }
          done = true;
          globalThis.__pocketTuxemonBootReady = true;
          return { consumed: false };
        },
        isOpen: () => false,
        render: (): JSX.Element => null,
      };
    },
  };
}

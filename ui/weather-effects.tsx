// GameView host-side audio effects. Weather paints through the independent
// worldOverlay slot, but keeps this raw reducer accessor bridge so its
// QuickJS frame path does not cross an allocating reactive-props accessor.

import { onCleanup } from "solid-js";
import { audioHost } from "@pocketjs/framework/audio";
import { simulationHz } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { get as pakGet } from "@pocketjs/framework/pak";
import type { GameEffectsComponent, GameEffectsProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import {
  createAudioDriver,
  type AudioDriverState,
  type AudioResourceReader,
} from "../vendor/pocket-rpgkit/src/ui/audio/index.ts";
import type { WeatherStateBridge } from "./weather-overlay.tsx";
import {
  createStagedDesktopAudioReader,
  type AudioChunkHost,
  type StagedDesktopAudioReader,
} from "./desktop-audio-loader.ts";
import {
  createAudioSettingsAdapter,
  type SettingsController,
} from "./settings.ts";
import { browserPakChunks, type BrowserPakChunks } from "./web-pak.ts";

interface SyncingAudioDriver {
  sync(state: AudioDriverState, timelineState?: AudioDriverState): void;
  retryResource(pakKey: string): void;
  dispose(): void;
}

export interface WebAudioChunkReader {
  read: AudioResourceReader;
  /** Forget driver-cached misses whose chunk completed while the host veil
   *  held simulation outside the frame loop. */
  retryReady(driver: Pick<SyncingAudioDriver, "retryResource">): void;
}

export function createWebAudioChunkReader(
  chunks: BrowserPakChunks,
  readResource: AudioResourceReader,
  reportError: (message: string) => void = (message) => console.error(message),
): WebAudioChunkReader {
  const pending = new Set<string>();
  const ready = new Set<string>();
  const failed = new Set<string>();
  return {
    read(pakKey) {
      if (chunks.ready(pakKey)) return readResource(pakKey);
      if (!pending.has(pakKey) && !failed.has(pakKey)) {
        pending.add(pakKey);
        void chunks.prepare(pakKey).then(
          () => { ready.add(pakKey); },
          (error) => {
            failed.add(pakKey);
            reportError(error instanceof Error ? error.message : String(error));
          },
        ).then(() => pending.delete(pakKey));
      }
      // AudioDriver deliberately treats unavailable audio as an optional
      // cached miss. retryReady clears precisely this key after prepare.
      throw new Error(`web audio chunk is not ready: ${pakKey}`);
    },
    retryReady(driver) {
      for (const pakKey of ready) driver.retryResource(pakKey);
      ready.clear();
    },
  };
}

export type StagedAudioFrameState = AudioDriverState & {
  readonly mapId: string;
  readonly scene?: { readonly kind: string } | null;
};

export interface StagedDesktopAudioCoordinator {
  sync(
    state: StagedAudioFrameState,
    backgroundIdle: boolean,
    timelineState?: StagedAudioFrameState,
  ): void;
  dispose(): void;
}

const trackUsesResource = (
  audioResources: Readonly<Record<string, string>>,
  track: { readonly id: string } | undefined,
  resource?: string,
): boolean => track !== undefined && (
  resource === undefined
    ? audioResources[track.id]?.startsWith("audio:qoa.") === true
    : audioResources[track.id] === resource
);

/** Coordinate the incremental sidecar reader with AudioDriver without ever
 * skipping its per-frame cue/poll/refill work. Driver replacement is reserved
 * for an idle handoff or for clearing a stale cached miss. */
export function createStagedDesktopAudioCoordinator(
  audioResources: Readonly<Record<string, string>>,
  staged: StagedDesktopAudioReader,
  driver: SyncingAudioDriver,
  initialMapId: string,
  initialSceneKind: string | undefined = undefined,
  reportError: (message: string) => void = (message) => console.error(message),
): StagedDesktopAudioCoordinator {
  let lastMapId = initialMapId;
  let lastSceneKind = initialSceneKind;
  let readyKey: string | undefined;
  let postMapFrames = 0;
  let resumeAfterMap = false;

  return {
    sync(state, backgroundIdle, timelineState = state) {
      const syncExisting = (driverState: AudioDriverState): void =>
        driver.sync(driverState, timelineState);
      const mapChanged = state.mapId !== lastMapId;
      const sceneKind = state.scene?.kind;
      const sceneChanged = sceneKind !== lastSceneKind;
      lastMapId = state.mapId;
      lastSceneKind = sceneKind;
      const mapCooldown = mapChanged || postMapFrames > 0;
      // Scene ownership changes must update the AudioDriver on this frame so
      // battle/result/map music is timely. Only defer the unrelated 64 KiB
      // sidecar page decode (and ready handoff) that could monopolize it.
      // The world cache deliberately stays "busy" for the lifetime of a
      // scene because its map prefetcher is parked. That is not competing
      // background work: after the scene-change frame, use those parked
      // frames to stage scene-owned battle/result music.
      const sceneOwnsFrame = sceneKind !== undefined;
      const deferAudioWork = mapCooldown || sceneChanged || (!backgroundIdle && !sceneOwnsFrame);
      if (mapChanged) {
        postMapFrames = 1;
        resumeAfterMap = true;
      } else if (postMapFrames > 0) {
        postMapFrames--;
      }
      const hideQoaForMap = mapCooldown || (resumeAfterMap && !backgroundIdle);
      if (!mapCooldown && backgroundIdle) resumeAfterMap = false;

      // A diagnostic/session refold presents the new map one frame after its
      // control frame. Let cues and WAV effects reconcile on both frames, but
      // do not create or refill a QOA stream there: its index/ring setup would
      // otherwise turn the first visible map frame into an audio spike.
      const audio = state.interp.audio;
      let driverState: AudioDriverState = state;
      if (hideQoaForMap && audio && (
        trackUsesResource(audioResources, audio.bgm) ||
        trackUsesResource(audioResources, audio.bgs) ||
        trackUsesResource(audioResources, audio.me)
      )) {
        driverState = {
          frame: state.frame,
          interp: {
            ...state.interp,
            audio: {
              ...audio,
              bgm: trackUsesResource(audioResources, audio.bgm) ? undefined : audio.bgm,
              bgs: trackUsesResource(audioResources, audio.bgs) ? undefined : audio.bgs,
              me: trackUsesResource(audioResources, audio.me) ? undefined : audio.me,
            },
          },
        };
      }

      if (readyKey) {
        const stillWanted = [audio?.bgm, audio?.bgs, audio?.me]
          .some((track) => trackUsesResource(audioResources, track, readyKey));
        if (!stillWanted) {
          staged.releaseReady(readyKey);
          driver.retryResource(readyKey);
          readyKey = undefined;
        } else if (!deferAudioWork) {
          const handedOff = readyKey;
          // Clear only this staged miss. Keeping the driver preserves every
          // live stream, including a paused map BGM parked behind battle and
          // result music, and its reducer/cue identity remains continuous.
          driver.retryResource(handedOff);
          syncExisting(state);
          staged.releaseReady(handedOff);
          readyKey = undefined;
          return;
        } else {
          // The driver has already cached this request as a miss, so it
          // cannot consume the one-shot ready bytes. Keep syncing it to retain
          // existing streams and one-frame WAV cues while handoff is deferred.
          syncExisting(driverState);
          return;
        }
      }

      if (!deferAudioWork && staged.hasPending()) {
        const result = staged.pump();
        if (result.kind === "ready") {
          readyKey = result.key;
          // Keep assembly and QOA setup on separate frames, but still service
          // the driver's existing streams and this frame's WAV cues.
          syncExisting(driverState);
          return;
        }
        if (result.kind === "failed") reportError(result.error);
      }
      syncExisting(driverState);
    },
    dispose() {
      driver.dispose();
    },
  };
}

export function createGameEffects(
  audioResources: Readonly<Record<string, string>>,
  readAudio: AudioResourceReader,
  desktopFs: AudioChunkHost | null = null,
  canRunDeferredAudio: () => boolean = () => true,
  settings: Pick<SettingsController, "get" | "revision"> | null = null,
): { Effects: GameEffectsComponent; bridge: WeatherStateBridge } {
  const bridge: WeatherStateBridge = { get: null };
  function Effects(props: GameEffectsProps) {
    bridge.get = props.state;
    const host = audioHost();
    if (!host) return null;
    const audioSettings = settings ? createAudioSettingsAdapter(settings) : null;
    const ticksPerFrame = 60 / simulationHz();
    if (!desktopFs) {
      // A chunked Web page prepares a missing track outside the guest clock,
      // then clears AudioDriver's optional-resource miss on the first frame
      // after the host veil. PSP and legacy single-pak pages retain the
      // original direct reader with no extra per-frame path.
      const webChunks = browserPakChunks();
      const staged = webChunks ? createWebAudioChunkReader(webChunks, readAudio) : null;
      const driver = createAudioDriver(
        host,
        audioResources,
        staged?.read ?? readAudio,
        ticksPerFrame,
      );
      onFrame(() => {
        staged?.retryReady(driver);
        const timelineState = props.state();
        driver.sync(audioSettings?.apply(timelineState) ?? timelineState, timelineState);
      });
      onCleanup(() => driver.dispose());
      return null;
    }

    // Desktop QOA files live in data.fs. Pull one bounded page only while a
    // requested track is incomplete. A completed track causes exactly one
    // driver replacement so its cached optional-resource miss is retried; the
    // staging reference is released immediately after that handoff. Neither
    // page reads nor QOA setup run on a map or scene transition frame; map
    // changes retain one additional cooldown frame. WAV effects stay in the
    // startup pak and remain immediate. A paged-I/O failure is reported for
    // that track without poisoning others.
    const staged = createStagedDesktopAudioReader(desktopFs, pakGet);
    const createDriver = () => createAudioDriver(host, audioResources, staged.read, ticksPerFrame);
    const coordinator = createStagedDesktopAudioCoordinator(
      audioResources,
      staged,
      createDriver(),
      props.state().mapId,
      props.state().scene?.kind,
    );
    onFrame(() => {
      const timelineState = props.state() as StagedAudioFrameState;
      coordinator.sync(
        (audioSettings?.apply(timelineState) ?? timelineState) as StagedAudioFrameState,
        canRunDeferredAudio(),
        timelineState,
      );
    });
    onCleanup(() => coordinator.dispose());
    return null;
  }
  return { Effects, bridge };
}

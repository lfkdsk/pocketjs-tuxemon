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

interface SyncingAudioDriver {
  sync(state: AudioDriverState): void;
  dispose(): void;
}

export type StagedAudioFrameState = AudioDriverState & { readonly mapId: string };

export interface StagedDesktopAudioCoordinator {
  sync(state: StagedAudioFrameState, backgroundIdle: boolean): void;
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
  initialDriver: SyncingAudioDriver,
  createDriver: () => SyncingAudioDriver,
  initialMapId: string,
  reportError: (message: string) => void = (message) => console.error(message),
): StagedDesktopAudioCoordinator {
  let driver = initialDriver;
  let lastMapId = initialMapId;
  let readyKey: string | undefined;
  let resetDriver = false;
  let postMapFrames = 0;
  let resumeAfterMap = false;
  let lastSyncedState: StagedAudioFrameState | undefined;
  let lastSyncedFrame: number | undefined;

  const syncExisting = (
    driverState: AudioDriverState,
    sourceState: StagedAudioFrameState,
  ): void => {
    driver.sync(driverState);
    lastSyncedState = sourceState;
    lastSyncedFrame = sourceState.frame;
  };

  const replaceAndSync = (state: StagedAudioFrameState): void => {
    driver.dispose();
    driver = createDriver();
    const repeated = lastSyncedState === state;
    const refolded = !repeated && lastSyncedFrame !== undefined && state.frame !== lastSyncedFrame + 1;
    // A fresh AudioDriver has no previous-frame identity. Preserve the old
    // driver's rule that a repeated/refolded state never replays historical
    // one-shot cues while still rebuilding persistent tracks at this state.
    const handoffState: AudioDriverState = repeated || refolded
      ? { frame: state.frame, interp: { ...state.interp, cues: [] } }
      : state;
    syncExisting(handoffState, state);
  };

  return {
    sync(state, backgroundIdle) {
      const mapChanged = state.mapId !== lastMapId;
      lastMapId = state.mapId;
      const mapCooldown = mapChanged || postMapFrames > 0;
      const deferAudioWork = mapCooldown || !backgroundIdle;
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
          readyKey = undefined;
          // The old driver cached the staged read as a miss. Replace it once
          // the frame is otherwise idle so this key can be requested later.
          resetDriver = true;
        } else if (!deferAudioWork) {
          const handedOff = readyKey;
          replaceAndSync(state);
          staged.releaseReady(handedOff);
          readyKey = undefined;
          return;
        } else {
          // The old driver has already cached this request as a miss, so it
          // cannot consume the one-shot ready bytes. Keep syncing it to retain
          // existing streams and one-frame WAV cues while handoff is deferred.
          syncExisting(driverState, state);
          return;
        }
      }

      if (resetDriver && !deferAudioWork) {
        resetDriver = false;
        replaceAndSync(state);
        return;
      }

      if (!deferAudioWork && staged.hasPending()) {
        const result = staged.pump();
        if (result.kind === "ready") {
          readyKey = result.key;
          // Keep assembly and QOA setup on separate frames, but still service
          // the old driver's existing streams and this frame's WAV cues.
          syncExisting(driverState, state);
          return;
        }
        if (result.kind === "failed") reportError(result.error);
      }
      syncExisting(driverState, state);
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
): { Effects: GameEffectsComponent; bridge: WeatherStateBridge } {
  const bridge: WeatherStateBridge = { get: null };
  function Effects(props: GameEffectsProps) {
    bridge.get = props.state;
    const host = audioHost();
    if (!host) return null;
    const ticksPerFrame = 60 / simulationHz();
    if (!desktopFs) {
      // Web and PSP keep all audio in the pak and retain the direct path.
      const driver = createAudioDriver(host, audioResources, readAudio, ticksPerFrame);
      onFrame(() => driver.sync(props.state()));
      onCleanup(() => driver.dispose());
      return null;
    }

    // Desktop QOA files live in data.fs. Pull one bounded page only while a
    // requested track is incomplete. A completed track causes exactly one
    // driver replacement so its cached optional-resource miss is retried; the
    // staging reference is released immediately after that handoff. Neither
    // page reads nor QOA setup run on the first ordinary frame after a map
    // change. WAV effects stay in the startup pak and remain immediate. A
    // paged-I/O failure is reported for that track without poisoning others.
    const staged = createStagedDesktopAudioReader(desktopFs, pakGet);
    const createDriver = () => createAudioDriver(host, audioResources, staged.read, ticksPerFrame);
    const coordinator = createStagedDesktopAudioCoordinator(
      audioResources,
      staged,
      createDriver(),
      createDriver,
      props.state().mapId,
    );
    onFrame(() => coordinator.sync(props.state(), canRunDeferredAudio()));
    onCleanup(() => coordinator.dispose());
    return null;
  }
  return { Effects, bridge };
}

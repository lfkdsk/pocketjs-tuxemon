import { expect, test } from "bun:test";
import {
  MAX_STAGED_AUDIO_BYTES,
  createStagedDesktopAudioReader,
  type StagedDesktopAudioReader,
} from "../ui/desktop-audio-loader.ts";
import {
  createStagedDesktopAudioCoordinator,
  type StagedAudioFrameState,
} from "../ui/weather-effects.tsx";

const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

test("desktop music is copied one bounded data.fs page per pump", () => {
  const music = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const reads: [string, number, number][] = [];
  const host = {
    read(path: string, offset: number, maxBytes: number): string {
      reads.push([path, offset, maxBytes]);
      const chunk = music.slice(offset, offset + maxBytes);
      return JSON.stringify({
        data: { $b: encode(chunk) },
        size: music.length,
        eof: offset + chunk.length === music.length,
      });
    },
  };
  const packed = new Uint8Array([99]);
  const staged = createStagedDesktopAudioReader(host, () => packed, 4);

  expect(staged.hasPending()).toBeFalse();
  expect(() => staged.read("audio:qoa.music/town.qoa")).toThrow("not ready");
  expect(staged.hasPending()).toBeTrue();
  expect(staged.pump()).toEqual({ kind: "progress", key: "audio:qoa.music/town.qoa" });
  expect(staged.pump()).toEqual({ kind: "progress", key: "audio:qoa.music/town.qoa" });
  expect(staged.pump()).toEqual({ kind: "ready", key: "audio:qoa.music/town.qoa" });
  expect(staged.hasPending()).toBeFalse();
  expect([...staged.read("audio:qoa.music/town.qoa")]).toEqual([...music]);
  // The handoff is one-shot: AudioDriver's QoaFile now owns the bytes, and
  // the staging cache cannot retain every song played during a session.
  expect(() => staged.read("audio:qoa.music/town.qoa")).toThrow("not ready");
  expect(staged.hasPending()).toBeTrue();
  expect(reads).toEqual([
    ["audio:qoa.music/town.qoa", 0, 4],
    ["audio:qoa.music/town.qoa", 4, 4],
    ["audio:qoa.music/town.qoa", 8, 4],
  ]);
  expect(staged.read("audio:wav.sounds/confirm.wav")).toBe(packed);
});

test("idle readers expose no pump work and do not touch the host", () => {
  let reads = 0;
  const staged = createStagedDesktopAudioReader({
    read(): string {
      reads++;
      throw new Error("idle reader must not be called");
    },
  }, () => new Uint8Array([1]), 4);

  expect(staged.hasPending()).toBeFalse();
  expect(reads).toBe(0);
});

test("a failed sidecar is reported without blocking another track", () => {
  let reads = 0;
  const missing = "audio:qoa.music/missing.qoa";
  const next = "audio:qoa.music/next.qoa";
  const staged = createStagedDesktopAudioReader({
    read(path): string {
      reads++;
      return path === missing
        ? JSON.stringify({ error: "not found" })
        : JSON.stringify({ data: { $b: encode(new Uint8Array([7])) }, size: 1, eof: true });
    },
  }, () => new Uint8Array([1]), 4);

  expect(() => staged.read(missing)).toThrow("not ready");
  expect(() => staged.read(next)).toThrow("not ready");
  expect(staged.pump()).toEqual({
    kind: "failed",
    key: missing,
    error: `${missing}: not found`,
  });
  expect(() => staged.read(missing)).toThrow("desktop audio sidecar failed");
  expect(staged.hasPending()).toBeTrue();
  expect(staged.pump()).toEqual({ kind: "ready", key: next });
  expect([...staged.read(next)]).toEqual([7]);
  expect(reads).toBe(2);
});

test("null and primitive data.fs responses fail cleanly", () => {
  for (const response of ["null", "17", JSON.stringify("bad")]) {
    const key = `audio:qoa.music/malformed-${response.length}.qoa`;
    const staged = createStagedDesktopAudioReader({ read: () => response }, () => new Uint8Array([1]), 4);
    expect(() => staged.read(key)).toThrow("not ready");
    expect(staged.pump()).toEqual({
      kind: "failed",
      key,
      error: `${key}: malformed data.fs response`,
    });
  }
});

test("completed-but-stale bytes can be released without a driver handoff", () => {
  const music = new Uint8Array([1, 2, 3]);
  const staged = createStagedDesktopAudioReader({
    read(): string {
      return JSON.stringify({
        data: { $b: encode(music) },
        size: music.length,
        eof: true,
      });
    },
  }, () => new Uint8Array([99]), 4);

  const key = "audio:qoa.music/stale.qoa";
  expect(() => staged.read(key)).toThrow("not ready");
  expect(staged.pump()).toEqual({ kind: "ready", key });
  staged.releaseReady(key);
  expect(() => staged.read(key)).toThrow("not ready");
  expect(staged.hasPending()).toBeTrue();
});

test("at most one completed sidecar waits for handoff", () => {
  const staged = createStagedDesktopAudioReader({
    read(path): string {
      const music = new Uint8Array([path.endsWith("a.qoa") ? 1 : 2]);
      return JSON.stringify({
        data: { $b: encode(music) },
        size: music.length,
        eof: true,
      });
    },
  }, () => new Uint8Array([99]), 4);
  const a = "audio:qoa.music/a.qoa";
  const b = "audio:qoa.music/b.qoa";

  expect(() => staged.read(a)).toThrow("not ready");
  expect(() => staged.read(b)).toThrow("not ready");
  expect(staged.pump()).toEqual({ kind: "ready", key: a });
  expect(staged.hasPending()).toBeFalse();
  expect(() => staged.pump()).toThrow("awaiting driver handoff");
  staged.releaseReady(a);
  expect(staged.hasPending()).toBeTrue();
  expect(staged.pump()).toEqual({ kind: "ready", key: b });
});

test("host-declared sidecars are capped before allocating", () => {
  const key = "audio:qoa.music/oversized.qoa";
  const staged = createStagedDesktopAudioReader({
    read(): string {
      return JSON.stringify({
        data: { $b: "" },
        size: MAX_STAGED_AUDIO_BYTES + 1,
        eof: false,
      });
    },
  }, () => new Uint8Array([1]), 4);

  expect(() => staged.read(key)).toThrow("not ready");
  expect(staged.pump()).toMatchObject({ kind: "failed", key });
  expect(() => staged.read(key)).toThrow(`${MAX_STAGED_AUDIO_BYTES + 1} exceeds ${MAX_STAGED_AUDIO_BYTES}`);
});

function audioState(
  frame: number,
  mapId: string,
  bgm: string | undefined,
  cue: string,
): StagedAudioFrameState {
  return {
    frame,
    mapId,
    interp: {
      audio: bgm ? { bgm: { id: bgm, volume: 100, pitch: 100, positionTicks: 0 } } : undefined,
      cues: [{ name: cue, volume: 100, pitch: 100 }],
    },
  } as StagedAudioFrameState;
}

test("ready and deferred handoff frames still sync one-frame WAV cues", () => {
  const key = "audio:qoa.music/a.qoa";
  let pending = true;
  const released: string[] = [];
  const staged: StagedDesktopAudioReader = {
    read: () => new Uint8Array([1]),
    hasPending: () => pending,
    pump: () => {
      pending = false;
      return { kind: "ready", key };
    },
    releaseReady: (releasedKey) => released.push(releasedKey),
  };
  const synced: string[][] = [];
  const drivers: Array<{ sync(state: StagedAudioFrameState): void; dispose(): void }> = [];
  const createDriver = () => {
    const driver = {
      sync(state: StagedAudioFrameState) {
        synced.push(state.interp.cues.map((cue) => "stop" in cue ? "stop" : cue.name));
      },
      dispose() {},
    };
    drivers.push(driver);
    return driver;
  };
  const coordinator = createStagedDesktopAudioCoordinator(
    { song: key, click: "audio:wav.click" },
    staged,
    createDriver(),
    createDriver,
    "map-a",
  );

  coordinator.sync(audioState(1, "map-a", "song", "click-final-page"), true);
  coordinator.sync(audioState(2, "map-a", "song", "click-waiting"), false);
  coordinator.sync(audioState(3, "map-a", "song", "click-handoff"), true);

  expect(synced).toEqual([
    ["click-final-page"],
    ["click-waiting"],
    ["click-handoff"],
  ]);
  expect(drivers).toHaveLength(2);
  expect(released).toEqual([key]);
});

test("a stale ready buffer invalidates the driver's cached miss on the next idle frame", () => {
  const key = "audio:qoa.music/a.qoa";
  let pending = true;
  const released: string[] = [];
  const staged: StagedDesktopAudioReader = {
    read: () => new Uint8Array([1]),
    hasPending: () => pending,
    pump: () => {
      pending = false;
      return { kind: "ready", key };
    },
    releaseReady: (releasedKey) => released.push(releasedKey),
  };
  const syncFrames: number[][] = [];
  let disposed = 0;
  const createDriver = () => {
    const frames: number[] = [];
    syncFrames.push(frames);
    return {
      sync(state: StagedAudioFrameState) { frames.push(state.frame); },
      dispose() { disposed++; },
    };
  };
  const coordinator = createStagedDesktopAudioCoordinator(
    { song: key },
    staged,
    createDriver(),
    createDriver,
    "map-a",
  );

  coordinator.sync(audioState(1, "map-a", "song", "first"), true);
  coordinator.sync(audioState(2, "map-b", undefined, "busy"), false);
  expect(syncFrames).toHaveLength(1);
  coordinator.sync(audioState(3, "map-b", undefined, "cooldown"), true);
  expect(syncFrames).toHaveLength(1);
  coordinator.sync(audioState(4, "map-b", undefined, "reset"), true);

  expect(released).toEqual([key]);
  expect(syncFrames).toEqual([[1, 2, 3], [4]]);
  expect(disposed).toBe(1);
});

test("handoff of a repeated reducer state does not replay its one-frame cue", () => {
  const key = "audio:qoa.music/a.qoa";
  let pending = true;
  const staged: StagedDesktopAudioReader = {
    read: () => new Uint8Array([1]),
    hasPending: () => pending,
    pump: () => {
      pending = false;
      return { kind: "ready", key };
    },
    releaseReady() {},
  };
  const synced: string[][] = [];
  const createDriver = () => ({
    sync(state: StagedAudioFrameState) {
      synced.push(state.interp.cues.map((cue) => "stop" in cue ? "stop" : cue.name));
    },
    dispose() {},
  });
  const coordinator = createStagedDesktopAudioCoordinator(
    { song: key, click: "audio:wav.click" },
    staged,
    createDriver(),
    createDriver,
    "map-a",
  );
  const state = audioState(1, "map-a", "song", "click-once");

  coordinator.sync(state, true);
  coordinator.sync(state, true);

  expect(synced).toEqual([["click-once"], []]);
});

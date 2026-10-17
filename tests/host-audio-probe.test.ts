import { afterEach, expect, test } from "bun:test";
import {
  AUDIO_PROBE_GLOBAL,
  BATTLE_TRACK,
  hostAudioProbeSource,
  validateBattleAudioReport,
  VICTORY_TRACK,
} from "../tools/host-audio-probe.ts";

const saved = {
  audio: Object.getOwnPropertyDescriptor(globalThis, "audio"),
  frame: Object.getOwnPropertyDescriptor(globalThis, "frame"),
  state: Object.getOwnPropertyDescriptor(globalThis, "__rpgSessionState"),
  probe: Object.getOwnPropertyDescriptor(globalThis, AUDIO_PROBE_GLOBAL),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    const key = name === "state" ? "__rpgSessionState"
      : name === "probe" ? AUDIO_PROBE_GLOBAL
        : name;
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("native probe requires non-zero accepted and device-clocked battle/victory PCM", () => {
  let nextHandle = 7;
  const events: string[] = [];
  const host = {
    createStream: (_rate: number, _channels: number) => nextHandle++,
    destroyStream: (_handle: number) => undefined,
    setVolume: (_handle: number, _volume: number) => undefined,
    pause: (_handle: number) => undefined,
    stop: (_handle: number) => undefined,
    endStream: (_handle: number) => undefined,
    play: (_handle: number) => undefined,
    writePcm: (_handle: number, pcm: ArrayBuffer) => new Int16Array(pcm).length,
    poll: () => events.shift(),
  };
  const state = { interp: { audio: { bgm: { id: "music_map" } } }, scene: null as null | { kind: string } };
  Object.assign(globalThis, { audio: host, __rpgSessionState: state, frame: () => undefined });
  Function(hostAudioProbeSource())();
  const audio = (globalThis as unknown as { audio: typeof host }).audio;
  const probe = (globalThis as Record<string, any>)[AUDIO_PROBE_GLOBAL];

  const exercise = (id: string, handle: number) => {
    state.interp.audio.bgm.id = id;
    state.scene = id === "music_map" ? null : { kind: "battle" };
    probe.observe();
    audio.play(handle);
    expect(audio.writePcm(handle, new Int16Array([0, 1200, -2400, 0]).buffer)).toBe(4);
    events.push(JSON.stringify({ t: "credit", h: handle, free: 16384 }));
    expect(audio.poll()).toContain("credit");
  };

  const battleHandle = audio.createStream(22050, 1);
  exercise(BATTLE_TRACK, battleHandle);
  const victoryHandle = audio.createStream(22050, 1);
  exercise(VICTORY_TRACK, victoryHandle);
  state.interp.audio.bgm.id = "music_map";
  state.scene = null;
  probe.observe();

  const report = probe.report();
  expect(validateBattleAudioReport(report)).toEqual([]);
  expect(report.phases[BATTLE_TRACK]).toMatchObject({
    writes: 1,
    acceptedFrames: 4,
    nonZeroSamples: 2,
    peak: 2400,
    creditEvents: 1,
    creditedFrames: 4,
    underruns: 0,
  });
});

test("native probe attributes a play made during frame to the newly selected track", () => {
  const host = {
    createStream: () => 7,
    play: (_handle: number) => undefined,
    writePcm: (_handle: number, pcm: ArrayBuffer) => new Int16Array(pcm).length,
    poll: () => undefined,
  };
  const state = {
    interp: { audio: { bgm: { id: "music_map" } } },
    scene: null as null | { kind: string },
  };
  let nextTrack = BATTLE_TRACK;
  Object.assign(globalThis, {
    audio: host,
    __rpgSessionState: state,
    frame: () => {
      state.interp.audio.bgm.id = nextTrack;
      state.scene = { kind: "battle" };
      (globalThis as unknown as { audio: typeof host }).audio.play(7);
    },
  });
  Function(hostAudioProbeSource())();

  (globalThis as unknown as { frame: () => void }).frame();
  nextTrack = VICTORY_TRACK;
  (globalThis as unknown as { frame: () => void }).frame();

  const probe = (globalThis as Record<string, any>)[AUDIO_PROBE_GLOBAL];
  expect(probe.report()).toMatchObject({
    sequence: ["music_map", BATTLE_TRACK, VICTORY_TRACK],
    phases: {
      [BATTLE_TRACK]: { plays: 1 },
      [VICTORY_TRACK]: { plays: 1 },
    },
  });
});

test("validator rejects underrun, silent victory, and missing map restoration mutations", () => {
  const phase = {
    writes: 1,
    acceptedFrames: 4,
    nonZeroSamples: 2,
    peak: 2400,
    plays: 1,
    creditEvents: 1,
    creditedFrames: 4,
    underruns: 0,
  };
  const report = {
    native: true,
    sequence: ["music_map", BATTLE_TRACK, VICTORY_TRACK, "music_map"],
    mapBeforeBattle: "music_map",
    restored: null,
    finalScene: null,
    creditEvents: 1,
    creditedFrames: 4,
    underruns: 1,
    phases: {
      [BATTLE_TRACK]: phase,
      [VICTORY_TRACK]: { ...phase, nonZeroSamples: 0, peak: 0 },
    },
  };
  const errors = validateBattleAudioReport(report);
  expect(errors.some((error) => error.includes("not restored"))).toBeTrue();
  expect(errors.some((error) => error.includes("underrun"))).toBeTrue();
  expect(errors.some((error) => error.includes(`${VICTORY_TRACK} nonZeroSamples`))).toBeTrue();
});

test("validator accepts asynchronous device credit after a short result phase", () => {
  const pcmPhase = {
    writes: 1,
    acceptedFrames: 16_384,
    nonZeroSamples: 16_000,
    peak: 12_000,
    plays: 1,
    creditEvents: 0,
    creditedFrames: 0,
    underruns: 0,
  };
  const report = {
    native: true,
    sequence: ["music_map", BATTLE_TRACK, VICTORY_TRACK, "music_map"],
    mapBeforeBattle: "music_map",
    restored: "music_map",
    finalScene: null,
    writes: 3,
    acceptedFrames: 49_152,
    nonZeroSamples: 48_000,
    peak: 12_000,
    plays: 3,
    creditEvents: 1,
    creditedFrames: 512,
    underruns: 0,
    phases: {
      [BATTLE_TRACK]: pcmPhase,
      [VICTORY_TRACK]: pcmPhase,
      music_map: { ...pcmPhase, creditEvents: 1, creditedFrames: 512 },
    },
  };
  expect(validateBattleAudioReport(report)).toEqual([]);
  expect(validateBattleAudioReport({ ...report, creditEvents: 0, creditedFrames: 0 }))
    .toEqual(expect.arrayContaining([
      expect.stringContaining("creditEvents"),
      expect.stringContaining("creditedFrames"),
    ]));

  const unthrottled = {
    ...report,
    underruns: 3,
    phases: {
      ...report.phases,
      [BATTLE_TRACK]: { ...pcmPhase, underruns: 2 },
      [VICTORY_TRACK]: { ...pcmPhase, underruns: 1 },
    },
  };
  expect(validateBattleAudioReport(unthrottled).some((error) => error.includes("underrun"))).toBeTrue();
  expect(validateBattleAudioReport(unthrottled, { allowUnthrottledUnderruns: true })).toEqual([]);
});

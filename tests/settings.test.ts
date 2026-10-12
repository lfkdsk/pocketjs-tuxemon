import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AUDIO_RING_FRAMES, type AudioOps } from "@pocketjs/framework/audio";
import { BTN } from "@pocketjs/framework/input";
import { createSimFsHost } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/fs.ts";
import { AudioDriver, type AudioDriverState } from "../vendor/pocket-rpgkit/src/ui/audio/index.ts";
import measurementExpectationsJson from "./fixtures/monster-measurements.json";
import type { PspSaveHost } from "../ui/save-psp.ts";
import {
  CONTROL_ACTIONS,
  DEFAULT_SETTINGS,
  SETTINGS_FS_ENTRY,
  SETTINGS_PSP_ENTRY,
  SETTINGS_STORAGE_KEY,
  applyAudioSettings,
  bindControl,
  createAudioSettingsAdapter,
  createButtonRemapper,
  createSettingsController,
  decodeSettings,
  defaultSettings,
  detectSettingsStore,
  encodeSettings,
  formatMonsterHeight,
  formatMonsterWeight,
  formatWalkedDistance,
  installButtonRemapFrame,
  loadSettings,
  persistSettings,
  pressedPhysicalButton,
  remapButtons,
  roundHalfEven,
  type GameSettings,
  type SettingsStore,
} from "../ui/settings.ts";

type MeasurementExpectation = readonly [
  height: number,
  weight: number,
  metricHeight: number,
  imperialHeight: number,
  metricWeight: number,
  imperialWeight: number,
];

const MEASUREMENT_EXPECTATIONS = measurementExpectationsJson as Record<string, MeasurementExpectation>;

interface MemoryStorage {
  readonly values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function memoryPsp(): PspSaveHost & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (path) => files.get(path) ?? null,
    write(path, data) { files.set(path, data); },
    remove(path) { files.delete(path); },
  };
}

const globals = globalThis as { fs?: unknown; localStorage?: unknown; __pspSave?: unknown };
const globalKeys = ["fs", "localStorage", "__pspSave"] as const;
let savedGlobals: (PropertyDescriptor | undefined)[] = [];

beforeEach(() => {
  savedGlobals = globalKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of globalKeys) delete globals[key];
});

afterEach(() => {
  globalKeys.forEach((key, index) => {
    delete globals[key];
    const descriptor = savedGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  });
});

describe("settings document", () => {
  test("stable round-trip preserves all preferences and upstream defaults", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      musicMuted: false,
      musicVolume: 50,
      soundVolume: 20,
      units: "metric",
      hemisphere: "northern",
      screenScale: "auto",
    });
    const changed: GameSettings = {
      ...defaultSettings(),
      musicMuted: true,
      musicVolume: 80,
      soundVolume: 40,
      units: "imperial",
      hemisphere: "southern",
      controls: {
        up: "left",
        left: "up",
        right: "right",
        down: "down",
        primary: "back",
        secondary: "secondary",
        back: "primary",
      },
    };
    const encoded = encodeSettings(changed);
    expect(encodeSettings(decodeSettings(encoded)!)).toBe(encoded);
    expect(decodeSettings(encoded)).toEqual(changed);
  });

  test("bad JSON, partial shape, invalid values and duplicate controls reject as a whole", () => {
    const valid = JSON.parse(encodeSettings(defaultSettings())) as Record<string, any>;
    const mutations = [
      "{",
      JSON.stringify({}),
      JSON.stringify({ ...valid, version: 999 }),
      JSON.stringify({ ...valid, musicMuted: "yes" }),
      JSON.stringify({ ...valid, musicVolume: 101 }),
      JSON.stringify({ ...valid, units: "meters" }),
      JSON.stringify({ ...valid, hemisphere: "east" }),
      JSON.stringify({ ...valid, screenScale: 2 }),
      JSON.stringify({ ...valid, controls: { ...valid.controls, back: valid.controls.primary } }),
    ];
    for (const text of mutations) expect(decodeSettings(text), text).toBeNull();
  });

  test("missing, corrupt and throwing stores all fall back without throwing", () => {
    const stores: SettingsStore[] = [
      { channel: "browser", read: () => null, write() {} },
      { channel: "desktop", read: () => "not json", write() {} },
      { channel: "psp", read: () => { throw new Error("damaged memory stick"); }, write() {} },
    ];
    for (const store of stores) expect(() => loadSettings(store)).not.toThrow();
    for (const store of stores) expect(loadSettings(store)).toEqual(defaultSettings());
    expect(persistSettings(defaultSettings(), {
      channel: "desktop",
      read: () => null,
      write: () => { throw new Error("read only"); },
    })).toBe(false);
  });
});

describe("settings host stores", () => {
  test("web uses the app-scoped localStorage key", () => {
    const storage = memoryStorage();
    globals.localStorage = storage;
    const store = detectSettingsStore()!;
    expect(store.channel).toBe("browser");
    const changed = { ...defaultSettings(), musicVolume: 70 };
    expect(persistSettings(changed, store)).toBe(true);
    expect(storage.values.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadSettings(store)).toEqual(changed);
  });

  test("desktop data.fs wins and writes a standalone config file", () => {
    globals.localStorage = memoryStorage();
    const host = createSimFsHost();
    globals.fs = host.ns;
    const store = detectSettingsStore()!;
    expect(store.channel).toBe("desktop");
    expect(persistSettings({ ...defaultSettings(), soundVolume: 90 }, store)).toBe(true);
    expect(host.log.some((line) => line.startsWith(`op write ${SETTINGS_FS_ENTRY} `))).toBe(true);
    expect(loadSettings(store).soundVolume).toBe(90);
    host.dispose();
  });

  test("PSP uses its memory-stick settings path and tolerates damaged contents", () => {
    const host = memoryPsp();
    globals.__pspSave = host;
    const store = detectSettingsStore()!;
    expect(store.channel).toBe("psp");
    expect(persistSettings({ ...defaultSettings(), units: "imperial" }, store)).toBe(true);
    expect(host.files.has(SETTINGS_PSP_ENTRY)).toBe(true);
    expect(loadSettings(store).units).toBe("imperial");
    host.files.set(SETTINGS_PSP_ENTRY, "{truncated");
    expect(loadSettings(store)).toEqual(defaultSettings());
  });

  test("an exposed but unwritable browser store is not selected", () => {
    globals.localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => undefined,
    };
    expect(detectSettingsStore()).toBeNull();
  });
});

describe("control remapping", () => {
  test("default mapping is identity and non-remappable buttons pass through", () => {
    const mask = BTN.UP | BTN.CIRCLE | BTN.START | BTN.SQUARE | BTN.LTRIGGER;
    expect(remapButtons(mask, defaultSettings().controls)).toBe(mask);
    for (const action of CONTROL_ACTIONS) {
      expect(defaultSettings().controls[action]).toBe(action);
    }
  });

  test("a persisted permutation changes keyboard/controller-normalized BTN semantics", () => {
    const settings = defaultSettings();
    const swapPrimary = bindControl(settings, "primary", "back");
    expect(swapPrimary.conflict).toBe("back");
    // Resolve by an explicit permutation, as the UI's two assignments do.
    const controls = { ...settings.controls, primary: "back", back: "primary" } as const;
    expect(remapButtons(BTN.CROSS, controls)).toBe(BTN.CIRCLE);
    expect(remapButtons(BTN.CIRCLE, controls)).toBe(BTN.CROSS);
    expect(remapButtons(BTN.START | BTN.CROSS, controls)).toBe(BTN.START | BTN.CIRCLE);
  });

  test("duplicate assignment reports the conflicting action without changing bindings", () => {
    const current = defaultSettings();
    const result = bindControl(current, "primary", "back");
    expect(result.conflict).toBe("back");
    expect(result.settings.controls).toEqual(current.controls);
    expect(pressedPhysicalButton(BTN.UP)).toBe("up");
    expect(pressedPhysicalButton(BTN.UP | BTN.LEFT)).toBeNull();
  });

  test("mapping revisions suppress a held binding key until full release", () => {
    const store: SettingsStore = { channel: "browser", read: () => null, write() {} };
    const controller = createSettingsController(store);
    const remapper = createButtonRemapper(controller);
    expect(remapper.map(BTN.CIRCLE)).toBe(BTN.CIRCLE);
    expect(remapper.physicalPressed()).toBe(BTN.CIRCLE);
    controller.replace({
      ...controller.get(),
      controls: { ...controller.get().controls, primary: "back", back: "primary" },
    });
    expect(remapper.map(BTN.CIRCLE)).toBe(0);
    expect(remapper.map(0)).toBe(0);
    expect(remapper.map(BTN.CIRCLE)).toBe(BTN.CROSS);
  });

  test("default bindings stay on the cached identity path until a revision", () => {
    let current = defaultSettings();
    let revision = 0;
    let reads = 0;
    const remapper = createButtonRemapper({
      revision: () => revision,
      get: () => {
        reads++;
        return current;
      },
    });

    expect(reads).toBe(1);
    expect(remapper.map(BTN.UP | BTN.START)).toBe(BTN.UP | BTN.START);
    expect(remapper.map(BTN.CIRCLE)).toBe(BTN.CIRCLE);
    expect(remapper.map(0)).toBe(0);
    expect(reads).toBe(1);

    current = {
      ...current,
      controls: { ...current.controls, primary: "back", back: "primary" },
    };
    revision++;
    expect(remapper.map(BTN.CROSS)).toBe(0);
    expect(remapper.map(0)).toBe(0);
    expect(remapper.map(BTN.CROSS)).toBe(BTN.CIRCLE);
    expect(reads).toBe(2);
  });

  test("the mounted host frame sees remapped buttons and unchanged auxiliary input", () => {
    const controller = createSettingsController({ channel: "browser", read: () => null, write() {} });
    controller.replace({
      ...controller.get(),
      controls: { ...controller.get().controls, primary: "back", back: "primary" },
    });
    const calls: unknown[][] = [];
    const globalsWithFrame = globalThis as typeof globalThis & { frame?: (...args: any[]) => void };
    const previous = globalsWithFrame.frame;
    globalsWithFrame.frame = (...args: unknown[]) => { calls.push(args); };
    try {
      const dispose = installButtonRemapFrame(createButtonRemapper(controller));
      globalsWithFrame.frame!(BTN.CROSS | BTN.START, 123, [1, 2], [3], [4]);
      expect(calls).toEqual([[BTN.CIRCLE | BTN.START, 123, [1, 2], [3], [4]]]);
      const semanticFrame = (globalsWithFrame.frame as typeof globalsWithFrame.frame & {
        __pocketSemanticFrame?: (...args: any[]) => void;
      }).__pocketSemanticFrame;
      expect(semanticFrame).toBeFunction();
      semanticFrame!(BTN.CROSS | BTN.START, 456, [5], [6], [7]);
      expect(calls.at(-1)).toEqual([BTN.CROSS | BTN.START, 456, [5], [6], [7]]);
      dispose();
      globalsWithFrame.frame!(BTN.CROSS);
      expect(calls.at(-1)).toEqual([BTN.CROSS]);
    } finally {
      if (previous) globalsWithFrame.frame = previous;
      else delete globalsWithFrame.frame;
    }
  });
});

describe("measurement preferences", () => {
  function adjacentPositiveFloat(value: number, direction: -1 | 1): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    let high = view.getUint32(0, false);
    let low = view.getUint32(4, false);
    if (direction > 0) {
      low = (low + 1) >>> 0;
      if (low === 0) high++;
    } else {
      if (low === 0) high--;
      low = (low - 1) >>> 0;
    }
    view.setUint32(0, high, false);
    view.setUint32(4, low, false);
    return view.getFloat64(0, false);
  }

  test("rounds the exact binary value below, at and above decimal ties", () => {
    const cases: Array<readonly [number, number]> = [
      [adjacentPositiveFloat(1.25, -1), 1.2],
      [1.25, 1.2],
      [adjacentPositiveFloat(1.25, 1), 1.3],
      [adjacentPositiveFloat(1.75, -1), 1.7],
      [1.75, 1.8],
      [adjacentPositiveFloat(1.75, 1), 1.8],
      [1.15, 1.1],
      [1.85, 1.9],
      [2.45, 2.5],
    ];
    for (const [value, expected] of cases) expect(roundHalfEven(value, 1), value.toPrecision(17)).toBe(expected);
    expect(roundHalfEven(0.49999999999999994)).toBe(0);
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(0.5000000000000001)).toBe(1);
    expect(Object.is(roundHalfEven(-0.1), -0)).toBeTrue();
  });

  test("metric and imperial monster measurements match upstream thresholds", () => {
    expect(formatMonsterHeight(42, "metric")).toBe("42 cm");
    expect(formatMonsterHeight(100, "metric")).toBe("1.0 m");
    expect(formatMonsterHeight(125, "metric")).toBe("1.2 m");
    expect(formatMonsterHeight(225, "metric")).toBe("2.2 m");
    expect(formatMonsterHeight(175, "metric")).toBe("1.8 m");
    expect(formatMonsterHeight(175, "imperial")).toBe("6 ft");
    expect(formatMonsterWeight(18.4, "metric")).toBe("18 kg");
    expect(formatMonsterWeight(1_000, "metric")).toBe("1.0 t");
    expect(formatMonsterWeight(1_250, "metric")).toBe("1.2 t");
    expect(formatMonsterWeight(18.4, "imperial")).toBe("41 lb");
    expect(formatWalkedDistance(0, "metric")).toBe("0 km");
    expect(formatWalkedDistance(1_234, "metric")).toBe("1.23 km");
    expect(formatWalkedDistance(1_234, "imperial")).toBe("0.76 mi");
  });

  test("all 411 upstream monsters match the offline Python measurement oracle", () => {
    const entries = Object.entries(MEASUREMENT_EXPECTATIONS);
    expect(entries).toHaveLength(411);
    for (const [slug, row] of entries) {
      expect(row, `${slug}: numeric oracle columns`).toHaveLength(6);
      expect(row.every(Number.isFinite), `${slug}: finite numeric oracle columns`).toBeTrue();
      const [height, weight, metricHeight, imperialHeight, metricWeight, imperialWeight] = row;
      const metricHeightText = height >= 100 ? `${metricHeight.toFixed(1)} m` : `${metricHeight} cm`;
      const metricWeightText = weight >= 1_000 ? `${metricWeight.toFixed(1)} t` : `${metricWeight} kg`;
      expect(formatMonsterHeight(height, "metric"), `${slug}: metric height`).toBe(metricHeightText);
      expect(formatMonsterHeight(height, "imperial"), `${slug}: imperial height`).toBe(`${imperialHeight} ft`);
      expect(formatMonsterWeight(weight, "metric"), `${slug}: metric weight`).toBe(metricWeightText);
      expect(formatMonsterWeight(weight, "imperial"), `${slug}: imperial weight`).toBe(`${imperialWeight} lb`);
    }
  });
});

function wav(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 11_025, true);
  view.setUint32(28, 22_050, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

class VolumeAudioOps implements AudioOps {
  nextHandle = 1;
  readonly volumes: number[] = [];
  readonly created: number[] = [];
  readonly destroyed: number[] = [];
  readonly plays: number[] = [];
  readonly writes: Array<{ handle: number; samples: number[] }> = [];
  readonly events: string[] = [];
  createStream(): number {
    const handle = this.nextHandle++;
    this.created.push(handle);
    return handle;
  }
  destroyStream(handle: number): void { this.destroyed.push(handle); }
  writePcm(handle: number, pcm: ArrayBuffer): number {
    const samples = Array.from(new Int16Array(pcm));
    this.writes.push({ handle, samples });
    return samples.length;
  }
  play(handle: number): void { this.plays.push(handle); }
  pause(): void {}
  stop(): void {}
  setVolume(_handle: number, volume: number): void { this.volumes.push(volume); }
  endStream(): void {}
  poll(): string | undefined { return this.events.shift(); }
}

function audioFrame(frame: number): AudioDriverState {
  return {
    frame,
    interp: {
      audio: { bgm: { id: "song", volume: 80, pitch: 100, positionTicks: 0 } },
      cues: [{ name: "click", volume: 50, pitch: 100 }],
    },
  };
}

describe("audio preferences", () => {
  test("music mute/volume and sound volume scale separate presentation intents", () => {
    const source = audioFrame(1);
    const adjusted = applyAudioSettings(source, {
      musicMuted: false,
      musicVolume: 50,
      soundVolume: 20,
    });
    expect(adjusted.interp.audio?.bgm?.volume).toBe(40);
    expect(adjusted.interp.cues[0]).toMatchObject({ volume: 10 });
    expect(source.interp.audio?.bgm?.volume).toBe(80);
    expect(source.interp.cues[0]).toMatchObject({ volume: 50 });
    expect(applyAudioSettings(source, {
      musicMuted: true,
      musicVolume: 100,
      soundVolume: 100,
    }).interp.audio?.bgm?.volume).toBe(0);
  });

  test("the host receives the scaled music and effect volumes", () => {
    const source = audioFrame(1);
    const adjusted = applyAudioSettings(source, {
      musicMuted: false,
      musicVolume: 50,
      soundVolume: 20,
    });
    const ops = new VolumeAudioOps();
    const driver = new AudioDriver(
      ops,
      { song: "audio:wav.song", click: "audio:wav.click" },
      () => wav([1, 2, 3, 4]),
    );
    driver.sync(adjusted);
    expect(ops.volumes).toEqual([0.4, 0.1]);
  });

  test("adapter preserves repeated-frame identity and invalidates on a preference revision", () => {
    const controller = createSettingsController({ channel: "browser", read: () => null, write() {} });
    const adapter = createAudioSettingsAdapter(controller);
    const source = audioFrame(3);
    const first = adapter.apply(source);
    expect(adapter.apply(source)).toBe(first);
    controller.update((current) => ({ ...current, units: "imperial" }));
    expect(adapter.apply(source)).toBe(first);
    controller.update((current) => ({ ...current, musicVolume: 90 }));
    const changed = adapter.apply(source);
    expect(changed).not.toBe(first);
    expect(changed.interp.audio?.bgm?.volume).toBe(72);
  });

  test("a frozen-frame volume change keeps the real driver stream and PCM cursor", () => {
    const controller = createSettingsController({ channel: "browser", read: () => null, write() {} });
    const adapter = createAudioSettingsAdapter(controller);
    const timeline = {
      ...audioFrame(3),
      interp: { ...audioFrame(3).interp, cues: [] },
    };
    const samples = Array.from({ length: AUDIO_RING_FRAMES + 64 }, (_, index) => index + 1);
    const ops = new VolumeAudioOps();
    const driver = new AudioDriver(ops, { song: "audio:wav.song" }, () => wav(samples));

    driver.sync(adapter.apply(timeline), timeline);
    expect(ops.created).toEqual([1]);
    expect(ops.plays).toEqual([1]);
    expect(ops.writes[0]?.samples).toEqual(samples.slice(0, AUDIO_RING_FRAMES));

    ops.events.push(JSON.stringify({ t: "credit", h: 1, free: 32 }));
    const createdBefore = ops.created.length;
    const playedBefore = ops.plays.length;
    controller.update((current) => ({ ...current, musicVolume: 90 }));
    driver.sync(adapter.apply(timeline), timeline);

    expect(ops.created.length - createdBefore).toBe(0);
    expect(ops.destroyed).toEqual([]);
    expect(ops.plays.length - playedBefore).toBe(0);
    expect(ops.volumes.at(-1)).toBe(0.72);
    expect(ops.writes[1]).toEqual({
      handle: 1,
      samples: samples.slice(AUDIO_RING_FRAMES, AUDIO_RING_FRAMES + 32),
    });
  });
});

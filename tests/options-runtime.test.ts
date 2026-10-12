import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import featureModesJson from "../data/feature-modes-shell.json";
import type { FeatureModesShellData } from "../ui/feature-modes-data.ts";
import { createOptionsRuntime, type OptionsCapabilities } from "../ui/options-runtime.ts";
import {
  createSettingsController,
  decodeSettings,
  defaultSettings,
  type SettingsStore,
} from "../ui/settings.ts";

const data = (featureModesJson as unknown as FeatureModesShellData).options;
const FULL: OptionsCapabilities = { remap: true, language: true, screenSize: "host" };

function harness(capabilities: OptionsCapabilities = FULL, lang: "en_US" | "zh_CN" = "en_US") {
  let persisted: string | null = null;
  let physicalPressed = 0;
  const languageOrigins: string[] = [];
  const closeOrigins: string[] = [];
  const store: SettingsStore = {
    channel: "browser",
    read: () => persisted,
    write: (text) => { persisted = text; },
  };
  const settings = createSettingsController(store);
  const runtime = createOptionsRuntime({
    data,
    lang,
    settings,
    input: { physicalPressed: () => physicalPressed },
    capabilities,
    onLanguage: (origin) => languageOrigins.push(origin),
    onClose: (origin) => closeOrigins.push(origin),
  });
  return {
    runtime,
    settings,
    languageOrigins,
    closeOrigins,
    persisted: () => persisted,
    press(mask: number, physical = mask) {
      physicalPressed = physical;
      runtime.step(mask, mask);
      physicalPressed = 0;
      runtime.step(0, 0);
    },
  };
}

describe("Options runtime rows", () => {
  test("title mirrors upstream controls/general subset; START adds gameplay preferences", () => {
    const h = harness();
    h.runtime.open("title");
    expect(h.runtime.rows().map((row) => row.id)).toEqual([
      "control:up", "control:left", "control:right", "control:down",
      "control:primary", "control:secondary", "control:back", "reset",
      "language", "screen",
    ]);
    expect(h.runtime.rows().find((row) => row.id === "screen")).toMatchObject({
      value: "480×272",
      enabled: false,
    });
    h.runtime.open("start");
    expect(h.runtime.rows().map((row) => row.id).slice(-5)).toEqual([
      "mute", "music", "sound", "units", "hemisphere",
    ]);
    expect(h.runtime.rows().find((row) => row.id === "music")?.value).toBe("50%");
    expect(h.runtime.rows().find((row) => row.id === "sound")?.value).toBe("20%");
  });

  test("touch-only hides remapping, PSP hides screen size, and Chinese comes from generated PO data", () => {
    const h = harness({ remap: false, language: false, screenSize: "hidden" }, "zh_CN");
    h.runtime.open("start");
    expect(h.runtime.rows().map((row) => row.id)).toEqual([
      "mute", "music", "sound", "units", "hemisphere",
    ]);
    expect(h.runtime.rows().map((row) => row.label)).toEqual([
      "音乐静音", "音乐音量", "音效音量", "单位", "半球",
    ]);
    expect(h.runtime.rows().find((row) => row.id === "units")?.value).toBe("公制");
  });
});

describe("Options runtime behavior", () => {
  test("sliders, mute, units and hemisphere apply immediately and persist outside saves", () => {
    const h = harness();
    h.runtime.open("start");
    const index = (id: string) => h.runtime.rows().findIndex((row) => row.id === id);
    h.runtime.adjustIndex(index("music"), 1);
    h.runtime.adjustIndex(index("sound"), -1);
    h.runtime.activateIndex(index("mute"));
    h.runtime.activateIndex(index("units"));
    h.runtime.activateIndex(index("hemisphere"));
    expect(h.settings.get()).toMatchObject({
      musicMuted: true,
      musicVolume: 60,
      soundVolume: 10,
      units: "imperial",
      hemisphere: "southern",
    });
    expect(decodeSettings(h.persisted()!)).toEqual(h.settings.get());
    expect(h.runtime.persistFailed()).toBe(false);
  });

  test("touch volume cycles normalize hand-edited values and legends follow remapped slots", () => {
    const h = harness();
    h.settings.replace({
      ...h.settings.get(),
      musicVolume: 95,
      soundVolume: 95,
      controls: { ...h.settings.get().controls, primary: "back", back: "primary" },
    });
    h.runtime.open("start");
    const index = (id: string) => h.runtime.rows().findIndex((row) => row.id === id);
    expect(h.runtime.controlGlyph("primary")).toBe("×");
    expect(h.runtime.controlGlyph("back")).toBe("○");
    h.runtime.activateIndex(index("music"));
    h.runtime.activateIndex(index("sound"));
    expect(h.settings.get()).toMatchObject({ musicVolume: 100, soundVolume: 100 });
    expect(h.runtime.persistFailed()).toBe(false);
    h.runtime.activateIndex(index("music"));
    expect(h.settings.get().musicVolume).toBe(0);
  });

  test("binding capture detects a conflict, confirms an explicit swap, and reset restores defaults", () => {
    const h = harness();
    h.runtime.open("title");
    h.runtime.activateIndex(h.runtime.rows().findIndex((row) => row.id === "control:primary"));
    expect(h.runtime.capture()).toBe("primary");
    h.press(BTN.CROSS);
    expect(h.runtime.conflict()).toEqual({ action: "primary", button: "back", occupiedBy: "back" });
    h.press(BTN.CIRCLE);
    expect(h.settings.get().controls.primary).toBe("back");
    expect(h.settings.get().controls.back).toBe("primary");
    h.runtime.activateIndex(h.runtime.rows().findIndex((row) => row.id === "reset"));
    expect(h.settings.get().controls).toEqual(defaultSettings().controls);
  });

  test("START cancels capture; language stays in Options; close reports its parent", () => {
    const h = harness();
    h.runtime.open("title");
    h.runtime.activateIndex(0);
    h.press(BTN.START, 0);
    expect(h.runtime.capture()).toBeNull();
    h.runtime.activateIndex(h.runtime.rows().findIndex((row) => row.id === "language"));
    expect(h.languageOrigins).toEqual(["title"]);
    expect(h.runtime.isOpen()).toBe(true);
    h.press(BTN.CROSS);
    expect(h.runtime.isOpen()).toBe(false);
    expect(h.closeOrigins).toEqual(["title"]);
  });

  test("a failed preference write changes live state but raises a non-throwing notice", () => {
    const settings = createSettingsController({
      channel: "desktop",
      read: () => null,
      write: () => { throw new Error("read-only config"); },
    });
    const runtime = createOptionsRuntime({
      data,
      lang: "en_US",
      settings,
      input: { physicalPressed: () => 0 },
      capabilities: FULL,
    });
    runtime.open("start");
    const units = runtime.rows().findIndex((row) => row.id === "units");
    expect(() => runtime.activateIndex(units)).not.toThrow();
    expect(settings.get().units).toBe("imperial");
    expect(runtime.persistFailed()).toBe(true);
  });
});

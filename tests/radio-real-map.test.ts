import { describe, expect, test } from "bun:test";

import { createTuxemonExtensions } from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB, TUXEMON_SESSION_OPTIONS } from "../battle/game.ts";
import {
  TUXEMON_RADIO_SCENE_ID,
  type RadioSceneState,
} from "../battle/radio-scenes.ts";
import { timeWeatherAt } from "../battle/time-weather.ts";
import {
  buildProject,
  G6_IMPORT_OPTIONS,
  setImportLang,
} from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

function objectNodes(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) objectNodes(entry, output);
  } else if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    output.push(row);
    for (const entry of Object.values(row)) objectNodes(entry, output);
  }
  return output;
}

class Driver {
  private previous = 0;
  readonly session: Session;
  state: SessionState;

  constructor(project: Project, stage = "morning", lang: "en_US" | "zh_CN" = "en_US") {
    const hour = ({ dawn: 6, morning: 9, afternoon: 13, dusk: 18, night: 22 } as const)[
      stage as "dawn" | "morning" | "afternoon" | "dusk" | "night"
    ];
    if (hour === undefined) throw new Error(`unsupported radio test stage ${stage}`);
    const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB, {
      initialTimeWeather: timeWeatherAt({ year: 2024, month: 6, day: 15, hour, minute: 0 }),
      lang,
    });
    this.session = createSession(project, 60, { ...TUXEMON_SESSION_OPTIONS, extensions });
    this.state = startSession(project, this.session);
  }

  private input(mask: number): SessionInput {
    const edge = (bit: number) => Boolean((mask & bit) && !(this.previous & bit));
    const input: SessionInput = {
      buttons: mask,
      confirmEdge: edge(BTN_CONFIRM),
      cancelEdge: edge(BTN_CANCEL),
      upEdge: edge(BTN_BITS.UP),
      downEdge: edge(BTN_BITS.DOWN),
      leftEdge: edge(BTN_BITS.LEFT),
      rightEdge: edge(BTN_BITS.RIGHT),
    };
    this.previous = mask;
    return input;
  }

  tick(mask = 0): void {
    this.state = stepSession(this.session, this.state, this.input(mask));
  }

  press(mask: number): void {
    this.tick(mask);
    this.tick(0);
  }

  idle(frames: number): void {
    for (let frame = 0; frame < frames; frame++) this.tick();
  }

  until(predicate: () => boolean, mask: number, limit = 60): void {
    for (let frame = 0; frame < limit && !predicate(); frame++) this.press(mask);
    expect(predicate()).toBeTrue();
  }

  radio(): RadioSceneState {
    const scene = this.state.scene;
    if (scene?.kind !== "scene") throw new Error("radio scene is not active");
    expect(scene.id).toBe(TUXEMON_RADIO_SCENE_ID);
    return scene.state as unknown as RadioSceneState;
  }
}

interface RadioCase {
  lang: "en_US" | "zh_CN";
  map: string;
  start: Project["start"];
  stage: string;
  expected: string;
}

function importedCase(input: Readonly<RadioCase>): Driver {
  let project: Project;
  setImportLang(input.lang);
  try {
    const build = buildProject([input.map], G6_IMPORT_OPTIONS);
    project = build.project;
    project.start = input.start;
    const radioEvents = project.maps[0]!.events?.filter((event) => event.name === "Radio") ?? [];
    expect(radioEvents).toHaveLength(1);
    expect(objectNodes(radioEvents).some((node) => node.op === "scene" && node.id === TUXEMON_RADIO_SCENE_ID))
      .toBeTrue();
    const entry = project.maps[0]!.events?.find((event) => event.id === "e000_npc_parties");
    expect(objectNodes(entry).some((node) =>
      node.op === "ext" && node.call === "tux.update_time" &&
      (node.args as Record<string, unknown>)?.character === "player")).toBeTrue();
  } finally {
    setImportLang("en_US");
  }

  const driver = new Driver(project!, input.stage, input.lang);
  driver.idle(30);
  expect(driver.state.sw.variables["v.stage_of_day"]).toBe(input.stage);
  const origin = [driver.state.mapId, driver.state.move.tx, driver.state.move.ty];
  driver.until(() => driver.state.scene?.kind === "scene", BTN_CONFIRM);

  const tuner = driver.radio();
  expect(tuner.phase).toBe("tune");
  expect(tuner.frequency).toBe(94.7);
  expect(tuner.frequency.toFixed(1)).toBe("94.7");
  expect(tuner.selectedStationSlug).toBe("station_route_rhythms");
  expect(tuner.signalStrength).toBe(100);
  // Construction must not auto-play even though the authored initial
  // frequency is already a perfect match.
  expect(tuner.broadcastDialogue).toEqual([]);

  driver.press(BTN_CONFIRM);
  expect(driver.radio().phase).toBe("broadcast");
  expect(driver.radio().broadcastStationSlug).toBe("station_route_rhythms");
  expect(driver.radio().broadcastDialogue).toEqual([input.expected]);
  expect(driver.radio().broadcastDialogue[0]).not.toBe("The signal fades into static...");

  // First B closes the overlaid broadcast; second B closes the tuner and
  // resumes the real imported event fiber in the same world position.
  driver.press(BTN_CANCEL);
  expect(driver.radio().phase).toBe("tune");
  driver.press(BTN_CANCEL);
  driver.idle(2);
  expect(driver.state.scene).toBeNull();
  expect([driver.state.mapId, driver.state.move.tx, driver.state.move.ty]).toEqual(origin);
  return driver;
}

describe("real imported Radio events", () => {
  test("select map- and time-specific broadcasts instead of a hardcoded fallback", () => {
    importedCase({
      lang: "en_US",
      map: "spyder_leather_house1",
      start: { map: "spyder_leather_house1", x: 7, y: 7, dir: "up" },
      stage: "morning",
      expected: "An R&B song is playing. It's called \"Possessuns, Part I\".",
    });
    importedCase({
      lang: "en_US",
      map: "spyder_leather_house1",
      start: { map: "spyder_leather_house1", x: 7, y: 7, dir: "up" },
      stage: "afternoon",
      expected: "An R&B song is playing. It's called \"Possessuns, Part II\".",
    });
    importedCase({
      lang: "en_US",
      map: "spyder_paper_rival_bedroom",
      start: { map: "spyder_paper_rival_bedroom", x: 1, y: 5, dir: "left" },
      stage: "morning",
      expected: "Morning: A Pop song is playing. It's called \"Omni Love: A Journey Through Channels of the Heart\".",
    });
  });

  test("the Chinese project imports the authored broadcast translation", () => {
    importedCase({
      lang: "zh_CN",
      map: "spyder_paper_rival_bedroom",
      start: { map: "spyder_paper_rival_bedroom", x: 1, y: 5, dir: "left" },
      stage: "morning",
      expected: "早晨：一首流行歌曲正在播放，歌名是“全频之爱：心之通道的旅程”.",
    });
  });

  test("weak tuning plays static and retuning to 94.7 auto-plays once", () => {
    setImportLang("en_US");
    const build = buildProject(["spyder_leather_house1"], G6_IMPORT_OPTIONS);
    build.project.start = { map: "spyder_leather_house1", x: 7, y: 7, dir: "up" };
    const driver = new Driver(build.project);
    driver.idle(30);
    expect(driver.state.sw.variables["v.stage_of_day"]).toBe("morning");
    driver.until(() => driver.state.scene?.kind === "scene", BTN_CONFIRM);

    driver.press(BTN_BITS.LEFT);
    expect(driver.radio().frequency).toBe(94.6);
    expect(driver.radio().signalStrength).toBeLessThan(80);
    driver.press(BTN_CONFIRM);
    expect(driver.radio().broadcastStationSlug).toBe("station_scrambled_frequency");
    expect(driver.radio().broadcastDialogue).toEqual(["The signal fades into static..."]);
    driver.press(BTN_CANCEL);

    // currentStationSlug is now static, so landing back on the strong signal
    // triggers upstream's one-shot automatic broadcast without pressing Play.
    driver.press(BTN_BITS.RIGHT);
    expect(driver.radio().frequency).toBe(94.7);
    expect(driver.radio().phase).toBe("broadcast");
    expect(driver.radio().broadcastDialogue).toEqual([
      "An R&B song is playing. It's called \"Possessuns, Part I\".",
    ]);
  });
});

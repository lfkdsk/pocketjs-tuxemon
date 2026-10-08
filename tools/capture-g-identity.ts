// Capture the player identity in a real imported battle at both supported
// logical viewports. Each case enters the built game through start_tuxemon,
// selects one of its real appearance rows, follows the authored Spyder
// transfer, then jumps (preserving the live identity) to Paper Town and lets
// its real "First Fight - Start" event open Battle Processing.
//
// Usage: bun tools/capture-g-identity.ts   (after the app bundle exists)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import {
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { bootWorld, fnv1a, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = resolve(ROOT, process.env.G_IDENTITY_BUNDLE ?? "dist/main");
const OUTPUT = resolve(ROOT, process.env.G_IDENTITY_OUTPUT ?? "tests/goldens");
const BTN_CONFIRM = 0x2000;
const BTN_DOWN = 0x0040;

export const G_IDENTITY_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const G_IDENTITY_CAPTURE_RACES = [
  {
    id: "black-female",
    option: "Black female",
    choiceIndex: 3,
    pronounIndex: 1,
    raceCode: 1,
    sprite: "brownheroine_brown",
    combatSheet: "heroineblack",
  },
  {
    id: "whatever",
    option: "Whatever",
    choiceIndex: 5,
    pronounIndex: 2,
    raceCode: 4,
    sprite: "penguin",
    combatSheet: "penguin",
  },
] as const;

export interface GIdentityCaptureFrame {
  id: (typeof G_IDENTITY_CAPTURE_RACES)[number]["id"];
  width: number;
  height: number;
  rgba: Uint8Array;
  hostFrame: number;
  raceCode: number;
  sprite: string;
  combatSheet: string;
  trainerKey: string;
  opponent: string;
  event: string;
  eventTicks: number;
}
export interface GIdentityCaptureManifest {
  format: "pocket-tuxemon/g-identity-battle-goldens/v1";
  source: {
    chooser: "start_tuxemon";
    battleMap: "spyder_paper_town";
    battleEvent: "e024_first_fight_start";
  };
  frames: Array<Omit<GIdentityCaptureFrame, "rgba"> & {
    file: string;
    rgbaFnv1a: string;
    pngSha256: string;
  }>;
}

function live(): SessionState {
  const state = globalThis.__rpgSessionState;
  if (!state) throw new Error("G identity capture: production GameView state is unavailable");
  return state;
}

class Driver {
  hostFrame = -1;

  constructor(readonly world: SimWorld) {}

  step(mask = 0): void {
    this.world.frame(mask, 0x8080);
    for (let tick = 0; tick < this.world.ticksPerFrame; tick++) this.world.tick();
    this.hostFrame++;
  }

  press(mask: number): void {
    this.step(mask);
    this.step(0);
  }

  until(predicate: () => boolean, label: string, limit = 2_000): void {
    for (let frame = 0; frame < limit && !predicate(); frame++) this.step();
    if (!predicate()) throw new Error(`G identity capture: ${label} was not reached`);
  }

  choose(index: number): void {
    const modal = live().interp.modal;
    if (modal?.kind !== "choices") throw new Error("G identity capture: expected choice modal");
    for (let row = modal.index; row !== index; row = (row + 1) % modal.options.length) {
      this.press(BTN_DOWN);
    }
    this.press(BTN_CONFIRM);
  }
}

function starterExtension() {
  const db = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
  const ext = initialTuxemonExtensionState();
  ext.party = [spawnMonster(
    TUXEMON_BATTLE_DB,
    db,
    { rng: 0x1d3f_5a79, rngDraws: 0 },
    "rockitten",
    5,
    { iid: "g-identity-starter" },
  )];
  return packTuxemonExtensionState(ext);
}

async function captureOne(
  viewport: { width: number; height: number },
  race: (typeof G_IDENTITY_CAPTURE_RACES)[number],
): Promise<GIdentityCaptureFrame> {
  const diagnostics: PocketTuxemonWorldDiagnostics = {
    request: { seq: 1, mapId: "start_tuxemon", x: 4, y: 4 },
  };
  const world = await bootWorld(
    BUNDLE,
    60,
    { ...FIXED_TIME_HOST_GLOBALS, __pocketTuxemonWorldDiagnostics: diagnostics },
    undefined,
    viewport,
  );
  const driver = new Driver(world);
  driver.until(
    () => diagnostics.acknowledged === 1 && live().mapId === "start_tuxemon",
    "diagnostic entry to start_tuxemon",
    120,
  );
  driver.until(() => live().interp.modal?.kind === "choices", "scenario choice");
  driver.choose(0); // Spyder
  driver.until(() => live().interp.modal?.kind === "choices", "appearance choice");
  const appearance = live().interp.modal;
  if (appearance?.kind !== "choices" || !appearance.options[race.choiceIndex]?.includes(race.option)) {
    throw new Error(`G identity capture: ${race.option} choice moved`);
  }
  driver.choose(race.choiceIndex);
  driver.until(
    () => live().sw.playerAppearance?.defaultSprite === race.sprite,
    `${race.option} appearance branch`,
  );
  driver.until(() => live().interp.modal?.kind === "choices", "pronoun choice");
  driver.choose(race.pronounIndex);
  driver.until(() => live().mapId === "spyder_bedroom", "Spyder transfer");
  const selected = live();
  if (
    selected.sw.variables["v.race_choice"] !== race.raceCode ||
    selected.sw.playerAppearance?.defaultCombatSheet !== race.combatSheet
  ) {
    throw new Error(`G identity capture: ${race.option} branch did not persist its combat sheet`);
  }

  // Set up only the story prerequisites and party that precede the imported
  // first-fight event; that event still creates Billie, stages her monster,
  // shows its dialogue and opens the real Battle Processing scene.
  selected.sw.variables["v.firstfightdue"] = 2; // yes
  selected.sw.variables["v.billie_choice"] = 3; // budaye
  selected.ext = starterExtension();
  diagnostics.request = { seq: 2, mapId: "spyder_paper_town", x: 25, y: 8 };
  driver.until(
    () => diagnostics.acknowledged === 2 && live().mapId === "spyder_paper_town",
    "diagnostic entry to Paper Town",
    120,
  );
  for (let frame = 0; frame < 2_000 && live().scene?.kind !== "battle"; frame++) {
    const modal = live().interp.modal;
    if (modal?.kind === "text") driver.press(BTN_CONFIRM);
    else driver.step();
  }
  if (live().scene?.kind !== "battle") {
    throw new Error("G identity capture: First Fight did not open Battle Processing");
  }

  let battle: RuntimeBattleState | null = null;
  for (let frame = 0; frame < 240; frame++) {
    const scene = live().scene;
    if (scene?.kind !== "battle") throw new Error("G identity capture: battle closed before trainer pose");
    battle = tuxemonRuntimeBattleState(scene.state);
    const event = battle.battle.events[battle.eventCursor];
    if (event?.type === "sendOut" && event.side === 0 && battle.eventTicks === 16) break;
    driver.step();
    battle = null;
  }
  if (!battle) throw new Error("G identity capture: player send-out tick 16 was not reached");
  const trainer = battle.visuals.trainers.player;
  if (!trainer || !trainer.key.includes(`/player/${race.combatSheet}#`)) {
    throw new Error(`G identity capture: ${race.option} battle used ${trainer?.key ?? "no trainer"}`);
  }
  return {
    id: race.id,
    ...viewport,
    rgba: world.render().slice(),
    hostFrame: driver.hostFrame,
    raceCode: race.raceCode,
    sprite: race.sprite,
    combatSheet: race.combatSheet,
    trainerKey: trainer.key,
    opponent: battle.battle.opponent,
    event: "sendOut",
    eventTicks: battle.eventTicks,
  };
}

export async function captureGIdentityBattles(): Promise<GIdentityCaptureFrame[]> {
  if (!existsSync(`${BUNDLE}.js`) || !existsSync(`${BUNDLE}.pak`)) {
    throw new Error("G identity capture: missing dist/main.{js,pak}; build the app bundle first");
  }
  const frames: GIdentityCaptureFrame[] = [];
  for (const viewport of G_IDENTITY_VIEWPORTS) {
    for (const race of G_IDENTITY_CAPTURE_RACES) frames.push(await captureOne(viewport, race));
  }
  return frames;
}

export function identityGoldenFile(frame: Pick<GIdentityCaptureFrame, "id" | "width" | "height">): string {
  return `g-identity-${frame.id}.${frame.width}x${frame.height}.png`;
}

if (import.meta.main) {
  const captures = await captureGIdentityBattles();
  mkdirSync(OUTPUT, { recursive: true });
  const frames: GIdentityCaptureManifest["frames"] = [];
  for (const capture of captures) {
    const file = identityGoldenFile(capture);
    const png = encodePNG(capture.rgba, capture.width, capture.height);
    writeFileSync(join(OUTPUT, file), png);
    const { rgba: _rgba, ...metadata } = capture;
    frames.push({
      ...metadata,
      file,
      rgbaFnv1a: fnv1a(capture.rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
    });
    console.log(
      `${capture.id} ${capture.width}x${capture.height}: ` +
        `${capture.trainerKey} f${capture.hostFrame} -> ${file}`,
    );
  }
  const manifest: GIdentityCaptureManifest = {
    format: "pocket-tuxemon/g-identity-battle-goldens/v1",
    source: {
      chooser: "start_tuxemon",
      battleMap: "spyder_paper_town",
      battleEvent: "e024_first_fight_start",
    },
    frames,
  };
  writeFileSync(
    join(OUTPUT, "g-identity-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

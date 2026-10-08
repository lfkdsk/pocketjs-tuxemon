// Focused identity acceptance fixture.
//
// Every race is selected through the real imported start_tuxemon choice and
// applied by that map's real set_template parallel event. For battle checks,
// the fixture carries the resulting persistent switch bank into Paper Town
// and lets the real "First Fight - Start" event reach Battle Processing. The
// map hop is a test-harness shortcut; neither the identity command nor the
// battle command is synthesized.

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import {
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import {
  buildProject,
  G6_IMPORT_OPTIONS,
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
import type {
  Command,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

export const IDENTITY_RACES = [
  { option: "White male", code: 6, sprite: "adventurer", combatSheet: "adventurer", pronoun: 0 },
  { option: "Black male", code: 2, sprite: "adventurerblack", combatSheet: "adventurerblack", pronoun: 0 },
  { option: "White female", code: 5, sprite: "heroine", combatSheet: "heroine", pronoun: 1 },
  { option: "Black female", code: 1, sprite: "brownheroine_brown", combatSheet: "heroineblack", pronoun: 1 },
  { option: "Nonbinary", code: 3, sprite: "enbyasian", combatSheet: "enbyasian", pronoun: 2 },
  { option: "Whatever", code: 4, sprite: "penguin", combatSheet: "penguin", pronoun: 2 },
] as const;

export type IdentityRace = (typeof IDENTITY_RACES)[number];

const BUILD = buildProject([
  "start_tuxemon",
  "healing_center",
  "spyder_bedroom",
  "spyder_paper_town",
], G6_IMPORT_OPTIONS);
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);

function enumCode(variable: string, value: string): number {
  const values = BUILD.variables[variable];
  const index = values?.indexOf(value) ?? -1;
  if (index < 0) throw new Error(`G identity: missing enum ${variable}:${value}`);
  return index + 1;
}
function sourceProject(start: Project["start"]): Project {
  const project = structuredClone(BUILD.project);
  project.start = start;
  // buildProject normally starts production in spyder_bedroom and injects a
  // one-shot default identity there. This fixture starts at the real chooser,
  // so letting that convenience page run after the authored transfer would
  // overwrite the race we just selected.
  const bedroom = project.maps.find((map) => map.id === "spyder_bedroom");
  if (!bedroom?.events) throw new Error("G identity: missing imported Spyder bedroom");
  bedroom.events = bedroom.events.filter((event) => event.id !== "e000_boot");
  return project;
}

export function identityProject(): Project {
  return sourceProject({ map: "start_tuxemon", x: 4, y: 4, dir: "down" });
}

export function identityBuildVariables(): Readonly<Record<string, readonly string[]>> {
  return BUILD.variables;
}

export function objectCommands(value: unknown, out: Command[] = []): Command[] {
  if (Array.isArray(value)) {
    for (const child of value) objectCommands(child, out);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.op === "string") out.push(record as unknown as Command);
    for (const child of Object.values(record)) objectCommands(child, out);
  }
  return out;
}

class Driver {
  private previous = 0;

  constructor(
    readonly session: Session,
    public state: SessionState,
  ) {}

  private input(mask: number): SessionInput {
    const pressed = mask & ~this.previous;
    return {
      buttons: mask,
      confirmEdge: Boolean(pressed & BTN_CONFIRM),
      cancelEdge: Boolean(pressed & BTN_CANCEL),
      upEdge: Boolean(pressed & BTN_BITS.UP),
      rightEdge: Boolean(pressed & BTN_BITS.RIGHT),
      downEdge: Boolean(pressed & BTN_BITS.DOWN),
      leftEdge: Boolean(pressed & BTN_BITS.LEFT),
    };
  }

  tick(mask = 0): void {
    this.state = stepSession(this.session, this.state, this.input(mask));
    this.previous = mask;
  }

  press(mask: number): void {
    this.tick(mask);
    this.tick(0);
  }

  until(predicate: (state: SessionState) => boolean, label: string, limit = 2_000): void {
    for (let frame = 0; frame < limit && !predicate(this.state); frame++) this.tick();
    if (!predicate(this.state)) {
      throw new Error(
        `G identity: ${label} not reached from ${this.state.mapId}@` +
          `${this.state.move.tx},${this.state.move.ty}`,
      );
    }
  }

  choose(index: number): void {
    const modal = this.state.interp.modal;
    if (modal?.kind !== "choices") throw new Error("G identity: expected a choice modal");
    for (let row = modal.index; row !== index; row = (row + 1) % modal.options.length) {
      this.press(BTN_BITS.DOWN);
    }
    this.press(BTN_CONFIRM);
  }
}

/** Select one race and pronoun through start_tuxemon and wait for its real
 *  transfer to commit. */
export function runImportedIdentity(race: IdentityRace): SessionState {
  const project = identityProject();
  const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
  const driver = new Driver(session, startSession(project, session));

  driver.until((state) => state.interp.modal?.kind === "choices", "scenario choice");
  driver.choose(0); // Spyder
  driver.until((state) => state.interp.modal?.kind === "choices", "appearance choice");
  const appearance = driver.state.interp.modal;
  if (appearance?.kind !== "choices") throw new Error("G identity: appearance choice disappeared");
  const raceIndex = appearance.options.findIndex((label) => label.includes(race.option));
  if (raceIndex < 0) throw new Error(`G identity: missing appearance option ${race.option}`);
  driver.choose(raceIndex);
  driver.until(
    (state) => state.sw.playerAppearance?.defaultSprite === race.sprite,
    `${race.option} appearance branch`,
  );
  driver.until((state) => state.interp.modal?.kind === "choices", "pronoun choice");
  driver.choose(race.pronoun);
  driver.until((state) => state.mapId === "spyder_bedroom", "Spyder transfer");
  return driver.state;
}

function starterExtension() {
  const ext = initialTuxemonExtensionState();
  ext.party = [spawnMonster(
    TUXEMON_BATTLE_DB,
    RULE_DB,
    { rng: 0x1d3f_5a79, rngDraws: 0 },
    "rockitten",
    5,
    { iid: "g-identity-starter" },
  )];
  return packTuxemonExtensionState(ext);
}

/** Carry an identity selected above into Paper Town, then execute the real
 *  imported First Fight event through its Battle Processing command. */
export function enterImportedIdentityBattle(race: IdentityRace): {
  identity: SessionState;
  state: SessionState;
  battle: RuntimeBattleState;
} {
  const identity = runImportedIdentity(race);
  const project = sourceProject({ map: "spyder_paper_town", x: 25, y: 8, dir: "down" });
  const sw = structuredClone(identity.sw);
  sw.variables["v.firstfightdue"] = enumCode("firstfightdue", "yes");
  sw.variables["v.billie_choice"] = enumCode("billie_choice", "budaye");
  const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
  const driver = new Driver(session, startSession(project, session, sw, starterExtension()));

  for (let frame = 0; frame < 2_000 && driver.state.scene?.kind !== "battle"; frame++) {
    const modal = driver.state.interp.modal;
    if (modal?.kind === "text") driver.press(BTN_CONFIRM);
    else driver.tick();
  }
  if (driver.state.scene?.kind !== "battle") {
    throw new Error("G identity: Paper Town First Fight did not enter Battle Processing");
  }
  return {
    identity,
    state: driver.state,
    battle: tuxemonRuntimeBattleState(driver.state.scene.state),
  };
}

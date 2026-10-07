import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import {
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

const ext = (): JsonValue => packTuxemonExtensionState(initialTuxemonExtensionState());

/** A chapter-save-style start: the ext state with the battle backdrop already
 *  set, as it would be after the player walked in from the previous map.
 *  taba_ba_br_3 has no set_environment autorun of its own — in Tuxemon the
 *  environment is global state set by taba_ba_main's "battle environment"
 *  event, so a save made inside the battle room carries "interior". */
const extWithEnv = (environment: string): JsonValue =>
  packTuxemonExtensionState({ ...initialTuxemonExtensionState(), environment });

/** A session driver that boots the real imported project on one map and
 *  walks the player with the kit's A* route search, so the spectator battle
 *  is reached through the importer-produced event script — never by calling
 *  startSpectatorBattle or injecting state.scene. */
class Driver {
  private previous = 0;
  readonly session: Session;
  state: SessionState;

  constructor(project: Project, start: Project["start"], value: JsonValue = ext()) {
    this.session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    this.state = startSession(project, this.session, undefined, value);
  }

  private input(mask: number): SessionInput {
    const edge = (bit: number) => Boolean((mask & bit) && !(this.previous & bit));
    return {
      buttons: mask,
      confirmEdge: edge(BTN_CONFIRM),
      cancelEdge: edge(BTN_CANCEL),
      upEdge: edge(BTN_BITS.UP),
      downEdge: edge(BTN_BITS.DOWN),
      leftEdge: edge(BTN_BITS.LEFT),
      rightEdge: edge(BTN_BITS.RIGHT),
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

  idle(frames: number): void {
    for (let i = 0; i < frames; i++) this.tick(0);
  }

  /** Walk to rest on (tx,ty) using the kit's A* route search, replaying the
   *  planned masks verbatim. Returns false if a modal/scene interrupted. */
  walkTo(tx: number, ty: number, limit = 40): boolean {
    for (let step = 0; step < limit; step++) {
      if (this.state.interp.modal || this.state.interp.inputLocked || this.state.scene) return false;
      if (this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving) return true;
      const plan = searchWalk({
        session: this.session,
        state: this.state,
        prevMask: this.previous,
        tx, ty,
        avoid: new Set(),
        maxExpansions: 20_000,
      });
      if (!plan.masks.length) return false;
      for (const mask of plan.masks) this.tick(mask);
    }
    return this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving;
  }

  /** Advance text/choices modals until a battle scene opens or the budget is
   *  spent. Choice modals pick the option whose label matches `choice`. */
  settleUntilBattle(choice?: string, limit = 1200): void {
    for (let i = 0; i < limit; i++) {
      if (this.state.scene?.kind === "battle") return;
      const modal = this.state.interp.modal;
      if (modal?.kind === "text") { this.press(BTN_CONFIRM); continue; }
      if (modal?.kind === "choices") {
        if (choice !== undefined) {
          const index = modal.options.indexOf(choice);
          if (index < 0) throw new Error(`choice '${choice}' not in [${modal.options.join(", ")}]`);
          while (this.state.interp.modal?.kind === "choices" && this.state.interp.modal.index !== index) {
            this.press(BTN_BITS.DOWN);
          }
        }
        this.press(BTN_CONFIRM);
        continue;
      }
      this.tick(0);
    }
  }

  spectatorFighter(): string | null {
    if (this.state.scene?.kind !== "battle") return null;
    return tuxemonRuntimeBattleState(this.state.scene.state).spectator?.fighter ?? null;
  }
}

// Build one project per battle map (module level, like gi2b-storage). The
// interior maps run as standalone legacy-transfer projects.
const GYM = buildProject(["spyder_leather_gym"], G6_IMPORT_OPTIONS).project;
const NIMROD = buildProject(["spyder_nimrod_middle"], G6_IMPORT_OPTIONS).project;
const TABA = buildProject(["taba_ba_br_3"], G6_IMPORT_OPTIONS).project;
const SCOOP = buildProject(["spyder_scoop3"], G6_IMPORT_OPTIONS).project;

describe("spectator battles trigger through real imported map events", () => {
  test("leather gym: talking to Brad starts Chad-vs-Brad", () => {
    // The gym entry from spyder_leather_town lands at (1,10). The parallel
    // spawn guards place Brad (12,9) and Chad (9,9) and stage their parties
    // on map entry; talking to Brad runs his action page (moveRoute, text,
    // then the spectate battle op).
    const driver = new Driver(GYM, { map: "spyder_leather_gym", x: 1, y: 10, dir: "right" });
    driver.idle(40);
    expect(driver.walkTo(12, 10)).toBe(true);
    // Face up toward Brad at (12,9) and talk.
    driver.tick(BTN_BITS.UP);
    driver.press(BTN_CONFIRM);
    driver.settleUntilBattle();
    expect(driver.state.scene?.kind).toBe("battle");
    expect(driver.spectatorFighter()).toBe("spyder_leathergym_chad");
  });

  test("leather gym: talking to Chad starts Brad-vs-Chad", () => {
    const driver = new Driver(GYM, { map: "spyder_leather_gym", x: 1, y: 10, dir: "right" });
    driver.idle(40);
    expect(driver.walkTo(9, 10)).toBe(true);
    driver.tick(BTN_BITS.UP);
    driver.press(BTN_CONFIRM);
    driver.settleUntilBattle();
    expect(driver.state.scene?.kind).toBe("battle");
    expect(driver.spectatorFighter()).toBe("spyder_leathergym_brad");
  });

  test("nimrod middle: the Post Flashback parallel event starts Zircon-vs-Argon", () => {
    // The Post Flashback parallel event (x17,y1) fires when v.zircon_argon
    // is 1 and the fight has not run yet — the story state when the player
    // reaches the flashback room. It locks input, stages both parties and
    // runs the spectate battle op.
    const driver = new Driver(NIMROD, { map: "spyder_nimrod_middle", x: 17, y: 5, dir: "up" });
    driver.state.sw.variables["v.zircon_argon"] = 1;
    driver.settleUntilBattle();
    expect(driver.state.scene?.kind).toBe("battle");
    expect(driver.spectatorFighter()).toBe("spyder_nimrod_zircon");
  });

  test("taba: walking into the acolyte chain starts Cam-vs-Zeke", () => {
    // Entering taba_ba_br_3 from the passageway at (1,3) and stepping right
    // onto (2,3) touches the "there he is" playerTouch pad, which chains
    // unhinged 4->3->1 and stages Cam's Lambert and Zeke's Agnidon before
    // the spectate battle op. The battle room has no set_environment autorun
    // (Tuxemon carries the backdrop from taba_ba_main), so the start state
    // carries "interior" like a save made inside the room.
    const driver = new Driver(TABA, { map: "taba_ba_br_3", x: 1, y: 3, dir: "right" }, extWithEnv("interior"));
    driver.idle(10);
    expect(driver.walkTo(2, 3)).toBe(false); // the touch pad interrupts the walk
    // The acolyte cutscene is long (dialogue, moveRoutes, the Omnigrunt
    // entrance) before the battle op; give it room to play out.
    driver.settleUntilBattle(undefined, 3000);
    expect(driver.state.scene?.kind).toBe("battle");
    expect(driver.spectatorFighter()).toBe("cam");
  });

  test("scoop3: the Intro choice starts Reese-vs-Arachne", () => {
    // Talking to the Intro event at (10,3) and choosing Yes sets
    // v.cctv_scoop=3; the Watch parallel event then stages the parties and
    // runs the spectate battle op.
    const driver = new Driver(SCOOP, { map: "spyder_scoop3", x: 1, y: 11, dir: "up" });
    driver.idle(20);
    expect(driver.walkTo(10, 4)).toBe(true);
    driver.tick(BTN_BITS.UP);
    driver.press(BTN_CONFIRM);
    driver.settleUntilBattle("Yes");
    expect(driver.state.scene?.kind).toBe("battle");
    expect(driver.spectatorFighter()).toBe("spyder_scoop_reese");
  });
});

describe("spectator battle on the J2 mainline tape", () => {
  test("the J2 journey records the nimrod spectator battle from real tape frames", () => {
    // The J2 mainline tape walks through spyder_nimrod_middle and triggers
    // the Post Flashback event through the real input stream. The journey
    // records it as a spectator battle checkpoint — tape-frame evidence that
    // the imported event script starts the battle in the real game.
    const journey = JSON.parse(
      readFileSync(join(ROOT, "data/j2-hospitalcure-journey.json"), "utf8"),
    ) as { battles: Array<{ opponent: string; spectator?: boolean; startFrame: number; endFrame: number }> };
    const spectator = journey.battles.filter((b) => b.spectator);
    expect(spectator).toHaveLength(1);
    expect(spectator[0]!.opponent).toBe("spyder_nimrod_argon");
    expect(spectator[0]!.startFrame).toBeGreaterThan(0);
    expect(spectator[0]!.endFrame).toBeGreaterThan(spectator[0]!.startFrame);
  });
});

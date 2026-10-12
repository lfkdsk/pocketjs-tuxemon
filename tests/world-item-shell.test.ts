import { describe, expect, test } from "bun:test";

import {
  applyWorldItemDirectives,
  liveWorldItemContext,
} from "../ui/world-item-shell.ts";
import type { WorldItemMapData } from "../ui/feature-modes-data.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";

const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "world item shell",
  tileSize: 16,
  start: { map: "field", x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{
    id: "field",
    name: "Field",
    width: 4,
    height: 4,
    ground: new Array(16).fill("plain.0"),
    events: [{
      id: "npc_spyder_boulder",
      name: "spyder_boulder",
      x: 1,
      y: 2,
      pages: [{
        trigger: "action",
        sprite: "npc.boulder",
        blocks: true,
        commands: [],
      }],
    }],
  }],
};

const DATA: WorldItemMapData = {
  source: "mods/tuxemon/maps/*.tmx",
  surfable: { field: [9] },
  fishingSource: "mods/fishing.yaml",
  fishing: {
    fishing_rod: {
      trigger: 0.6,
      levelBounds: [5, 15],
      expReqMod: 2,
      stages: ["basic"],
      stageWeights: {},
      shapes: ["piscine"],
      shapeWeights: { piscine: 1 },
      types: [],
      typeWeights: {},
      tags: [],
      tagWeights: {},
      environment: { default: "ocean", night: "night_ocean" },
      failure: {
        en_US: "The water ripples, but nothing bites.",
        zh_CN: "水面泛起涟漪，但没有鱼上钩。",
      },
    },
  },
};

function fixture() {
  const session = createSession(PROJECT);
  let live = stepSession(session, startSession(PROJECT, session), { buttons: 0 });
  const host: GameViewSessionHost = {
    project: PROJECT,
    session,
    getState: () => live,
    heldButtons: () => 17,
    replaceState(next) {
      live = next;
    },
  };
  return { host, state: () => live, setState: (next: SessionState) => { live = next; } };
}

describe("Bag live-world bridge", () => {
  test("derives surfable and facing-sprite conditions from the active imported map", () => {
    const f = fixture();
    const context = liveWorldItemContext(f.host, DATA, "zh_CN");
    expect(context.facingTile).toEqual(["water", "surfable"]);
    expect(context.facingSprite).toContain("boulder");
    expect(context.facingSprite).toContain("npc_spyder_boulder");
    expect(context.fishing?.fishing_rod?.failure).toBe("水面泛起涟漪，但没有鱼上钩。");
  });

  test("sledgehammer erases the faced actor and persists its imported visibility variables", () => {
    const f = fixture();
    const result = applyWorldItemDirectives(f.host, [{
      type: "remove-facing-entity",
      facingSprite: "boulder",
    }]);
    expect(result).toEqual({ applied: 1, rejected: [] });
    expect(f.state().interp.erased["field/npc_spyder_boulder"]).toBeTrue();
    expect(f.state().sw.variables).toMatchObject({
      "local.npc.spyder_boulder": 0,
      "v.spyder_boulder": 1,
    });
    expect(f.state().interp.sw).toBe(f.state().sw);
  });

  test("escape and fishing publish reducer-owned transfer/battle requests", () => {
    const escaped = fixture();
    expect(applyWorldItemDirectives(escaped.host, [{
      type: "teleport",
      character: "player",
      map: "clinic",
      x: 3,
      y: 7,
    }])).toEqual({ applied: 1, rejected: [] });
    expect(escaped.state().interp.pendingTransfer).toMatchObject({
      fiber: "menu:item:teleport",
      map: "clinic",
      x: 3,
      y: 7,
      dir: "keep",
    });

    const fishing = fixture();
    expect(applyWorldItemDirectives(fishing.host, [{
      type: "fishing",
      facingTile: "surfable",
      species: "nudiflot_male",
      level: 9,
      experienceModifier: 2,
      environment: "ocean",
    }])).toEqual({ applied: 1, rejected: [] });
    expect(fishing.state().interp.main).toMatchObject({
      key: "menu:item:fishing",
      mode: "external",
    });
    expect(fishing.state().interp.pendingBattles).toEqual([{
      fiber: "menu:item:fishing",
      setup: {
        kind: "wild",
        species: "nudiflot_male",
        level: 9,
        experienceModifier: 2,
        moneyModifier: 0,
        environment: "ocean",
        inside: false,
      },
    }]);
  });
});

// Tuxepedia overlay: the pure navigation logic (rows, step, filter), the
// runtime's discovery read from the live session, and the save-menu
// integration (the extra root row opens the overlay). The presentation and
// touch gestures are covered by the visual and touch tests.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { createOsk } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-controller.ts";
import {
  TUXEPEDIA_PAGE_SIZE,
  createTuxepediaRuntime,
  tuxepediaRows,
  tuxepediaStep,
  type TuxepediaState,
} from "../ui/tuxepedia-runtime.ts";
import { createSaveMenuRuntime } from "../ui/save-menu-runtime.ts";
import { initialTuxemonExtensionState } from "../battle/extension.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { TuxemonSceneCatalog } from "../battle/scenes.ts";

const ALL = [
  "aardart", "aardorn", "bolt", "nut", "pawsand",
  "rockitten", "tweesher", "zaprilla", "memnom", "djemp",
];

const catalog = {
  index: ALL.map((id, i) => ({ id, entry: "", txmnId: i + 1, name: id })),
  monster: () => undefined,
} as unknown as TuxemonSceneCatalog;

function stateWith(seen: string[], caught: string[], cursor = 0): TuxepediaState {
  return { cursor, filter: "all", seen, caught };
}

describe("tuxepediaRows", () => {
  test("the all filter lists every monster in catalog order", () => {
    expect(tuxepediaRows(stateWith([], []), ALL)).toEqual(ALL);
  });

  test("the caught filter lists only caught monsters, in catalog order", () => {
    const rows = tuxepediaRows(stateWith(["bolt"], ["aardorn", "nut"]), ALL);
    // filter=all here; switch to caught below
    expect(rows).toEqual(ALL);
    const caught = tuxepediaRows(
      { cursor: 0, filter: "caught", seen: ["bolt"], caught: ["aardorn", "nut"] },
      ALL,
    );
    expect(caught).toEqual(["aardorn", "nut"]);
  });

  test("a caught monster is not also listed as seen", () => {
    // The extension keeps seen/caught disjoint; the filter reads caught only.
    const caught = tuxepediaRows(
      { cursor: 0, filter: "caught", seen: [], caught: ["bolt"] },
      ALL,
    );
    expect(caught).toEqual(["bolt"]);
  });
});

describe("tuxepediaStep", () => {
  test("down/up move the cursor and wrap at the ends", () => {
    let s = stateWith([], []);
    s = tuxepediaStep(s, "down", ALL);
    expect(s.cursor).toBe(1);
    s = tuxepediaStep(s, "down", ALL);
    expect(s.cursor).toBe(2);
    // wrap to the top
    s = { ...s, cursor: ALL.length - 1 };
    s = tuxepediaStep(s, "down", ALL);
    expect(s.cursor).toBe(0);
    // wrap to the bottom
    s = tuxepediaStep(s, "up", ALL);
    expect(s.cursor).toBe(ALL.length - 1);
  });

  test("page up/down move by the page size and clamp at the ends", () => {
    let s = stateWith([], [], 0);
    s = tuxepediaStep(s, "pageDown", ALL);
    expect(s.cursor).toBe(TUXEPEDIA_PAGE_SIZE);
    s = tuxepediaStep(s, "pageDown", ALL);
    expect(s.cursor).toBe(ALL.length - 1); // clamped
    s = tuxepediaStep(s, "pageUp", ALL);
    expect(s.cursor).toBe(ALL.length - 1 - TUXEPEDIA_PAGE_SIZE);
    s = { ...s, cursor: 3 };
    s = tuxepediaStep(s, "pageUp", ALL);
    expect(s.cursor).toBe(0); // clamped
  });

  test("toggleFilter switches to caught and back, preserving the cursor when the monster survives", () => {
    // cursor on aardorn (index 1), which is caught
    let s = stateWith(["bolt"], ["aardorn", "nut"], 1);
    s = tuxepediaStep(s, "toggleFilter", ALL);
    expect(s.filter).toBe("caught");
    // aardorn is the first caught row
    expect(s.cursor).toBe(0);
    expect(tuxepediaRows(s, ALL)).toEqual(["aardorn", "nut"]);
    // toggle back: aardorn is at index 1 in the all list
    s = tuxepediaStep(s, "toggleFilter", ALL);
    expect(s.filter).toBe("all");
    expect(s.cursor).toBe(1);
  });

  test("toggleFilter resets the cursor when the monster does not survive the filter", () => {
    // cursor on bolt (index 2), which is only seen (not caught)
    let s = stateWith(["bolt"], ["aardorn"], 2);
    s = tuxepediaStep(s, "toggleFilter", ALL);
    expect(s.filter).toBe("caught");
    expect(s.cursor).toBe(0); // bolt is not in the caught list
  });

  test("navigation in the caught filter stays within the caught rows", () => {
    const s0: TuxepediaState = { cursor: 0, filter: "caught", seen: [], caught: ["aardorn", "nut"] };
    let s = tuxepediaStep(s0, "down", ALL);
    expect(s.cursor).toBe(1);
    s = tuxepediaStep(s, "down", ALL);
    expect(s.cursor).toBe(0); // wrapped within the 2 caught rows
  });
});

describe("tuxepedia runtime", () => {
  function mockHost(ext: unknown): GameViewSessionHost {
    return {
      project: {} as never,
      session: { content: null } as never,
      getState: () => ({ ext }) as never,
      heldButtons: () => 0,
      replaceState: () => {},
    };
  }

  function mount(ext: unknown) {
    let dispose = () => {};
    const runtime = createRoot((d) => {
      dispose = d;
      return createTuxepediaRuntime({ catalog, lang: "en_US" }, mockHost(ext));
    });
    return { runtime, dispose };
  }

  test("open reads seen/caught from the live session and close hides the overlay", () => {
    const ext = initialTuxemonExtensionState();
    // The extension keeps seen/caught disjoint (caught wins).
    ext.seen = ["bolt", "nut"];
    ext.caught = ["aardorn"];
    const { runtime, dispose } = mount(ext);
    expect(runtime.isOpen()).toBe(false);
    runtime.open();
    expect(runtime.isOpen()).toBe(true);
    expect(runtime.state().seen).toEqual(["bolt", "nut"]);
    expect(runtime.state().caught).toEqual(["aardorn"]);
    // The displayed seen count is the union (seen includes caught).
    expect(runtime.counts()).toEqual({ seen: 3, caught: 1, total: ALL.length });
    runtime.close();
    expect(runtime.isOpen()).toBe(false);
    dispose();
  });

  test("an undecodable extension opens as nothing discovered", () => {
    const { runtime, dispose } = mount("not-a-valid-extension");
    runtime.open();
    expect(runtime.state().seen).toEqual([]);
    expect(runtime.state().caught).toEqual([]);
    expect(runtime.counts()).toEqual({ seen: 0, caught: 0, total: ALL.length });
    dispose();
  });

  test("step navigates and closes on CROSS/START", () => {
    const ext = initialTuxemonExtensionState();
    ext.caught = ["nut"];
    const { runtime, dispose } = mount(ext);
    runtime.open();
    // down moves the cursor
    runtime.step(0, BTN.DOWN);
    expect(runtime.state().cursor).toBe(1);
    // SQUARE toggles the filter
    runtime.step(0, BTN.SQUARE);
    expect(runtime.state().filter).toBe("caught");
    expect(runtime.rows()).toEqual(["nut"]);
    // CROSS closes
    runtime.step(0, BTN.CROSS);
    expect(runtime.isOpen()).toBe(false);
    dispose();
  });

  test("step while closed does not consume the frame", () => {
    const { runtime, dispose } = mount(initialTuxemonExtensionState());
    expect(runtime.step(0, BTN.DOWN)).toEqual({ consumed: false });
    dispose();
  });

  test("seen count is the union and is at least the caught count", () => {
    const ext = initialTuxemonExtensionState();
    ext.seen = ["bolt", "tweesher"];
    ext.caught = ["rockitten", "nut"];
    const { runtime, dispose } = mount(ext);
    runtime.open();
    const counts = runtime.counts();
    // The list marks 2 caught (C) and 2 seen-only (S) rows; the top bar's
    // seen count is their sum (seen includes caught).
    expect(counts.caught).toBe(2);
    expect(counts.seen).toBe(4);
    expect(counts.seen).toBeGreaterThanOrEqual(counts.caught);
    expect(counts.seen).toBe(
      runtime.rows().filter((slug) => ext.seen.includes(slug) || ext.caught.includes(slug)).length,
    );
    dispose();
  });

  test("monsters with txmnId 0 are excluded, so the list starts at #001", () => {
    // The original journal excludes txmn_id 0 (special/developer monsters)
    // from its pages; the catalog carries them at the front of the index.
    const catalogWithZero = {
      index: [
        { id: "agnsher", entry: "", txmnId: 0, name: "agnsher" },
        { id: "rockitten", entry: "", txmnId: 1, name: "rockitten" },
        { id: "nut", entry: "", txmnId: 4, name: "nut" },
      ],
      monster: () => undefined,
    } as unknown as TuxemonSceneCatalog;
    let dispose = () => {};
    const runtime = createRoot((d) => {
      dispose = d;
      return createTuxepediaRuntime({ catalog: catalogWithZero, lang: "en_US" }, mockHost(initialTuxemonExtensionState()));
    });
    runtime.open();
    expect(runtime.rows()).toEqual(["rockitten", "nut"]);
    expect(runtime.counts().total).toBe(2);
    dispose();
  });
});

describe("save menu Tuxepedia row", () => {
  function mockHost(ext: unknown): GameViewSessionHost {
    return {
      project: {} as never,
      session: { content: null } as never,
      getState: () => ({ ext }) as never,
      heldButtons: () => 0,
      replaceState: () => {},
    };
  }

  test("confirming the extra row calls onExtra and stays on the root", () => {
    const extra: { id: string | null } = { id: null };
    let dispose = () => {};
    const menu = createRoot((d) => {
      dispose = d;
      return createSaveMenuRuntime(
        {
          slots: null,
          extraRows: [{ id: "tuxepedia", label: "Tuxepedia" }],
          onExtra: (id) => { extra.id = id; },
        },
        mockHost(initialTuxemonExtensionState()),
        createOsk,
      );
    });
    // open with START
    expect(menu.step(BTN.START, BTN.START)).toEqual({ consumed: true });
    expect(menu.isOpen()).toBe(true);
    // code-only root: [code-export, code-import, tuxepedia]; down x2
    menu.step(BTN.DOWN, BTN.DOWN);
    menu.step(0, 0);
    menu.step(BTN.DOWN, BTN.DOWN);
    menu.step(0, 0);
    expect(menu.menu().kind).toBe("root");
    // confirm the tuxepedia row
    menu.step(BTN.CIRCLE, BTN.CIRCLE);
    expect(extra.id).toBe("tuxepedia");
    // the menu stays open on the root (the overlay opens on top)
    expect(menu.menu()).toEqual({ kind: "root", index: 2 });
    dispose();
  });
});

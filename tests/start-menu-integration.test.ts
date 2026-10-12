import { describe, expect, test } from "bun:test";

import { createSession, startSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  requestHostQuit,
  resetWorldSession,
  titleSaveAvailability,
} from "../ui/start-menu-integration.ts";

const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "start-menu-integration",
  tileSize: 16,
  start: { map: "start", x: 1, y: 2, dir: "down" },
  initialGold: 25,
  playerName: "Hero",
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [{ id: "potion", name: "Potion", price: 1 }],
  maps: [{
    id: "start",
    name: "Start",
    width: 4,
    height: 4,
    ground: new Array(16).fill("plain.0"),
  }],
};

describe("START/title effect shell", () => {
  test("Exit replaces the mutated world with a genuinely fresh session", () => {
    const session = createSession(PROJECT);
    let live = startSession(PROJECT, session);
    live = {
      ...live,
      frame: 999,
      sw: {
        ...live.sw,
        gold: 777,
        items: { potion: 4 },
        variables: { old_session: 1 },
      },
      move: { ...live.move, tx: 3, ty: 3, px: 48, py: 48 },
      ext: { stale: true },
    };
    let held = -1;
    const fresh = resetWorldSession({
      project: PROJECT,
      session,
      getState: () => live,
      heldButtons: () => 0xffff,
      replaceState(next, nextHeld) {
        live = next;
        held = nextHeld ?? -1;
      },
    });

    expect(live).toBe(fresh);
    expect(held).toBe(0);
    expect(fresh).toMatchObject({ frame: 0, mapId: "start" });
    expect(fresh.sw).toMatchObject({ playerName: "Hero", gold: 25, items: {}, variables: {} });
    expect(fresh.move).toMatchObject({ tx: 1, ty: 2 });
    expect(fresh.ext).toBeNull();
  });

  test("title shortcuts expose healthy manual saves and gate Autosave behind them", () => {
    let slots: Array<null | { slot: number; map?: string; error?: string }> = [null, null, null];
    let autosave: null | { slot: 0; map?: string; error?: string } = { slot: 0, map: "start" };
    let refreshes = 0;
    const runtime = {
      refresh: () => { refreshes++; },
      slots: () => slots,
      autosave: () => autosave,
    } as never;

    expect(titleSaveAvailability(runtime)).toEqual({ manualSave: false, autosave: false });
    slots = [{ slot: 1, error: "bad checksum" }, null, null];
    expect(titleSaveAvailability(runtime)).toEqual({ manualSave: false, autosave: false });
    slots = [{ slot: 1, map: "start" }, null, null];
    expect(titleSaveAvailability(runtime)).toEqual({ manualSave: true, autosave: true });
    autosave = { slot: 0, error: "bad checksum" };
    expect(titleSaveAvailability(runtime)).toEqual({ manualSave: true, autosave: false });
    expect(refreshes).toBe(4);
  });

  test("desktop quit emits the exact PocketJS service intent and degrades without svc", () => {
    const lines: string[] = [];
    expect(requestHostQuit({ svcSend: (line) => lines.push(line) })).toBe(true);
    expect(lines).toEqual(["{\"t\":\"quit\"}"]);
    expect(requestHostQuit({})).toBe(false);
  });
});

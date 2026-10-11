import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { createOsk } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-controller.ts";

import featureModesJson from "../data/feature-modes.json";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import {
  canonicalTrackerLocation,
  createNuPhoneRuntime,
  currentNuPhoneLocation,
  knownTrackerLocations,
  nuPhoneMapStep,
  nuPhonePointSelectable,
  type NuPhoneState,
} from "../ui/nuphone-runtime.ts";
import { createSaveMenuRuntime } from "../ui/save-menu-runtime.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";

const data = (featureModesJson as unknown as FeatureModesRuntimeData).nuPhoneMap;

function state(options: {
  mapId?: string;
  items?: Record<string, number>;
  switches?: Record<string, boolean>;
} = {}) {
  return {
    mapId: options.mapId ?? "spyder_bedroom",
    sw: {
      items: options.items ?? {},
      switches: options.switches ?? {},
    },
    ext: {},
  } as never;
}

function host(getState: () => ReturnType<typeof state>): GameViewSessionHost {
  return {
    project: {} as never,
    session: { content: null } as never,
    getState,
    heldButtons: () => 0,
    replaceState: () => {},
  };
}

describe("NuPhone GPS source semantics", () => {
  test("canonicalizes authored alias trackers and current map groups", () => {
    expect(canonicalTrackerLocation(data, "routea")).toBe("mansion");
    expect(canonicalTrackerLocation(data, "routeb")).toBe("routee");
    expect(canonicalTrackerLocation(data, "tunnel_below")).toBe("tunnel");
    expect(currentNuPhoneLocation(data, "spyder_mansion_basement")).toBe("mansion");
    expect(knownTrackerLocations(data, {
      "tracker.routea": true,
      "tracker.cotton_town": true,
      "tracker.routee": false,
      unrelated: true,
    })).toEqual(["cotton_town", "mansion"]);
  });

  test("core points stay selectable but unknown non-core points remain locked", () => {
    const base: NuPhoneState = {
      screen: "map",
      known: ["routec"],
      currentLocation: "routec",
      cursor: "routec",
      hasMapApp: true,
    };
    expect(nuPhonePointSelectable(data, base, "paper_town")).toBe(true);
    expect(nuPhonePointSelectable(data, base, "dragonscave")).toBe(false);
    // routec.down points at the locked Dragon's Cave, so the press is eaten.
    expect(nuPhoneMapStep(data, base, "down").cursor).toBe("routec");
    expect(nuPhoneMapStep(data, base, "up").cursor).toBe("paper_town");
  });
});

describe("NuPhone overlay runtime", () => {
  test("opens from live inventory, follows the hand-authored graph, and never mutates campaign state", () => {
    const campaign = state({
      mapId: "spyder_routea",
      items: { nu_phone: 1, app_map: 1 },
      switches: { "tracker.cotton_town": true, "tracker.routea": true },
    });
    const before = JSON.stringify(campaign);
    let dispose = () => {};
    const runtime = createRoot((d) => {
      dispose = d;
      return createNuPhoneRuntime({ data, lang: "en_US" }, host(() => campaign));
    });

    runtime.open();
    expect(runtime.state()).toMatchObject({
      screen: "phone",
      currentLocation: "mansion",
      cursor: "mansion",
      known: ["cotton_town", "mansion"],
      hasMapApp: true,
    });
    runtime.step(BTN.CIRCLE, BTN.CIRCLE);
    expect(runtime.state().screen).toBe("map");
    runtime.step(BTN.DOWN, BTN.DOWN);
    expect(runtime.state().cursor).toBe("flower_city");
    runtime.selectPoint("dragonscave");
    expect(runtime.state().cursor).toBe("flower_city");
    runtime.step(BTN.CROSS, BTN.CROSS);
    expect(runtime.state().screen).toBe("phone");
    runtime.step(BTN.CROSS, BTN.CROSS);
    expect(runtime.isOpen()).toBe(false);
    expect(JSON.stringify(campaign)).toBe(before);
    dispose();
  });

  test("the map app reports missing trackers instead of opening an empty map", () => {
    const campaign = state({ items: { nu_phone: 1, app_map: 1 } });
    let dispose = () => {};
    const runtime = createRoot((d) => {
      dispose = d;
      return createNuPhoneRuntime({ data, lang: "zh_CN" }, host(() => campaign));
    });
    runtime.open();
    runtime.applyAction("confirm");
    expect(runtime.state().screen).toBe("message");
    runtime.applyAction("confirm");
    expect(runtime.state().screen).toBe("phone");
    dispose();
  });

  test("the save/world menu resolves its NuPhone row from the current inventory", () => {
    let live = state();
    const opened: { id: string | null } = { id: null };
    let dispose = () => {};
    const menu = createRoot((d) => {
      dispose = d;
      return createSaveMenuRuntime({
        slots: null,
        extraRows: (session) => (session.sw.items.nu_phone ?? 0) > 0
          ? [{ id: "nuphone", label: "Nu Phone" }]
          : [],
        onExtra: (id) => { opened.id = id; },
      }, host(() => live), createOsk);
    });
    expect(menu.extraRows()).toEqual([]);
    live = state({ items: { nu_phone: 1 } });
    expect(menu.extraRows()).toEqual([{ id: "nuphone", label: "Nu Phone" }]);
    menu.step(BTN.START, BTN.START);
    // code-only root: export, import, NuPhone.
    menu.step(BTN.DOWN, BTN.DOWN);
    menu.step(0, 0);
    menu.step(BTN.DOWN, BTN.DOWN);
    menu.step(0, 0);
    menu.step(BTN.CIRCLE, BTN.CIRCLE);
    expect(opened.id).toBe("nuphone");
    dispose();
  });
});

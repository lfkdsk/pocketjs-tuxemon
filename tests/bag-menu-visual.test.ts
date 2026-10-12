// Bag presentation coverage through PocketJS's production Solid transform.
// Semantic tests exercise scaled touch/gesture paths; pixel tests render the
// same component through the real software rasterizer at both target sizes.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import featureModesJson from "../data/feature-modes.json";
import { validateBattleDb, type BattleDb } from "../importer/battle-schema.ts";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import type { Lang } from "../ui/language.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { __runGestures, resetGestures } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/gesture-core.ts";
import { resetFrameHooks, runFrameHooks } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/frame.ts";
import { installHost, type HostOps } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/host.ts";
import {
  flushLifecycleHooks,
  flushUnmountedHooks,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/lifecycle-solid-aot.ts";
import {
  destroyNodeTree,
  resetRendererState,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/native-tree.ts";
import { render as renderSolid } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/renderer.ts";
import {
  __packTouch,
  __packTouchWide,
  __resetTouches,
  __setTouches,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import { createWasmUi } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/wasm-ops.js";

const ROOT = resolve(import.meta.dir, "..");
const JSX_COMPILER = resolve(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/jsx-plugin.ts");
const { transformFile } = await import(JSX_COMPILER) as {
  transformFile(path: string, source: string, framework: "solid"): Promise<{ code: string }>;
};

Bun.plugin({
  name: "bag-menu-pocketjs-tsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformFile(path, await Bun.file(path).text(), "solid");
      return { contents: result.code, loader: "js" };
    });
  },
});

const {
  BAG_BASE_HEIGHT,
  BAG_BASE_WIDTH,
  BAG_DETAIL_RECT,
  BAG_LIST_RECT,
  BAG_ROW_HEIGHT,
  BAG_ROW_TOP,
  bagBasePoint,
  bagCanvas,
  bagViewRect,
  createBagMenu,
} = await import("../ui/bag-menu.tsx");

const DATA = featureModesJson as unknown as FeatureModesRuntimeData;
const DB = validateBattleDb(JSON.parse(readFileSync(resolve(ROOT, "data/battle-db.json"), "utf8")));
const ZH_DB = validateBattleDb(JSON.parse(readFileSync(resolve(ROOT, "data/battle-db.zh_CN.json"), "utf8")));
const WASM = resolve(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const browserSolid = !Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js");
const semanticTest = browserSolid ? test : test.skip;
const rasterTest = browserSolid && existsSync(WASM) ? test : test.skip;

if (!browserSolid) {
  console.warn("Bag semantic visuals skipped; run with `bun test --conditions=browser tests/bag-menu-visual.test.ts`");
} else if (!existsSync(WASM)) {
  console.warn("Bag pixel visuals skipped; run `bun run build:wasm` first");
}

function member(db: BattleDb, hpLoss = 12): SpawnedMonsterSnapshot {
  const rules = battleDbToTuxemonBattleDb(db);
  const monster = spawnMonster(db, rules, { rng: 0x4354, rngDraws: 0 }, "rockitten", 18, {
    iid: "bag-rockitten",
  });
  monster.currentHp = Math.max(1, monster.base.hp - hpLoss);
  return monster;
}

const INVENTORY = {
  potion: 2,
  tuxeball: 3,
  repellent: 1,
  flintstone: 1,
  tea: 1,
  raise_hp: 1,
  tm_scope: 1,
  restoration: 1,
  super_potion: 1,
  mega_potion: 1,
  imperial_potion: 1,
  cureall: 1,
} as const;

function fixture(lang: Lang): { host: GameViewSessionHost; db: BattleDb; state(): SessionState } {
  const db = lang === "zh_CN" ? ZH_DB : DB;
  const ext = initialTuxemonExtensionState();
  ext.party = [member(db)];
  let live = {
    frame: 0,
    sw: createSwitchState({ playerName: lang === "zh_CN" ? "小红" : "Red", items: INVENTORY }),
    ext: packTuxemonExtensionState(ext),
  } as SessionState;
  const host: GameViewSessionHost = {
    project: {} as never,
    session: { content: null } as never,
    getState: () => live,
    heldButtons: () => 0,
    replaceState: (next) => { live = next; },
  };
  return { host, db, state: () => live };
}

function fakeOps(width: number, height: number): HostOps {
  let nextNode = 2;
  const noop = () => {};
  return {
    __viewport: { w: width, h: height },
    createNode: () => nextNode++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 1,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: (value) => value.length * 8,
    loadTileTexture: () => 1,
    freeTexture: noop,
  } as HostOps;
}

type BagOverlay = ReturnType<typeof createBagMenu>;
type BagRuntime = NonNullable<BagOverlay["runtimeRef"]["current"]>;

interface MountedBag {
  runtime: BagRuntime;
  state(): SessionState;
  frame(touches?: readonly number[]): void;
  tap(x: number, y: number): void;
  swipe(fromX: number, fromY: number, toX: number, toY: number): void;
  dispose(): void;
}

function mountBag(
  ops: HostOps,
  width: number,
  height: number,
  lang: Lang,
  tick: () => void = () => {},
): MountedBag {
  __resetTouches();
  resetGestures();
  resetFrameHooks();
  resetRendererState();
  installHost({ ops, kind: "injected", target: "bag-menu-visual", strict: false });
  setStyleResolver(() => undefined);

  const f = fixture(lang);
  const overlay = createBagMenu({ db: f.db, data: DATA.startMenu, lang });
  const view = overlay.create(f.host);
  const runtime = overlay.runtimeRef.current;
  if (!runtime) throw new Error("Bag overlay did not publish runtimeRef");
  runtime.open();
  const stop = renderSolid(() => view.render() as unknown as NodeMirror, rootMirror);
  flushLifecycleHooks();

  const canvas = bagCanvas({ w: width, h: height });
  const pack = (x: number, y: number): number => width > 511 || height > 511
    ? __packTouchWide(1, Math.round(x), Math.round(y))
    : __packTouch(1, Math.round(x), Math.round(y));
  const point = (x: number, y: number) => ({
    x: canvas.left + x * canvas.scale,
    y: canvas.top + y * canvas.scale,
  });
  const frame = (touches: readonly number[] = []): void => {
    __setTouches(touches);
    __runGestures();
    runFrameHooks(0);
    runSweep();
    tick();
  };
  const tap = (x: number, y: number): void => {
    const p = point(x, y);
    frame([pack(p.x, p.y)]);
    frame();
  };
  const swipe = (fromX: number, fromY: number, toX: number, toY: number): void => {
    const from = point(fromX, fromY);
    const middle = point((fromX + toX) / 2, (fromY + toY) / 2);
    const to = point(toX, toY);
    frame([pack(from.x, from.y)]);
    frame([pack(middle.x, middle.y)]);
    frame([pack(to.x, to.y)]);
    frame();
  };
  frame();
  return {
    runtime,
    state: f.state,
    frame,
    tap,
    swipe,
    dispose() {
      stop();
      flushUnmountedHooks();
      __resetTouches();
      resetGestures();
      runSweep();
      for (const child of rootMirror.children.splice(0)) {
        child.parent = null;
        destroyNodeTree(child, ops);
      }
      resetRendererState();
      resetFrameHooks();
    },
  };
}

function namedNode(name: string, node: NodeMirror = rootMirror): NodeMirror | undefined {
  if (node.debugName === name) return node;
  for (const child of node.children) {
    const found = namedNode(name, child);
    if (found) return found;
  }
  return undefined;
}

function nodeText(node: NodeMirror | undefined): string {
  return node ? `${node.text ?? ""}${node.children.map(nodeText).join("")}` : "";
}

function rgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function countColour(
  rgba: Uint8Array,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  colour: readonly [number, number, number],
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const offset = (y * width + x) * 4;
      if (rgba[offset] === colour[0] && rgba[offset + 1] === colour[1] && rgba[offset + 2] === colour[2]) count++;
    }
  }
  return count;
}

describe("Bag presentation helpers", () => {
  test("uses one 480x272 logical canvas and round-trips scaled touch coordinates", () => {
    expect(bagCanvas({ w: 480, h: 272 })).toEqual({ scale: 1, left: 0, top: 0 });
    const large = bagCanvas({ w: 960, h: 544 });
    expect(large).toEqual({ scale: 2, left: 0, top: 0 });
    expect(bagViewRect(large, BAG_DETAIL_RECT)).toEqual({ x: 588, y: 68, w: 356, h: 404 });
    expect(bagBasePoint(large, 518, 246)).toEqual({ x: 259, y: 123 });
    expect([BAG_BASE_WIDTH, BAG_BASE_HEIGHT]).toEqual([480, 272]);
  });
});

describe("Bag semantic tree and touch", () => {
  semanticTest("renders real Chinese copy and uses scaled taps and swipes for a Potion", () => {
    const menu = mountBag(fakeOps(960, 544), 960, 544, "zh_CN");
    try {
      expect(namedNode("tux-bag-canvas")).toBeDefined();
      expect(nodeText(namedNode("tux-bag-title"))).toBe(DATA.startMenu.root.bag.zh_CN);
      expect(menu.runtime.page()).toMatchObject({ page: 0, pageCount: 2 });
      const first = menu.runtime.page().items[0]!;
      expect(nodeText(namedNode("tux-bag-item-name"))).toBe(first.name);
      expect(nodeText(namedNode("tux-bag-item-description"))).toBe(first.description);

      menu.swipe(260, 130, 40, 130);
      expect(menu.runtime.page().page).toBe(1);
      menu.swipe(40, 130, 260, 130);
      expect(menu.runtime.page().page).toBe(0);

      const potion = menu.runtime.page().items.findIndex((row) => row.slug === "potion");
      expect(potion).toBeGreaterThanOrEqual(0);
      menu.tap(80, BAG_LIST_RECT.y + BAG_ROW_TOP + potion * BAG_ROW_HEIGHT + 8);
      expect(menu.runtime.state().screen).toBe("confirm");
      expect(nodeText(namedNode("tux-bag-action-0"))).toContain(DATA.startMenu.bag.use.zh_CN);
      menu.tap(330, 163);
      expect(menu.runtime.state().screen).toBe("party");
      expect(nodeText(namedNode("tux-bag-modal-title"))).toBe(DATA.startMenu.root.party.zh_CN);
      menu.tap(120, 64);
      expect(menu.runtime.state().screen).toBe("message");
      expect(nodeText(namedNode("tux-bag-message"))).toBe(ZH_DB.items.potion!.messages.success);
      expect(menu.state().sw.items.potion).toBe(1);
      menu.tap(200, 120);
      expect(menu.runtime.isOpen()).toBeFalse();
    } finally {
      menu.dispose();
    }
  });
});

async function rasterBag(width: number, height: number): Promise<Uint8Array> {
  const wasm = await createWasmUi(await Bun.file(WASM).arrayBuffer(), { width, height });
  const menu = mountBag(wasm.ops, width, height, "zh_CN", () => wasm.tick());
  try {
    return wasm.render().slice();
  } finally {
    menu.dispose();
  }
}

describe("Bag pixels", () => {
  rasterTest("draws list/detail panels and preserves the 2x fixed composition", async () => {
    const small = await rasterBag(480, 272);
    const large = await rasterBag(960, 544);
    const paper = rgb(TUXEMON_UI_THEME.paper);
    const accent = rgb(TUXEMON_UI_THEME.accent);

    expect(countColour(small, 480, { x: 13, y: 41, w: 270, h: 14 }, accent)).toBeGreaterThan(2_000);
    expect(countColour(small, 480, { x: 300, y: 40, w: 166, h: 190 }, paper)).toBeGreaterThan(20_000);

    let exactBlocks = 0;
    let channelError = 0;
    for (let y = 0; y < 272; y++) {
      for (let x = 0; x < 480; x++) {
        const source = (y * 480 + x) * 4;
        let exact = true;
        for (let oy = 0; oy < 2; oy++) {
          for (let ox = 0; ox < 2; ox++) {
            const target = ((y * 2 + oy) * 960 + x * 2 + ox) * 4;
            for (let channel = 0; channel < 4; channel++) {
              const difference = Math.abs(large[target + channel]! - small[source + channel]!);
              channelError += difference;
              if (difference !== 0) exact = false;
            }
          }
        }
        if (exact) exactBlocks++;
      }
    }
    expect(exactBlocks / (480 * 272)).toBeGreaterThan(0.84);
    expect(channelError / (480 * 272 * 4 * 4)).toBeLessThan(3.5);
  }, 60_000);
});

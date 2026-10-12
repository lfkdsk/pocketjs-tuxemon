// START / Party / Player presentation coverage. The semantic/touch test uses
// PocketJS's real Solid mirror renderer with a tiny no-op host; the optional
// pixel test uses the same component on the software rasterizer when its wasm
// artifact is present.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SCENE_CATALOG,
} from "../battle/game.ts";
import { TUXEMON_SCENE_CATALOG_ZH } from "../battle/game-zh.ts";
import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import featureModesJson from "../data/feature-modes.json";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import type { Lang } from "../ui/language.ts";
import {
  formatMonsterExperience,
  monsterExperienceProgress,
  PARTY_ACTION_ROW_HEIGHT,
} from "../ui/start-menu-runtime.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { PSM } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
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
// Keep the build-only compiler outside this application's TypeScript graph;
// Bun resolves the concrete module at test runtime.
const { transformFile } = await import(JSX_COMPILER) as {
  transformFile(path: string, source: string, framework: "solid"): Promise<{ code: string }>;
};

// PocketJS applications normally receive this Solid universal transform from
// tools/build.ts. Bun's test loader otherwise lowers TSX through React, so
// install the same focused transform before importing the presentation.
Bun.plugin({
  name: "start-menu-pocketjs-tsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformFile(path, await Bun.file(path).text(), "solid");
      return { contents: result.code, loader: "js" };
    });
  },
});

const {
  createStartMenuOverlay,
  lazyStartMenuCatalog,
  START_MENU_BASE_H,
  START_MENU_BASE_W,
  startMenuBasePoint,
  startMenuCanvas,
  startMenuLabels,
  startMenuViewRect,
} = await import("../ui/start-menu.tsx");

const DATA = featureModesJson as unknown as FeatureModesRuntimeData;
const RULES_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
const TUXEMON_TOTAL = Object.values(TUXEMON_BATTLE_DB.monsters)
  .filter((monster) => monster.txmnId > 0).length;
const WASM = resolve(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const browserSolid = !Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js");
const semanticTest = browserSolid ? test : test.skip;
const rasterTest = browserSolid && existsSync(WASM) ? test : test.skip;

if (!browserSolid) {
  console.warn("START menu semantic visuals skipped; run with `bun test --conditions=browser tests/start-menu-visual.test.ts`");
} else if (!existsSync(WASM)) {
  console.warn("START menu pixel visuals skipped; run `bun run build:wasm` first");
}

function member(slug: string, iid: string, level: number, overrides: Partial<SpawnedMonsterSnapshot> = {}): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(TUXEMON_BATTLE_DB, RULES_DB, { rng: iid.length * 104_729, rngDraws: 0 }, slug, level, { iid }),
    acquisition: "gift",
    captureDevice: "tuxeball",
    waitingToEvolve: false,
    ...overrides,
  };
}

function fixture(lang: Lang): {
  host: GameViewSessionHost;
  state(): SessionState;
  catalog: TuxemonSceneCatalog;
} {
  const rockitten = member("rockitten", "party-rockitten", 20, {
    nickname: lang === "zh_CN" ? "岩岩" : "Pebble",
    status: "poison",
    bond: 47,
    trainingPoints: { hp: 2, armour: 3, dodge: 4, melee: 5, ranged: 6, speed: 7 },
  });
  rockitten.currentHp = Math.max(1, rockitten.base.hp - 7);
  const party = [
    rockitten,
    member("nut", "party-nut", 12),
    member("budaye", "party-budaye", 16),
  ];
  party[0]!.heldItem = "xp_feeder";
  party[1]!.heldItem = "xp_transmitter";
  const ext = initialTuxemonExtensionState();
  ext.party = party;
  ext.seen = ["budaye"];
  ext.caught = ["rockitten", "nut"];
  ext.clock = { ...ext.clock, refTick: 60 * 3_661 };
  ext.history = [
    { fighter: "player", opponent: "trainer-a", outcome: "won" },
    { fighter: "player", opponent: "trainer-b", outcome: "draw" },
  ];
  let live = {
    frame: 0,
    sw: createSwitchState({
      playerName: lang === "zh_CN" ? "小红" : "Red",
      gold: 4_321,
      steps: 1_234,
      items: { app_tuxepedia: 1, nu_phone: 1, potion: 2, antidote_grapes: 1 },
    }),
    ext: packTuxemonExtensionState(ext),
  } as SessionState;
  const host: GameViewSessionHost = {
    project: {} as never,
    session: { content: null } as never,
    getState: () => live,
    heldButtons: () => 0,
    replaceState: (next) => { live = next; },
  };
  return {
    host,
    state: () => live,
    catalog: lang === "zh_CN" ? TUXEMON_SCENE_CATALOG_ZH : TUXEMON_SCENE_CATALOG,
  };
}

function fakeOps(width: number, height: number, tileLoads: string[]): HostOps {
  let nextNode = 2;
  let nextTexture = 1_000;
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
    uploadTexture: () => nextTexture++,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: (value) => value.length * 8,
    loadTileTexture: (key, index) => {
      tileLoads.push(`${key}#${index}`);
      return nextTexture++;
    },
    freeTexture: noop,
  } as HostOps;
}

interface MountedMenu {
  runtime: NonNullable<ReturnType<typeof createStartMenuOverlay>["runtimeRef"]["current"]>;
  rows(): readonly { id: string }[];
  frame(touches?: readonly number[]): void;
  tap(x: number, y: number): void;
  swipe(fromX: number, fromY: number, toX: number, toY: number): void;
  dispose(): void;
}

function mountMenu(
  ops: HostOps,
  width: number,
  height: number,
  lang: Lang,
  tick: () => void = () => {},
): MountedMenu {
  __resetTouches();
  resetGestures();
  resetFrameHooks();
  resetRendererState();
  installHost({ ops, kind: "injected", target: "start-menu-visual", strict: false });
  // All important layout and colors in this fixed composition are inline.
  // The production build supplies the utility table; this isolated renderer
  // deliberately ignores class-only flex conveniences.
  setStyleResolver(() => undefined);

  const f = fixture(lang);
  const overlay = createStartMenuOverlay({
    data: DATA.startMenu,
    lang,
    catalog: f.catalog,
    tuxepediaTotal: TUXEMON_TOTAL,
    nuPhoneLabel: DATA.nuPhoneMap.entry.phoneLabel,
  });
  const view = overlay.create(f.host);
  const runtime = overlay.runtimeRef.current;
  if (!runtime) throw new Error("START menu overlay did not publish runtimeRef");
  runtime.open();
  const stop = renderSolid(() => view.render() as unknown as NodeMirror, rootMirror);
  flushLifecycleHooks();

  const canvas = startMenuCanvas({ w: width, h: height });
  const pack = (x: number, y: number): number => width > 511 || height > 511
    ? __packTouchWide(1, Math.round(x), Math.round(y))
    : __packTouch(1, Math.round(x), Math.round(y));
  const screenPoint = (x: number, y: number) => ({
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
    const point = screenPoint(x, y);
    frame([pack(point.x, point.y)]);
    frame();
  };
  const swipe = (fromX: number, fromY: number, toX: number, toY: number): void => {
    const from = screenPoint(fromX, fromY);
    const middle = screenPoint((fromX + toX) / 2, (fromY + toY) / 2);
    const to = screenPoint(toX, toY);
    frame([pack(from.x, from.y)]);
    frame([pack(middle.x, middle.y)]);
    frame([pack(to.x, to.y)]);
    frame();
  };
  // The first live frame updates StartMenuView's initial 480x272 viewport to
  // this host's real viewport before touch regions are exercised.
  frame();

  return {
    runtime,
    rows: () => runtime.rows(),
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

describe("START menu presentation helpers", () => {
  test("keeps one 480x272 logical canvas and round-trips 2x touch coordinates", () => {
    expect(startMenuCanvas({ w: 480, h: 272 })).toEqual({ scale: 1, left: 0, top: 0 });
    const large = startMenuCanvas({ w: 960, h: 544 });
    expect(large).toEqual({ scale: 2, left: 0, top: 0 });
    const logical = { x: 140, y: 42, w: 200, h: 198 };
    expect(startMenuViewRect(large, logical)).toEqual({ x: 280, y: 84, w: 400, h: 396 });
    expect(startMenuBasePoint(large, 514, 246)).toEqual({ x: 257, y: 123 });
    expect([START_MENU_BASE_W, START_MENU_BASE_H]).toEqual([480, 272]);
  });

  test("uses generated English/Chinese strings, a real lazy catalog, and publishes runtimeRef", () => {
    const en = startMenuLabels(DATA.startMenu, "en_US", DATA.nuPhoneMap.entry.phoneLabel);
    const zh = startMenuLabels(DATA.startMenu, "zh_CN", DATA.nuPhoneMap.entry.phoneLabel);
    expect(en.root.party).toBe(DATA.startMenu.root.party.en_US);
    expect(en.root.player).toBe(DATA.startMenu.root.player.en_US);
    expect(zh.root.party).toBe(DATA.startMenu.root.party.zh_CN);
    expect(zh.root.player).toBe(DATA.startMenu.root.player.zh_CN);
    expect(zh.root.tuxepedia).toBe("精灵百科");
    expect(zh.root.nuphone).toBe("Nu 手机");

    const calls: string[] = [];
    const source: TuxemonSceneCatalog = {
      index: TUXEMON_SCENE_CATALOG.index,
      monster(slug) {
        calls.push(`monster:${slug}`);
        return TUXEMON_SCENE_CATALOG.monster(slug);
      },
      technique(slug) {
        calls.push(`technique:${slug}`);
        return TUXEMON_SCENE_CATALOG.technique(slug);
      },
      item: (slug) => TUXEMON_SCENE_CATALOG.item(slug),
      status: (slug) => TUXEMON_SCENE_CATALOG.status(slug),
      database() {
        throw new Error("lazy START catalog must not load the complete database");
      },
    };
    const lazy = lazyStartMenuCatalog(source);
    expect(calls).toEqual([]);
    expect(lazy.monsters.rockitten?.name).toBe("Rockitten");
    expect(lazy.techniques.boulder?.name).toBeTruthy();
    expect(calls).toEqual(["monster:rockitten", "technique:boulder"]);

    const f = fixture("en_US");
    let callbackHost: GameViewSessionHost | undefined;
    const overlay = createStartMenuOverlay({
      data: DATA.startMenu,
      lang: "en_US",
      catalog: f.catalog,
      callbacks: { bag: (host) => { callbackHost = host; } },
    });
    let stop = () => {};
    createRoot((dispose) => {
      stop = dispose;
      const view = overlay.create(f.host);
      expect(overlay.runtimeRef.current).not.toBeNull();
      expect(view.isOpen()).toBe(false);
      overlay.runtimeRef.current!.open();
      overlay.runtimeRef.current!.activateIndex(
        overlay.runtimeRef.current!.rows().findIndex((row) => row.id === "bag"),
      );
      expect(callbackHost).toBe(f.host);
      expect(view.isOpen()).toBe(true);
    });
    stop();
  });
});

describe("START menu semantic tree and touch", () => {
  semanticTest("renders localized root/party/detail/moves/player trees and shares every touch path", () => {
    const tileLoads: string[] = [];
    const menu = mountMenu(fakeOps(960, 544, tileLoads), 960, 544, "zh_CN");
    try {
      expect(namedNode("start-menu-canvas")).toBeDefined();
      expect(nodeText(namedNode("start-menu-root-title"))).toBe("开始菜单");
      expect(nodeText(namedNode("start-menu-root-label-party"))).toBe(DATA.startMenu.root.party.zh_CN);
      expect(nodeText(namedNode("start-menu-root-label-tuxepedia"))).toBe("精灵百科");

      // Blank panel space below the authored rows is not an implicit Exit
      // target. This catches regressions where the touch index was clamped to
      // the final row by the shared runtime.
      menu.tap(220, 42 + menu.rows().length * 20 + 6);
      expect(menu.runtime.isOpen()).toBeTrue();
      expect(menu.runtime.state().screen).toBe("root");

      const partyIndex = menu.rows().findIndex((row) => row.id === "party");
      menu.tap(220, 42 + partyIndex * 20 + 10);
      expect(menu.runtime.state().screen).toBe("party");
      expect(namedNode("start-menu-party-row-0")).toBeDefined();
      expect(namedNode("start-menu-party-avatar-0")).toBeDefined();
      expect(nodeText(namedNode("start-menu-party-name-0"))).toBe("岩岩");
      expect(nodeText(namedNode("start-menu-party-level-0"))).toContain("20");
      expect(nodeText(namedNode("start-menu-party-hp-0"))).toContain("/");
      expect(nodeText(namedNode("start-menu-party-status-0"))).toBe("中毒");
      expect(namedNode("start-menu-party-held-icon-0")).toBeDefined();
      expect(nodeText(namedNode("start-menu-party-summary")))
        .toContain(menu.runtime.selectedMonster()!.heldItemName!);
      expect(tileLoads.length).toBeGreaterThanOrEqual(3);
      expect(tileLoads.every((ref) => ref.startsWith("ui:tile.battle/"))).toBeTrue();

      // Party row -> action -> Sort -> Name, all through authored touch rows.
      menu.tap(80, 29 + 7 + 16);
      expect(menu.runtime.state().partyMenu.phase).toBe("action");
      expect(menu.runtime.actionRows()).toEqual([
        "info", "moves", "unequip", "equip", "swapItem", "move", "sort", "release",
      ]);
      expect(nodeText(namedNode("start-menu-party-action-label-unequip"))).toBe("卸下");
      expect(nodeText(namedNode("start-menu-party-action-label-equip"))).toBe("装备");
      expect(nodeText(namedNode("start-menu-party-action-label-swapItem"))).toBe("交换道具");
      const sortAction = menu.runtime.actionRows().indexOf("sort");
      menu.tap(350, 29 + 48 + sortAction * PARTY_ACTION_ROW_HEIGHT + 9);
      expect(menu.runtime.state().partyMenu.phase).toBe("sort");
      expect(namedNode("start-menu-party-sort-name")).toBeDefined();
      menu.tap(350, 29 + 48 + 2 * 34 + 15);
      expect(menu.runtime.state().partyMenu.phase).toBe("list");
      expect(menu.runtime.state().party.map((monster) => monster.slug)).toEqual(["budaye", "rockitten", "nut"]);

      // Party row -> action -> Release -> Back (inert) -> No, including the
      // dialog's shared confirmation-row activation path.
      menu.tap(80, 29 + 7 + 16);
      const releaseAction = menu.runtime.actionRows().indexOf("release");
      menu.tap(350, 29 + 48 + releaseAction * PARTY_ACTION_ROW_HEIGHT + 9);
      expect(menu.runtime.state().partyMenu.phase).toBe("releaseConfirm");
      expect(namedNode("start-menu-release-dialog")).toBeDefined();
      expect(nodeText(namedNode("start-menu-release-question"))).toContain(menu.runtime.selectedMonster()!.name.toUpperCase());
      expect(nodeText(namedNode("start-menu-release-answer-0"))).toBe("否");
      expect(nodeText(namedNode("start-menu-release-answer-1"))).toBe("是");
      menu.runtime.applyAction("back");
      expect(menu.runtime.state().partyMenu.phase).toBe("releaseConfirm");
      menu.tap(150, 160);
      expect(menu.runtime.state().partyMenu.phase).toBe("list");
      expect(menu.runtime.state().party).toHaveLength(3);

      // Detail exposes snapshot fields and horizontal pan changes Tuxemon.
      menu.tap(80, 29 + 7 + 16);
      menu.tap(350, 29 + 48 + 12); // Info
      expect(menu.runtime.state().partyMenu.phase).toBe("detail");
      expect(nodeText(namedNode("start-menu-detail-name"))).toContain(menu.runtime.selectedMonster()!.name);
      expect(nodeText(namedNode("start-menu-detail-primary"))).toContain("经验");
      const selected = menu.runtime.state().party[menu.runtime.state().partyMenu.cursor]!;
      const expectedExperience = formatMonsterExperience(monsterExperienceProgress(
        selected,
        TUXEMON_SCENE_CATALOG.database().rules,
      ));
      expect(nodeText(namedNode("start-menu-detail-primary"))).toContain(`经验  ${expectedExperience}`);
      expect(nodeText(namedNode("start-menu-detail-primary"))).toContain("cm");
      expect(nodeText(namedNode("start-menu-detail-stats"))).toContain("速度");
      expect(nodeText(namedNode("start-menu-detail-ivs"))).toContain("个体值");
      const detailCursor = menu.runtime.state().partyMenu.cursor;
      menu.swipe(380, 130, 280, 130);
      expect(menu.runtime.state().partyMenu.cursor).toBe((detailCursor + 1) % 3);

      menu.tap(430, 15); // back to list
      menu.tap(80, 29 + 7 + menu.runtime.state().partyMenu.cursor * 34 + 16);
      const movesAction = menu.runtime.actionRows().indexOf("moves");
      menu.tap(350, 29 + 48 + movesAction * PARTY_ACTION_ROW_HEIGHT + 9);
      expect(menu.runtime.state().partyMenu.phase).toBe("moves");
      expect(namedNode("start-menu-move-row-0")).toBeDefined();
      expect(nodeText(namedNode("start-menu-move-name-0"))).not.toBe("");
      expect(nodeText(namedNode("start-menu-move-stats-0"))).toContain(DATA.startMenu.common.accuracy.zh_CN);
      const movesCursor = menu.runtime.state().partyMenu.cursor;
      menu.swipe(280, 130, 380, 130);
      expect(menu.runtime.state().partyMenu.cursor).toBe((movesCursor + 2) % 3);

      // Back to root, then Player. Full generated Chinese strings remain in
      // the tree, including the long battle summary (no ellipsis/truncation).
      menu.tap(430, 15);
      menu.tap(430, 15);
      const playerIndex = menu.rows().findIndex((row) => row.id === "player");
      menu.tap(220, 42 + playerIndex * 20 + 10);
      expect(menu.runtime.state().screen).toBe("player");
      expect(nodeText(namedNode("start-menu-player-wallet"))).toBe("小红的钱包： $4,321");
      expect(nodeText(namedNode("start-menu-player-progress"))).toBe("精灵百科完成度： 0.8%!");
      expect(nodeText(namedNode("start-menu-player-seen"))).toBe("看到了3只精灵，共有393");
      expect(nodeText(namedNode("start-menu-player-caught"))).toBe("捉住了2只精灵，共有393");
      expect(nodeText(namedNode("start-menu-player-playtime"))).toBe("总游戏时长: 1h 1m");
      expect(nodeText(namedNode("start-menu-player-walked"))).toBe("行走的路程 1.23 km");
      expect(nodeText(namedNode("start-menu-player-battles"))).toBe("战斗： 2 （胜利1 平局1 失败0)");
    } finally {
      menu.dispose();
    }
  });

  for (const lang of ["en_US", "zh_CN"] as const) {
    semanticTest(`matches upstream ${lang} release copy, answer order, and result dialog`, () => {
      const menu = mountMenu(fakeOps(480, 272, []), 480, 272, lang);
      try {
        const partyIndex = menu.rows().findIndex((row) => row.id === "party");
        menu.tap(220, 42 + partyIndex * 20 + 10);
        menu.tap(80, 29 + 7 + 16);
        const releaseAction = menu.runtime.actionRows().indexOf("release");
        menu.tap(350, 29 + 48 + releaseAction * PARTY_ACTION_ROW_HEIGHT + 9);

        const releasedName = menu.runtime.selectedMonster()!.name.toUpperCase();
        const expectedQuestion = lang === "zh_CN"
          ? `确定要放生${releasedName}吗？`
          : `Are you sure you would like to release ${releasedName}?`;
        expect(nodeText(namedNode("start-menu-release-question"))).toBe(expectedQuestion);
        expect(nodeText(namedNode("start-menu-release-answer-0"))).toBe(lang === "zh_CN" ? "否" : "No");
        expect(nodeText(namedNode("start-menu-release-answer-1"))).toBe(lang === "zh_CN" ? "是" : "Yes");

        menu.tap(330, 160);
        expect(menu.runtime.state().partyMenu.phase).toBe("releaseResult");
        expect(menu.runtime.state().party).toHaveLength(2);
        expect(nodeText(namedNode("start-menu-release-result-text"))).toBe(
          lang === "zh_CN" ? `已放生${releasedName}。` : `${releasedName} has been released.`,
        );

        menu.tap(200, 130);
        expect(menu.runtime.state().partyMenu.phase).toBe("list");
      } finally {
        menu.dispose();
      }
    });
  }
});

interface RasterCapture {
  rgba: Uint8Array;
  tileLoads: string[];
}

async function rasterParty(width: number, height: number): Promise<RasterCapture> {
  const wasm = await createWasmUi(await Bun.file(WASM).arrayBuffer(), { width, height });
  const tileLoads: string[] = [];
  const sprite = new Uint8Array(64 * 64 * 4);
  for (let offset = 0; offset < sprite.length; offset += 4) {
    sprite.set([235, 75, 195, 255], offset);
  }
  (wasm.ops as HostOps & { loadTileTexture: (key: string, index: number) => number }).loadTileTexture = (key, index) => {
    tileLoads.push(`${key}#${index}`);
    return wasm.ops.uploadTexture(sprite, 64, 64, PSM.PSM_8888);
  };
  const menu = mountMenu(wasm.ops, width, height, "en_US", () => wasm.tick());
  try {
    const partyIndex = menu.rows().findIndex((row) => row.id === "party");
    menu.tap(220, 42 + partyIndex * 20 + 10);
    return { rgba: wasm.render().slice(), tileLoads };
  } finally {
    menu.dispose();
  }
}

describe("START menu pixels", () => {
  rasterTest("draws party panels/art and the 960x544 frame is the 2x 480x272 composition", async () => {
    const small = await rasterParty(480, 272);
    const large = await rasterParty(960, 544);
    const selected = rgb("#145064");
    const paper = rgb(TUXEMON_UI_THEME.paper);
    const sprite = [235, 75, 195] as const;

    expect(countColour(small.rgba, 480, { x: 13, y: 36, w: 270, h: 32 }, selected)).toBeGreaterThan(2_500);
    expect(countColour(small.rgba, 480, { x: 302, y: 34, w: 164, h: 206 }, paper)).toBeGreaterThan(20_000);
    expect(countColour(small.rgba, 480, { x: 15, y: 37, w: 30, h: 30 }, sprite)).toBeGreaterThan(100);
    expect(small.tileLoads.length).toBeGreaterThanOrEqual(3);
    expect(large.tileLoads.length).toBe(small.tileLoads.length);

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
              const difference = Math.abs(large.rgba[target + channel]! - small.rgba[source + channel]!);
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

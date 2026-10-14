#!/usr/bin/env bun
// Exercise two imported double-battle map events through the built browser
// player and real browser input sources. Route 5 is triggered and advanced
// with KeyboardEvents; Dragon's Cave is entered and advanced with the
// on-screen pad through CDP touch events. The fixture only supplies a normal
// production save beside each authored event: no scene or button mask is
// injected into the game.
//
//   bun run web
//   bun run verify:web:doubles

import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { doubleBattleBootSnapshot } from "./double-battle-visual-fixture.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import {
  WEB_CHUNK_AWARE_STEP_EXPRESSION,
  WEB_CHUNK_AWARE_STEP_SOURCE,
} from "./web-chunk-step.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-double-input");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]!
  : process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-double-input: no site at dist/web; run `bun run web` first");
  process.exit(2);
}

rmSync(OUT, { recursive: true, force: true });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
  },
});
registerCleanup(() => server.stop(true));

const chrome = await spawnHeadlessChrome(CHROME, join(OUT, "profile"));
registerCleanup(() => chrome.close());
registerCleanup(() => rmSync(OUT, { recursive: true, force: true }));

const ws = new WebSocket(chrome.wsUrl);
await new Promise<void>((resolveOpen) => ws.addEventListener("open", () => resolveOpen(), { once: true }));
registerCleanup(() => ws.close());

let sequence = 0;
const pending = new Map<number, (message: any) => void>();
const browserErrors: string[] = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    browserErrors.push(message.params.exceptionDetails?.exception?.description
      ?? message.params.exceptionDetails?.text ?? "exception");
  } else if (message.method === "Runtime.consoleAPICalled"
    && ["error", "assert"].includes(message.params.type)) {
    browserErrors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    browserErrors.push(message.params.entry.text);
  }
});

const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolveMessage, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => message.error
      ? reject(new Error(message.error.message))
      : resolveMessage(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async <T = any>(expression: string): Promise<T> => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

const snapshots = {
  route5: doubleBattleBootSnapshot("en_US", "route5"),
  dragonscave: doubleBattleBootSnapshot("zh_CN", "dragonscave"),
};
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
    const fixtures = ${JSON.stringify(snapshots)};
    globalThis.__pocketTuxemonBootSnapshot = fixtures[new URLSearchParams(location.search).get("doubleInput")];
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    ${WEB_CHUNK_AWARE_STEP_SOURCE}
  `,
});

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const base = `http://127.0.0.1:${server.port}/pocket-tuxemon/`;

async function navigate(url: string): Promise<void> {
  const loaded = new Promise<void>((resolveLoad) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.method !== "Page.loadEventFired") return;
      ws.removeEventListener("message", listener);
      resolveLoad();
    };
    ws.addEventListener("message", listener);
  });
  await send("Page.navigate", { url });
  await loaded;
}

async function waitFor(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(expression).catch(() => false)) return;
    await evaluate(WEB_CHUNK_AWARE_STEP_EXPRESSION).catch(() => false);
    await sleep(20);
  }
  const detail = await evaluate(`({
    player: globalThis.__pocketPlayer?.state,
    bootReady: globalThis.__pocketTuxemonBootReady,
    hasSession: !!globalThis.__rpgSessionState,
    frameBlocked: globalThis.__pocketPlayer?.frameBlocked,
    chunks: globalThis.__pocketPlayer?.pakChunks?.stats?.(),
  })`).catch(() => null);
  throw new Error(`verify-web-double-input: timed out waiting for ${label}: ${JSON.stringify(detail)}; ${browserErrors.join(" | ")}`);
}

async function boot(query: string): Promise<void> {
  await navigate(`${base}?${query}`);
  await waitFor(
    "production session boot",
    `globalThis.__pocketPlayer?.state === "running"
      && globalThis.__pocketTuxemonBootReady === true
      && !!globalThis.__rpgSessionState`,
  );
  await evaluate(`globalThis.__pocketPlayer.focus()`);
  await step(20);
}

async function step(count = 1): Promise<void> {
  await evaluate(`(async () => {
    for (let i = 0; i < ${count}; i++) await (${WEB_CHUNK_AWARE_STEP_EXPRESSION});
  })()`);
}

interface InputPress {
  heldMask: number;
  sourceCount: number;
}

async function pressKey(code: string, key: string, windowsVirtualKeyCode: number): Promise<InputPress> {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", code, key, windowsVirtualKeyCode,
  });
  const heldMask = await evaluate<number>(`globalThis.__pocketPlayer.buttons()`);
  const sourceCount = await evaluate<number>(`globalThis.__pocketPlayer.keys.size`);
  await step();
  await send("Input.dispatchKeyEvent", {
    type: "keyUp", code, key, windowsVirtualKeyCode,
  });
  await step();
  return { heldMask, sourceCount };
}

async function elementCenter(selector: string): Promise<{ x: number; y: number }> {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`missing touch control ${selector}`)});
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
}

async function touchStart(point: { x: number; y: number }, id = 1): Promise<InputPress> {
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...point, id }],
  });
  return {
    heldMask: await evaluate<number>(`globalThis.__pocketPlayer.buttons()`),
    sourceCount: await evaluate<number>(`globalThis.__pocketPlayer.pad.size`),
  };
}

async function touchEnd(): Promise<void> {
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function pressTouch(selector: string): Promise<InputPress> {
  const point = await elementCenter(selector);
  const pressed = await touchStart(point);
  await step();
  await touchEnd();
  await step();
  return pressed;
}

interface BattleSummary {
  map: string;
  opponent: string;
  fieldSize: number;
  player: string[];
  enemy: string[];
}

async function battleSummary(): Promise<BattleSummary> {
  return evaluate(`(() => {
    const state = globalThis.__rpgSessionState;
    const battle = state.scene?.state?.battle;
    return {
      map: state.mapId,
      opponent: battle?.opponent ?? "",
      fieldSize: battle?.fieldSize ?? 0,
      player: (battle?.parties?.[0] ?? []).map((monster) => monster.slug),
      enemy: (battle?.parties?.[1] ?? []).map((monster) => monster.slug),
    };
  })()`);
}

async function advanceWithKeyboard(): Promise<{ firstText: string; confirms: number }> {
  let firstText = "";
  let confirms = 0;
  for (let guard = 0; guard < 4_000; guard++) {
    if (await evaluate<boolean>(`globalThis.__rpgSessionState.scene?.kind === "battle"`)) {
      return { firstText, confirms };
    }
    const modal = await evaluate<{ kind?: string; lines?: string[] } | null>(
      `globalThis.__rpgSessionState.interp.modal`,
    );
    if (modal?.kind === "text") {
      firstText ||= modal.lines?.join(" ") ?? "";
      await pressKey("Enter", "Enter", 13);
      confirms++;
    } else {
      await step();
    }
  }
  throw new Error("verify-web-double-input: keyboard event did not reach battle");
}

async function advanceWithTouch(): Promise<{ firstText: string; confirms: number }> {
  let firstText = "";
  let confirms = 0;
  for (let guard = 0; guard < 4_000; guard++) {
    if (await evaluate<boolean>(`globalThis.__rpgSessionState.scene?.kind === "battle"`)) {
      return { firstText, confirms };
    }
    const modal = await evaluate<{ kind?: string; lines?: string[] } | null>(
      `globalThis.__rpgSessionState.interp.modal`,
    );
    if (modal?.kind === "text") {
      firstText ||= modal.lines?.join(" ") ?? "";
      await pressTouch('[data-button="CIRCLE"]');
      confirms++;
    } else {
      await step();
    }
  }
  throw new Error("verify-web-double-input: touch event did not reach battle");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-web-double-input: ${message}`);
}

// Route 5: a focused production player receives real Enter key events. The
// first key edge triggers object 77; subsequent key edges advance its text.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await boot("lang=en&doubleInput=route5");
const keyboardTrigger = await pressKey("Enter", "Enter", 13);
assert(keyboardTrigger.heldMask === 0x2000 && keyboardTrigger.sourceCount === 1,
  `Enter did not reach the keyboard map (${JSON.stringify(keyboardTrigger)})`);
const keyboardDrive = await advanceWithKeyboard();
const route5 = await battleSummary();
assert(route5.map === "spyder_route5", `keyboard map is ${route5.map}`);
assert(route5.opponent === "spyder_route5_tryphaena" && route5.fieldSize === 2,
  `keyboard battle is ${route5.opponent} fieldSize=${route5.fieldSize}`);
assert(JSON.stringify(route5.enemy) === JSON.stringify(["miaownolith", "criniotherme"]),
  `keyboard enemy party is ${route5.enemy.join(",")}`);

// Dragon's Cave: a portrait mobile page receives CDP touch contacts on its
// visible RIGHT and CIRCLE controls. Holding RIGHT enters object 98's strip;
// later CIRCLE taps advance the authored Chinese conversation.
await send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await boot("lang=zh&doubleInput=dragonscave");
const right = await elementCenter('[data-button="RIGHT"]');
const touchTrigger = await touchStart(right);
assert(touchTrigger.heldMask === 0x0020 && touchTrigger.sourceCount === 1,
  `RIGHT touch did not reach the virtual pad (${JSON.stringify(touchTrigger)})`);
for (let guard = 0; guard < 90; guard++) {
  if (await evaluate<boolean>(`!!globalThis.__rpgSessionState.interp.inputLocked
    || !!globalThis.__rpgSessionState.interp.modal
    || globalThis.__rpgSessionState.scene?.kind === "battle"`)) break;
  await step();
}
await touchEnd();
await step();
const touchDrive = await advanceWithTouch();
const cave = await battleSummary();
assert(cave.map === "spyder_dragonscave", `touch map is ${cave.map}`);
assert(cave.opponent === "spyder_dragonscave_ray" && cave.fieldSize === 2,
  `touch battle is ${cave.opponent} fieldSize=${cave.fieldSize}`);
assert(JSON.stringify(cave.enemy) === JSON.stringify(["ghosteeth", "embazook", "arthrobolt", "hydrone"]),
  `touch enemy party is ${cave.enemy.join(",")}`);
assert(/[\u3400-\u9fff]/u.test(touchDrive.firstText),
  `touch path did not expose Chinese dialogue: ${JSON.stringify(touchDrive.firstText)}`);
assert(browserErrors.length === 0, `browser errors: ${browserErrors.join(" | ")}`);

console.log("verify-web-double-input: PASS");
console.log(JSON.stringify({
  keyboard: {
    source: "CDP KeyboardEvent Enter",
    trigger: keyboardTrigger,
    confirms: keyboardDrive.confirms,
    firstText: keyboardDrive.firstText,
    battle: route5,
  },
  touch: {
    source: "CDP TouchEvent virtual RIGHT/CIRCLE",
    trigger: touchTrigger,
    confirms: touchDrive.confirms,
    firstText: touchDrive.firstText,
    battle: cave,
  },
}, null, 2));
ws.close();
chrome.close();
server.stop(true);
rmSync(OUT, { recursive: true, force: true });

#!/usr/bin/env bun
// Prove three newly imported music tracks through the real Chrome/PocketJS
// audio path. Each map deep link runs its authored play_music event, the
// runtime QOA decoder writes non-zero PCM to the host, the host accepts and
// plays it, and Chrome exposes a running realtime AudioContext worklet.
//
//   bun run web
//   bun run verify:web:audio

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-audio");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

const TRACKS = [
  { map: "spyder_timber_town", id: "music_18_nighttide_waltz" },
  { map: "spyder_scoop1", id: "music_omnichannel" },
  { map: "tunnel_below", id: "music_dragons_cave" },
] as const;

if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-audio: no site at dist/web; run `bun run web` first");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(ROOT, "assets/audio/manifest.json"), "utf8")) as {
  files: Record<string, { slug: string; kind: string }>;
};
for (const track of TRACKS) {
  const entry = Object.values(manifest.files).find((candidate) => candidate.slug === track.id);
  if (!entry || entry.kind !== "music") throw new Error(`verify-web-audio: no QOA manifest entry for ${track.id}`);
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
const errors: string[] = [];
const audioContexts = new Map<string, Record<string, any>>();
const audioNodes = new Map<string, Record<string, any>>();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
  } else if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) {
    errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    errors.push(message.params.entry.text);
  } else if (message.method === "Network.loadingFailed" && !message.params.canceled) {
    errors.push(`request failed: ${message.params.errorText}`);
  } else if (message.method === "WebAudio.contextCreated") {
    audioContexts.set(message.params.context.contextId, message.params.context);
  } else if (message.method === "WebAudio.contextChanged") {
    const context = message.params.context;
    audioContexts.set(context.contextId, { ...audioContexts.get(context.contextId), ...context });
  } else if (message.method === "WebAudio.contextWillBeDestroyed") {
    audioContexts.delete(message.params.contextId);
  } else if (message.method === "WebAudio.audioNodeCreated") {
    audioNodes.set(message.params.node.nodeId, message.params.node);
  } else if (message.method === "WebAudio.audioNodeWillBeDestroyed") {
    audioNodes.delete(message.params.nodeId);
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
await send("Network.enable");
await send("Page.enable");
await send("WebAudio.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    globalThis.__musicAudioProbe = {
      assigned: false, creates: [], writes: 0, acceptedFrames: 0,
      nonZeroSamples: 0, maxAbs: 0, plays: [], pauses: [], underruns: 0
    };
    let __musicAudioValue;
    Object.defineProperty(globalThis, "audio", {
      configurable: true,
      get() { return __musicAudioValue; },
      set(next) {
        if (!next || typeof next !== "object") { __musicAudioValue = next; return; }
        const probe = globalThis.__musicAudioProbe;
        const wrapped = {};
        const names = ["createStream", "destroyStream", "writePcm", "play", "pause", "stop", "setVolume", "endStream", "poll"];
        for (const name of names) {
          wrapped[name] = (...args) => {
            if (name === "createStream") {
              const handle = next[name](...args);
              probe.creates.push({ handle, rate: args[0], channels: args[1] });
              return handle;
            }
            if (name === "writePcm") {
              const pcm = new Int16Array(args[1]);
              let nonZero = 0;
              let maxAbs = 0;
              for (let i = 0; i < pcm.length; i++) {
                const absolute = Math.abs(pcm[i]);
                if (absolute !== 0) nonZero++;
                if (absolute > maxAbs) maxAbs = absolute;
              }
              const accepted = next[name](...args);
              probe.writes++;
              probe.acceptedFrames += accepted;
              probe.nonZeroSamples += nonZero;
              probe.maxAbs = Math.max(probe.maxAbs, maxAbs);
              return accepted;
            }
            const result = next[name](...args);
            if (name === "play") probe.plays.push(args[0]);
            else if (name === "pause") probe.pauses.push(args[0]);
            else if (name === "poll" && typeof result === "string" && result.includes('"t":"underrun"')) probe.underruns++;
            return result;
          };
        }
        probe.assigned = true;
        __musicAudioValue = wrapped;
      }
    });
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

async function stepUntil(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(expression).catch(() => false)) return;
    await evaluate(`globalThis.__pocketPlayer?.step()`).catch(() => undefined);
    await sleep(20);
  }
  throw new Error(`verify-web-audio: timeout waiting for ${label}`);
}

interface Probe {
  assigned: boolean;
  creates: { handle: number; rate: number; channels: number }[];
  writes: number;
  acceptedFrames: number;
  nonZeroSamples: number;
  maxAbs: number;
  plays: number[];
  pauses: number[];
  underruns: number;
}

let failures = 0;
for (const track of TRACKS) {
  audioContexts.clear();
  audioNodes.clear();
  const errorsBefore = errors.length;
  await navigate(`${base}?map=${encodeURIComponent(track.map)}`);
  await stepUntil(
    `${track.map} boot and authored BGM`,
    `globalThis.__pocketPlayer?.state === "running" &&
      globalThis.__rpgSessionState?.mapId === ${JSON.stringify(track.map)} &&
      globalThis.__rpgSessionState?.interp?.audio?.bgm?.id === ${JSON.stringify(track.id)}`,
  );

  // A real input event satisfies browser autoplay policy without pressing a
  // mapped game button. Keep stepping so the guest refills the live ring.
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F1", code: "F1", windowsVirtualKeyCode: 112 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "F1", code: "F1", windowsVirtualKeyCode: 112 });
  await stepUntil(
    `${track.id} PCM and playback`,
    `globalThis.__musicAudioProbe?.acceptedFrames > 0 &&
      globalThis.__musicAudioProbe?.nonZeroSamples > 0 &&
      globalThis.__musicAudioProbe?.plays?.length > 0`,
  );
  const deadline = Date.now() + 10_000;
  let context: Record<string, any> | undefined;
  let worklet: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    context = [...audioContexts.values()].find((candidate) =>
      candidate.contextType === "realtime" && candidate.contextState === "running"
    );
    worklet = context && [...audioNodes.values()].find((candidate) =>
      candidate.contextId === context!.contextId && /worklet/i.test(String(candidate.nodeType))
    );
    if (context && worklet) break;
    await evaluate(`globalThis.__pocketPlayer?.step()`).catch(() => undefined);
    await sleep(20);
  }

  const state = await evaluate<{ map: string; bgm: string | null; probe: Probe }>(`({
    map: globalThis.__rpgSessionState.mapId,
    bgm: globalThis.__rpgSessionState.interp.audio?.bgm?.id ?? null,
    probe: globalThis.__musicAudioProbe
  })`);
  const stream = state.probe.creates.find((candidate) => state.probe.plays.includes(candidate.handle));
  const ok = state.map === track.map && state.bgm === track.id && state.probe.assigned &&
    stream?.rate === 22050 && stream.channels === 1 && state.probe.writes > 0 &&
    state.probe.acceptedFrames > 0 && state.probe.nonZeroSamples > 0 && state.probe.maxAbs > 0 &&
    state.probe.underruns === 0 && context !== undefined && worklet !== undefined &&
    errors.length === errorsBefore;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${track.id} on ${track.map}: ` +
    `stream=${stream?.rate ?? "?"}Hz/${stream?.channels ?? "?"}ch, ` +
    `writes=${state.probe.writes}, accepted=${state.probe.acceptedFrames}, ` +
    `nonzero=${state.probe.nonZeroSamples}, peak=${state.probe.maxAbs}, ` +
    `context=${context?.contextState ?? "missing"}, node=${worklet?.nodeType ?? "missing"}, ` +
    `underruns=${state.probe.underruns}, errors=${errors.length - errorsBefore}`,
  );
}

if (errors.length > 0) {
  console.error(`verify-web-audio: ${errors.length} browser error(s):\n  ${errors.join("\n  ")}`);
}
console.log(failures === 0 && errors.length === 0 ? "WEB AUDIO PASS" : "WEB AUDIO FAIL");
ws.close();
chrome.close();
server.stop(true);
rmSync(OUT, { recursive: true, force: true });
process.exit(failures === 0 && errors.length === 0 ? 0 : 1);

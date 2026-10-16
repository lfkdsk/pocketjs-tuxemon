import { expect, test } from "bun:test";
import {
  createGameMapEntrySource,
  type GameEntryReaders,
} from "../ui/entry-readers.ts";
import { createWebAudioChunkReader } from "../ui/weather-effects.tsx";
import type { BrowserPakChunks } from "../ui/web-pak.ts";
import { browserPwaMapLoadErrorHandler } from "../ui/web-pak.ts";
import type { GameViewMapLoadFailure } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";

function bridge(
  ready: Set<string>,
  prepare: (key: string) => Promise<void>,
  prefetch: (key: string) => Promise<void> = async () => {},
): BrowserPakChunks {
  return {
    ready: (key) => ready.has(key),
    prepare,
    prefetch,
    stats: () => ({
      startupBytes: 0,
      resident: [],
      pending: [],
      queued: [],
      blocking: [],
      failures: {},
      compressedBytes: 0,
    }),
  };
}

test("the browser map source reports not-ready without reading and prepares the exact entry", async () => {
  const reads: string[] = [];
  const prepares: string[] = [];
  const ready = new Set<string>();
  const readers: GameEntryReaders = {
    read: (entry) => {
      reads.push(entry);
      return new Uint8Array([7]);
    },
  };
  const source = createGameMapEntrySource(readers, bridge(ready, async (entry) => {
    prepares.push(entry);
    ready.add(entry);
  }));
  expect(source.read("maps/a.rkm")).toBeUndefined();
  expect(reads).toEqual([]);
  await source.prepare!("maps/a.rkm");
  expect(prepares).toEqual(["maps/a.rkm"]);
  expect([...source.read("maps/a.rkm")!]).toEqual([7]);
  expect(reads).toEqual(["maps/a.rkm"]);
});

test("the browser map source keeps working-set prefetch separate from blocking preparation", async () => {
  const prefetched: string[] = [];
  const prepared: string[] = [];
  const source = createGameMapEntrySource(
    { read: () => new Uint8Array([7]) },
    bridge(
      new Set(),
      async (entry) => { prepared.push(entry); },
      async (entry) => { prefetched.push(entry); },
    ),
  );

  await source.prefetch!("maps/next.rkm");
  expect(prefetched).toEqual(["maps/next.rkm"]);
  expect(prepared).toEqual([]);
  await source.prepare!("maps/next.rkm");
  expect(prepared).toEqual(["maps/next.rkm"]);
});

test("a deferred Web track is retried once after preparation, without changing its bytes", async () => {
  const key = "audio:qoa.music/music_town.qoa";
  const ready = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let prepareCalls = 0;
  const staged = createWebAudioChunkReader(bridge(ready, async (entry) => {
    prepareCalls++;
    await gate;
    ready.add(entry);
  }), () => new Uint8Array([1, 2, 3]));
  expect(() => staged.read(key)).toThrow(/not ready/);
  expect(() => staged.read(key)).toThrow(/not ready/);
  expect(prepareCalls).toBe(1);
  release();
  for (let turn = 0; turn < 4 && !ready.has(key); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const retries: string[] = [];
  staged.retryReady({ retryResource: (entry) => { retries.push(entry); } });
  expect(retries).toEqual([key]);
  staged.retryReady({ retryResource: (entry) => { retries.push(entry); } });
  expect(retries).toEqual([key]);
  expect([...staged.read(key)]).toEqual([1, 2, 3]);
});

test("map load recovery is opt-in and forwards the exact controls to the PWA page", () => {
  const globals = globalThis as typeof globalThis & {
    __pocketPwa?: { showMapLoadFailure(failure: GameViewMapLoadFailure): void };
  };
  const previous = globals.__pocketPwa;
  try {
    delete globals.__pocketPwa;
    expect(browserPwaMapLoadErrorHandler()).toBeUndefined();
    const received: GameViewMapLoadFailure[] = [];
    globals.__pocketPwa = { showMapLoadFailure: (failure) => { received.push(failure); } };
    const handler = browserPwaMapLoadErrorHandler();
    let retries = 0;
    let cancels = 0;
    const failure: GameViewMapLoadFailure = {
      mapId: "route6",
      error: new Error("offline"),
      retry: () => { retries++; },
      cancel: () => { cancels++; },
    };
    handler!(failure);
    expect(received).toEqual([failure]);
    received[0]!.retry();
    received[0]!.cancel();
    expect({ retries, cancels }).toEqual({ retries: 1, cancels: 1 });
  } finally {
    if (previous) globals.__pocketPwa = previous;
    else delete globals.__pocketPwa;
  }
});

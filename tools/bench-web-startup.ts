// Fresh-profile Chrome startup comparison. The 4x CPU throttle is installed
// before navigation, and an in-page rAF probe closes after the title has been
// mounted and painted twice.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadavg } from "node:os";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import {
  summarizeStartupSamples,
  type StartupSample,
} from "./bench-startup-abba.ts";

interface WebTiming {
  appPaintMs: number;
  responseEndMs: number;
  domContentLoadedMs: number;
  loadEventMs: number;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  titleScreen: string | null;
}

function requiredSite(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const site = resolve(value);
  if (!existsSync(join(site, "pocket-tuxemon", "index.html"))) {
    throw new Error(`${name} has no pocket-tuxemon/index.html: ${site}`);
  }
  return site;
}

async function measure(
  chromePath: string,
  profileDir: string,
  url: string,
  throttle: number,
): Promise<{ timing: WebTiming; processWallMs: number }> {
  const started = performance.now();
  const chrome = await spawnHeadlessChrome(chromePath, profileDir, "960,544");
  try {
    const ws = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener("open", () => resolveOpen(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), {
        once: true,
      });
    });
    let id = 0;
    const pending = new Map<number, (message: any) => void>();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolveMessage, reject) => {
        const requestId = ++id;
        pending.set(requestId, (message) =>
          message.error
            ? reject(new Error(`${method}: ${message.error.message}`))
            : resolveMessage(message.result));
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        globalThis.__pocketTuxemonShowTitle = true;
        globalThis.__webStartupProbe = { start: performance.now(), ready: 0 };
        (() => {
          const poll = () => {
            const player = globalThis.__pocketPlayer;
            const title = globalThis.__pocketTitleBattle;
            if (player?.state === "running" && globalThis.__rpgSessionState && title) {
              requestAnimationFrame(() => requestAnimationFrame(() => {
                globalThis.__webStartupProbe.ready = performance.now();
              }));
            } else {
              requestAnimationFrame(poll);
            }
          };
          requestAnimationFrame(poll);
        })();
      `,
    });
    await send("Page.navigate", { url });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ready = await evaluate("globalThis.__webStartupProbe?.ready ?? 0").catch(() => 0);
      if (ready > 0) break;
      await Bun.sleep(25);
    }
    const timing = await evaluate(`(() => {
      const probe = globalThis.__webStartupProbe;
      if (!probe?.ready) throw new Error("web startup probe timed out");
      const navigation = performance.getEntriesByType("navigation")[0];
      const paints = Object.fromEntries(
        performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]),
      );
      return {
        appPaintMs: probe.ready - probe.start,
        responseEndMs: navigation?.responseEnd ?? 0,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
        loadEventMs: navigation?.loadEventEnd ?? 0,
        firstPaintMs: paints["first-paint"] ?? null,
        firstContentfulPaintMs: paints["first-contentful-paint"] ?? null,
        titleScreen: globalThis.__pocketTitleBattle?.state().screen ?? null,
      };
    })()`);
    ws.close();
    if (timing.titleScreen !== "title") {
      throw new Error(`web startup ended on ${timing.titleScreen ?? "no"} title screen`);
    }
    return { timing, processWallMs: performance.now() - started };
  } finally {
    chrome.close();
  }
}

async function main(): Promise<void> {
  const baseline = requiredSite("WEB_STARTUP_BASELINE_SITE");
  const candidate = requiredSite("WEB_STARTUP_CANDIDATE_SITE");
  const chromePath = process.env.CHROME
    ?? Bun.which("google-chrome")
    ?? Bun.which("chromium")
    ?? "google-chrome";
  const windows = Number(process.env.WEB_STARTUP_WINDOWS ?? "5");
  const throttle = Number(process.env.WEB_STARTUP_CPU_THROTTLE ?? "4");
  const maxLoad = Number(process.env.WEB_STARTUP_MAX_LOAD ?? "6");
  const output = resolve(
    process.env.WEB_STARTUP_OUTPUT
      ?? join(process.env.TMPDIR ?? "/var/tmp", "pocket-tuxemon-web-startup.ndjson"),
  );
  const profiles = output.replace(/\.ndjson$/, "") + "-profiles";
  if (!Number.isInteger(windows) || windows < 1) {
    throw new Error("WEB_STARTUP_WINDOWS must be a positive integer");
  }
  if (!(throttle >= 1)) throw new Error("WEB_STARTUP_CPU_THROTTLE must be at least 1");
  mkdirSync(dirname(output), { recursive: true });
  rmSync(profiles, { recursive: true, force: true });
  mkdirSync(profiles, { recursive: true });
  writeFileSync(output, `${JSON.stringify({
    type: "header",
    baseline,
    candidate,
    chromePath,
    windows,
    throttle,
    maxLoad,
    uptime: Bun.spawnSync(["uptime"], { stdout: "pipe" }).stdout.toString().trim(),
    startedAt: new Date().toISOString(),
  })}\n`);

  const sites = { baseline, candidate } as const;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const [, variant, ...rest] = decodeURIComponent(url.pathname).split("/");
      if (variant !== "baseline" && variant !== "candidate") {
        return new Response("not found", { status: 404 });
      }
      const site = sites[variant];
      let path = resolve(site, `.${sep}${rest.join(sep)}`);
      if (!path.startsWith(site + sep)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
    },
  });
  registerCleanup(() => server.stop(true));
  const samples: StartupSample[] = [];
  try {
    for (let window = 1; window <= windows; window++) {
      const order = window % 2 === 1 ? "ABBA" as const : "BAAB" as const;
      for (let slot = 0; slot < order.length; slot++) {
        const beforeLoad = loadavg();
        if (beforeLoad[0] > maxLoad) {
          throw new Error(
            `quiet web batch refused at load ${beforeLoad.map((value) => value.toFixed(2)).join(" ")} (limit ${maxLoad})`,
          );
        }
        const variant = order[slot] === "A" ? "baseline" as const : "candidate" as const;
        const profile = join(profiles, `w${window}-s${slot + 1}-${variant}`);
        const url = `http://127.0.0.1:${server.port}/${variant}/pocket-tuxemon/?lang=en_US`;
        const { timing, processWallMs } = await measure(chromePath, profile, url, throttle);
        const afterLoad = loadavg();
        const sample: StartupSample = {
          type: "sample",
          cell: `chrome-${throttle}x-en_US-480x272`,
          language: "en_US",
          viewport: "480x272",
          window,
          slot: slot + 1,
          order,
          variant,
          startupMs: timing.appPaintMs,
          processWallMs,
          launcherEnvelopeMs: Math.max(0, processWallMs - timing.appPaintMs),
          budgetPassed: true,
          exitCode: 0,
          loadBefore: beforeLoad,
          loadAfter: afterLoad,
          cpuIdlePercent: 0,
          hostStages: {},
          stages: {
            "response-end": timing.responseEndMs,
            "dom-content-loaded": timing.domContentLoadedMs,
            "load-event": timing.loadEventMs,
            "first-paint": timing.firstPaintMs ?? 0,
            "first-contentful-paint": timing.firstContentfulPaintMs ?? 0,
            "app-title-painted": timing.appPaintMs,
          },
          timestamp: new Date().toISOString(),
        };
        samples.push(sample);
        appendFileSync(output, `${JSON.stringify({ ...sample, timing })}\n`);
        console.log(
          `WEB_STARTUP window=${window}/${windows} slot=${slot + 1}/4 order=${order} variant=${variant} throttle=${throttle}x app_paint=${timing.appPaintMs.toFixed(1)}ms fcp=${timing.firstContentfulPaintMs?.toFixed(1) ?? "none"}ms load=${beforeLoad[0].toFixed(2)}`,
        );
        rmSync(profile, { recursive: true, force: true });
      }
    }
    const summary = summarizeStartupSamples(samples);
    appendFileSync(output, `${JSON.stringify({ type: "summary", summary })}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`WEB_STARTUP_OUTPUT ${output}`);
  } finally {
    server.stop(true);
    rmSync(profiles, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();

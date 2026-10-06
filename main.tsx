// @title Pocket Tuxemon — the imported Tuxemon world on Pocket RPG Kit
import { gp1Mark } from "./ui/gp1-marks.ts";
import { zhData } from "./ui/zh-data.ts";
import {
  mount,
  fsHost,
  GameView,
  NAME_INPUT_SCENE_ID,
  NameInputScene,
} from "./ui/gp1-kit-stage.ts";
import { createGameEntryReaders, createGameMapRepository } from "./ui/entry-readers.ts";
import type { ProjectShell } from "./vendor/pocket-rpgkit/src/engine/types.ts";
import {
  rawProject,
  GAME_ASSETS,
  ANIMATED_INDEX,
  NPC_SRC_INDEX,
  TERRAIN_STREAM_META,
  TERRAIN_STREAM_GROUND_INDEX,
  TERRAIN_STREAM_UPPER_INDEX,
  NPC_SRC_ASSET_PATHS,
  ANIMATED_ATLAS_NAMES,
  createProductionTuxemonBattle,
  createTuxemonJournalScene,
  TUXEMON_JOURNAL_SCENE_ID,
  TUXEMON_MONSTER_PICKER_SCENE_ID,
  TUXEMON_UI_THEME,
  TuxemonBattleScene,
  TuxemonMonsterPickerScene,
  createTuxemonMonsterShopScene,
  createTuxemonTradeScene,
  TuxemonPcScene,
  TUXEMON_MONSTER_SHOP_SCENE_ID,
  TUXEMON_PC_SCENE_ID,
  TUXEMON_TRADE_SCENE_ID,
  TUXEMON_DAYCARE_SCENE_ID,
  TuxemonDaycareScene,
} from "./ui/gp1-data-stage.ts";
import { canSwitchLang, detectLang } from "./ui/language.ts";
import { setBattleSceneLang } from "./ui/battle-scene-locale.ts";
import { createTuxemonTextTokens } from "./battle/text-tokens.ts";
import enMapDescriptions from "./dist/map-descriptions.json";
import enMonthNames from "./data/month-names.json";
import { createAnimatedProvider } from "./ui/animated-repository.ts";
import { createSaveMenu } from "./ui/save-menu.tsx";
import { persistAutosave } from "./ui/save-game.ts";
import { createLangMenu } from "./ui/lang-menu.tsx";
import { createCompositeOverlay } from "./ui/game-overlay.tsx";
import { createBootSnapshotOverlay } from "./ui/boot-snapshot-overlay.tsx";
import { createNpcSrcProvider } from "./ui/npc-src-repository.ts";
import { createChoiceIconNpcSrc } from "./ui/choice-icon-provider.ts";
import { createTerrainStreamProvider } from "./ui/terrain-stream-repository.ts";
import { createGameWorldAssetCache } from "./ui/world-cache.ts";
import {
  type PocketTuxemonWorldDiagnostics,
  withWorldDiagnostics,
} from "./ui/world-diagnostics.ts";
import { createWorldRenderer } from "./vendor/pocket-rpgkit/src/ui/world/index.ts";
import { TUXEMON_PREVIEW_HOOKS } from "./battle/preview-hooks.ts";
import { ChoiceIconBox } from "./vendor/pocket-rpgkit/src/ui/ChoiceIconBox.tsx";
import { createDemo } from "./vendor/pocket-rpgkit/src/ui/demo/index.ts";
import { frameProfileMark } from "./vendor/pocket-rpgkit/src/frame-profile.ts";
import { createGameWorldCacheDriver } from "./ui/game-world-cache-driver.ts";
import type { WorldStreamedTerrainStats } from "./vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx";
import { createDemoOptions, hasDemoChapters } from "./ui/demo-tape.ts";
import type {
  GameViewDemoConfig,
  GameViewDemoRuntime,
  GameViewOverlayConfig,
} from "./vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import {
  DEFAULT_TICKS_PER_GAME_MINUTE,
  timeWeatherAt,
  timeWeatherFromLocalDate,
  type CivilDateTime,
} from "./battle/time-weather.ts";
import { WeatherOverlay } from "./ui/weather-overlay.tsx";
import { weatherOverlaySuspended } from "./ui/weather-overlay-policy.ts";
import { createGameEffects } from "./ui/weather-effects.tsx";
import { PortraitBackdropEffects } from "./ui/portrait-backdrop.tsx";

// ui/gp1-kit-stage.ts and ui/gp1-data-stage.ts are thin re-export wrappers:
// each one's trailing gp1Mark() call fires right
// after everything it imports has finished evaluating, so
// tools/bench-g6-quickjs.sh can read globalThis.__gp1Marks after boot and
// report which startup stage — engine/kit bundle, JSON literals/module
// init, battle-rule registration, or GameView mount — actually costs time.
// The boot language (URL ?lang=, desktop lang.json, or localStorage) selects
// the shell and its shards. Chinese startup documents are synchronous raw
// pak/data.fs entries: they are decoded only for a Chinese boot and cached
// for battle display-name lookups. The PSP stub reports them unavailable and
// therefore boots English regardless of stored or requested language.
const host = fsHost();
const requestedLang = zhData.available ? detectLang() : "en_US";
const bootReaders = requestedLang === "zh_CN" ? createGameEntryReaders(host) : null;
const localizedData = bootReaders
  ? zhData.load((entry) => bootReaders.readText?.(entry) ?? bootReaders.read(entry))
  : null;
const lang = localizedData ? requestedLang : "en_US";
gp1Mark("language-data");
setBattleSceneLang(lang);
const project = (localizedData?.project ?? rawProject) as unknown as ProjectShell;
// The {x:} text-token resolver for the boot language. GameView forwards it
// to both the live session and the attract/demo controller, so a demo, a
// rewind and a re-fold expand text identically. The zh_CN descriptions come
// from the on-demand zh data (absent in the English-only PSP build).
const textTokens = createTuxemonTextTokens(lang, {
  mapDescriptions: (lang === "zh_CN"
    ? localizedData!.mapDescriptions
    : enMapDescriptions) as Record<string, string>,
  monthNames: (lang === "zh_CN" ? localizedData!.monthNames : enMonthNames) as string[],
  battleNames: localizedData?.names,
});
// splitProjectMaps/splitBattleRuntimeDb/splitAnimatedTiles/splitNpcSrc/
// splitStreamRefs emit ASCII JSON. Desktop reads map entries through the
// optional native UTF-8 text channel (KP2) and every other shard through
// data.fs bytes; web and consoles use the pak installed before this bundle
// runs. ui/entry-readers.ts wires both paths for the map repository and
// the battle/animated/npc-src/terrain-stream providers.
const { repository, readEntry } = createGameMapRepository(project.mapIndex, host);
// The effect shell samples local wall time exactly once for a fresh game.
// Reducer, render, save/restore, and rewind only see the resulting plain
// state. Simulators and CI inject the fixed override before bundle eval.
const initialCivilTime = (globalThis as typeof globalThis & {
  __pocketTuxemonInitialCivilTime?: CivilDateTime;
}).__pocketTuxemonInitialCivilTime;
// Deterministic builds may also pin the opening weather (screenshots,
// weather fixtures); production always starts sunny.
const initialWeather = (globalThis as typeof globalThis & {
  __pocketTuxemonInitialWeather?: { slug: string };
}).__pocketTuxemonInitialWeather;
const initialTimeWeather = initialCivilTime === undefined
  ? timeWeatherFromLocalDate(new Date())
  : timeWeatherAt(
    initialCivilTime,
    DEFAULT_TICKS_PER_GAME_MINUTE,
    initialWeather?.slug ?? "sunny",
  );
const { extensions, rules, scenes, catalog } = createProductionTuxemonBattle(
  { read: readEntry },
  { initialTimeWeather },
  lang,
);
gp1Mark("battle-registration");
// Same reason: NPC_SRC's sprite-frame paths now live in dist/npc-src shards
// instead of a scanned TS literal, so this keeps them reachable for the pak
// baker. GameView resolves the actual paths dynamically via npcSrc.
void NPC_SRC_ASSET_PATHS;
// Same reason: ANIMATED's atlas names now live in dist/animated shards.
void ANIMATED_ATLAS_NAMES;
const animated = createAnimatedProvider(ANIMATED_INDEX, { read: readEntry });
// The choice_monster menu icons are lazy IMG entries: the wrapper uploads a
// sprite's texture on its first npcSrc read (GameView's choice-icon resolver
// and npcFrame both index by sprite), so they never enter the boot upload
// path. The world-asset cache keeps the unwrapped table — its residency and
// eviction controls key off the original lazy proxy (ui/world-cache.ts).
const npcSrcLazy = createNpcSrcProvider(NPC_SRC_INDEX, { read: readEntry });
const npcSrc = createChoiceIconNpcSrc(npcSrcLazy);
const stream = createTerrainStreamProvider(
  TERRAIN_STREAM_META,
  TERRAIN_STREAM_GROUND_INDEX,
  TERRAIN_STREAM_UPPER_INDEX,
  { read: readEntry },
);
const assets = {
  ...GAME_ASSETS,
  animated,
  npcSrc,
  stream,
};
const worldDiagnostics: PocketTuxemonWorldDiagnostics | undefined =
  globalThis.__pocketTuxemonWorldDiagnostics;
if (worldDiagnostics) {
  worldDiagnostics.maps = project.worldLayout!.components.flatMap((component) =>
    component.placements.map((placement) => placement.mapId)
  );
  const links: Record<string, string[]> = Object.fromEntries(
    worldDiagnostics.maps.map((mapId) => [mapId, []]),
  );
  for (const component of project.worldLayout!.components) {
    for (const opening of component.openings) {
      links[opening.source.mapId]!.push(opening.target.mapId);
    }
  }
  for (const values of Object.values(links)) {
    values.splice(0, values.length, ...new Set(values));
    values.sort();
  }
  worldDiagnostics.links = links;
}
let deferredAudioIdle = true;
const worldAssetCache = createGameWorldAssetCache(project.worldLayout!, {
  stream,
  animated,
  npcSrc: npcSrcLazy,
}, worldDiagnostics
  ? (stats) => { worldDiagnostics.cache = stats; }
  : undefined);
const { Effects, bridge: weatherBridge } = createGameEffects(
  project.audio ?? {},
  readEntry,
  host,
  () => deferredAudioIdle,
);

// Allocation-regression switch: when false, the particle overlay is not
// mounted at all, so the QuickJS mem-walk probe can diff overlay on/off on
// the same tape window. Production builds leave the global unset.
const weatherOverlayEnabled = (globalThis as typeof globalThis & {
  __pocketTuxemonWeatherOverlay?: boolean;
}).__pocketTuxemonWeatherOverlay !== false;

// START opens the save/load menu. It is a GameView overlay: it reads and
// replaces the live session through the overlay host, independent of the
// demo menu on SELECT, and START does nothing while the demo menu is open.
// Each language replays its own tape from its own chapter saves (the
// Chinese ones are transcribed from the English mainline); a build without
// chapters for the boot language leaves SELECT dormant.
let demoMenu: GameViewDemoRuntime | null = null;
const demo: GameViewDemoConfig | undefined = hasDemoChapters(lang) ? (() => {
  // The pak entries the demo's lazy providers actually read. The selection
  // published below is computed before any I/O, so it cannot prove the
  // built game loaded the entries it declares; the read log is the I/O
  // evidence the built-game demo verification asserts
  // (tools/verify-zh-demo.ts).
  const demoReads: string[] = [];
  const demoOptions = createDemoOptions((entry) => {
    demoReads.push(entry);
    return readEntry(entry);
  }, undefined, lang);
  // Published for the built-game demo verification (tools/verify-zh-demo.ts):
  // the pak entries and chapter titles the SELECT menu was built from, so
  // the check can assert a Chinese boot selected the Chinese tape and saves
  // instead of the English ones.
  (globalThis as typeof globalThis & { __rpgkitDemoSelection?: unknown }).__rpgkitDemoSelection = {
    tapeEntry: demoOptions.demoResources.tapeEntry,
    snapshotsEntry: demoOptions.demoResources.snapshotsEntry,
    chapters: demoOptions.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
  };
  (globalThis as typeof globalThis & { __rpgkitDemoReads?: () => string[] }).__rpgkitDemoReads =
    () => [...demoReads];
  const demoConfig = createDemo(demoOptions);
  const config: GameViewDemoConfig = {
    create(host) {
      demoMenu = demoConfig.create(host);
      return demoMenu;
    },
  };
  return config;
})() : undefined;
// Whether the SELECT demo menu is currently open, for the built-game demo
// verification (the kit owns the runtime; this only reads its state).
(globalThis as typeof globalThis & { __rpgkitDemoMenuOpen?: () => boolean }).__rpgkitDemoMenuOpen = () =>
  demoMenu?.isOpen() ?? false;
// The save/load menu (START) and the language switcher (R) share one
// GameView overlay slot through the composite overlay. Each config wrapper
// also captures its runtime so the weather overlay can suspend while either
// menu is open. The language switcher is hidden on targets that cannot
// persist a choice (PSP: no localStorage, no data.fs — the PSP build is
// English-only).
const langSwitchable = canSwitchLang();
let saveMenuRuntime: GameViewDemoRuntime | null = null;
const saveMenuConfig = createSaveMenu({ suspended: () => demoMenu?.isOpen() ?? false, lang });
const baseSaveMenu: GameViewOverlayConfig = {
  create(host) {
    saveMenuRuntime = saveMenuConfig.create(host);
    return saveMenuRuntime;
  },
};
const saveMenu = worldDiagnostics
  ? withWorldDiagnostics(baseSaveMenu, worldDiagnostics)
  : baseSaveMenu;
let langMenuRuntime: GameViewDemoRuntime | null = null;
const langMenuConfig = createLangMenu(lang);
const langMenu: GameViewOverlayConfig = {
  create(host) {
    langMenuRuntime = langMenuConfig.create(host);
    return langMenuRuntime;
  },
};
const overlay = langSwitchable ? createCompositeOverlay(saveMenu, langMenu) : saveMenu;
// The boot-snapshot overlay runs first so a PSP segment build can restore a
// chapter save before the tape replay starts. Production builds leave its
// global unset and it is inert after the first frame.
const bootSnapshotOverlay = createBootSnapshotOverlay();
const overlayWithBoot: GameViewOverlayConfig = {
  create(host) {
    const boot = bootSnapshotOverlay.create(host);
    const rest = overlay.create(host);
    return {
      step(buttons, pressed) {
        const bootResult = boot.step(buttons, pressed);
        if (bootResult.consumed || bootResult.stateChanged) return bootResult;
        return rest.step(buttons, pressed);
      },
      isOpen: () => boot.isOpen() || rest.isOpen(),
      render(theme, uiText) {
        return (
          <>
            {boot.render(theme, uiText)}
            {rest.render(theme, uiText)}
          </>
        );
      },
    };
  },
};

mount(() => (
  <>
    <GameView
      immutableState
      project={project}
      maps={repository}
      extensions={extensions}
      battle={rules}
      battleScene={TuxemonBattleScene}
      scenes={scenes}
      sceneViews={{
        [NAME_INPUT_SCENE_ID]: NameInputScene,
        [TUXEMON_JOURNAL_SCENE_ID]: createTuxemonJournalScene(catalog),
        [TUXEMON_MONSTER_PICKER_SCENE_ID]: TuxemonMonsterPickerScene,
        [TUXEMON_PC_SCENE_ID]: TuxemonPcScene,
        [TUXEMON_TRADE_SCENE_ID]: createTuxemonTradeScene(catalog),
        [TUXEMON_MONSTER_SHOP_SCENE_ID]: createTuxemonMonsterShopScene(catalog),
        [TUXEMON_DAYCARE_SCENE_ID]: TuxemonDaycareScene,
      }}
      assets={assets}
      world={createWorldRenderer({ npcPreview: { sandbox: TUXEMON_PREVIEW_HOOKS } })}
      createWorldCacheDriver={(session, layout) => {
        // NPC art of the visible neighbours the session holds stays resident
        // for the neighbour preview.
        worldAssetCache.bindMaps((mapId) => session.maps.get(mapId) ?? session.preparingMaps.get(mapId)?.map);
        return createGameWorldCacheDriver(session, layout, {
          onStats: worldAssetCache.onWorldCacheStats,
          onPrefetchActivity: (active) => { deferredAudioIdle = !active; },
        });
      }}
      onMapChange={(mapId, map) => {
        frameProfileMark("map-change-assets:start");
        worldAssetCache.onMapChange(mapId, map);
        frameProfileMark("map-change-assets:end");
      }}
      onStreamStats={(_layer, stats) => {
        const worldStats = stats as WorldStreamedTerrainStats;
        if (worldDiagnostics) {
          const byLayer = worldDiagnostics.stream ?? (worldDiagnostics.stream = {});
          byLayer[_layer] = worldStats;
        }
        if (worldStats.visibleMaps) worldAssetCache.onVisibleMaps(worldStats.visibleMaps);
      }}
      onAnimatedStats={(layer, stats) => {
        if (!worldDiagnostics) return;
        const byLayer = worldDiagnostics.animated ?? (worldDiagnostics.animated = {});
        byLayer[layer] = stats;
      }}
      choiceIcons={ChoiceIconBox}
      demo={demo}
      overlay={overlayWithBoot}
      effects={Effects}
      screenPresentation={{
        fingerprint: () => "",
        effects: PortraitBackdropEffects,
      }}
      theme={TUXEMON_UI_THEME}
      textTokens={textTokens}
      hostActions={{
        autosave(host, snapshot) {
          persistAutosave(snapshot, host.session.content);
        },
      }}
    />
    {weatherOverlayEnabled && (
      <WeatherOverlay
        bridge={weatherBridge}
        suspended={() =>
          weatherOverlaySuspended(demoMenu, saveMenuRuntime)
          || (langMenuRuntime?.isOpen() ?? false)}
      />
    )}
  </>
));
gp1Mark("mount");

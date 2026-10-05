// Tuxemon event-to-rpgkit-project/v1 conversion.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadAllFileEvents,
  loadAllMaps,
  MAPS_DIR,
  readCollisionCells,
  readCollisionRegions,
  TUXEMON_SRC,
  type Cond,
  type Rule,
  type TuxEvent,
  type TuxMap,
} from "./source.ts";
import { triggerClass } from "./shapes.ts";
import {
  buildCoverageReport,
  type CoverageEntry,
  type CoverageReport,
  type Disposition,
} from "./coverage.ts";
import {
  buildOutdoorWorldIndex,
  outdoorWorldPortalId,
  type WorldImportReport,
} from "./world.ts";
import type { OutdoorWorldIndex } from "./world-schema.ts";
import { projectOutdoorWorldLayout } from "./world-layout.ts";
import {
  DAYLIGHT_STAGE_VARIABLE,
  DAYLIGHT_TARGET_VARIABLE,
  DAYLIGHT_TINT_LAYER,
  DAYLIGHT_TINT_PROFILES,
  DAYLIGHT_TWEEN_SECONDS,
} from "../battle/daylight.ts";
import {
  importTerrainSurfaceLabels,
  type TerrainSurfaceLabels,
} from "./terrain.ts";
import {
  ITEM_ICON_SHEET_ID,
  planItemIcons,
  type ItemIconPlan,
} from "./item-icons.ts";
import {
  loadWeatherTable,
  timeIsArgs,
  updateTimeArgs,
  type WeatherEntry,
} from "./time-weather.ts";
import { audioAssetIds, audioId, audioTable } from "./audio.ts";
import { pyFloatFromText } from "../battle/text-variables.ts";
import { validateSchema } from "../vendor/pocket-rpgkit/src/engine/schema-validate.ts";
import type {
  Command,
  Condition,
  Dir,
  FacingMode,
  AnimationDef,
  GameEvent,
  Item,
  JsonValue,
  MapDef,
  MoveControl,
  MoveFrequency,
  MoveSpeed,
  MoveStep,
  Page,
  PageCondition,
  Project,
  RouteTarget,
  ShopGood,
  SpriteDef,
  TextBoxLayout,
  TextBoxPosition,
  WanderBounds,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const DEFAULT_MAPS = ["spyder_bedroom", "spyder_paper_scoop", "spyder_downstairs", "spyder_paper_town"];
const PLAYER_NAME = "Red"; // mod.yaml starting_names: npc_red -> "Red"
const TUXEMON_NAME_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890.-! ".split("");
const MONSTER_RENAME_NAME_VARIABLE = "tux.rename.name";
const AREA_CELL_CAP = 64; // v1 has no event areas: expand up to this many cells

export interface ImportOptions {
  /** K1: emit one rectangular event instead of one event per covered cell. */
  areas: boolean;
  /** K1: retain player-facing trigger predicates. */
  facing: boolean;
  /** K1: emit PageCondition.all instead of derived switches/nested ifs. */
  condAll: boolean;
  /** K1: rely on per-map reset semantics for importer-owned local.* state. */
  localReset: boolean;
  /** K1: emit place commands and page initial directions for dynamic NPCs. */
  place: boolean;
  /** K1: emit cross-event lockInput/unlockInput commands. */
  inputLock: boolean;
  /** K2: target arbitrary events and emit turn/path/approach route steps. */
  routes: boolean;
  /** KM1: emit moveControl commands for char_stop/wander/speed/run/facing
   *  and place for char_position. */
  moveControl: boolean;
  /** KC1: emit extChoice commands for get_player_monster/choice_monster/
   *  choice_npc, backed by the game's party extension. */
  extChoice: boolean;
  /** P2: emit game-owned party commands, conditions and Battle Processing. */
  battle: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: Readonly<ImportOptions> = Object.freeze({
  areas: false,
  facing: false,
  condAll: false,
  localReset: false,
  place: false,
  inputLock: false,
  routes: false,
  moveControl: false,
  extChoice: false,
  battle: false,
});

export const KIT_V2_IMPORT_OPTIONS: Readonly<ImportOptions> = Object.freeze({
  areas: true,
  facing: true,
  condAll: true,
  localReset: true,
  place: true,
  inputLock: true,
  routes: true,
  moveControl: true,
  extChoice: true,
  battle: true,
});

/** The K1-only profile remains useful for focused importer regression tests. */
export const K1_IMPORT_OPTIONS: Readonly<ImportOptions> = Object.freeze({
  areas: true,
  facing: true,
  condAll: true,
  localReset: true,
  place: true,
  inputLock: true,
  routes: false,
  moveControl: false,
  extChoice: false,
  battle: false,
});

/** The playable G6 profile: all merged K1 constructs plus K2 routes. */
export const G6_IMPORT_OPTIONS: Readonly<ImportOptions> = Object.freeze({
  ...K1_IMPORT_OPTIONS,
  routes: true,
  moveControl: true,
  extChoice: true,
  battle: true,
});

const resolveOptions = (options: Partial<ImportOptions> = {}): ImportOptions => ({
  ...DEFAULT_IMPORT_OPTIONS,
  ...options,
});

type FutureCondition = Condition | { kind: "facing"; dir: Dir };
type FuturePageCondition = PageCondition & { all?: FutureCondition[] };
type FutureMoveStep = MoveStep
  | "turnTowardPlayer"
  | { turnToward: "player" | { event: string } }
  | { pathTo: { x: number; y: number } }
  | { approach: { target: "player" | { event: string }; side?: Dir; distance?: number } };
type FutureCommand = Command
  | { op: "lockInput" }
  | { op: "unlockInput" }
  | { op: "place"; target: "this" | { event: string }; x: number; y: number; dir?: Dir }
  | { op: "moveRoute"; target: "player" | "this" | { event: string }; wait?: boolean; route: { steps: FutureMoveStep[]; repeat: boolean; skippable: boolean } };
type FutureGameEvent = GameEvent & { w?: number; h?: number };

const command = (value: FutureCommand): Command => value as Command;
const gameEvent = (value: FutureGameEvent): GameEvent => value;

// ---------------------------------------------------------------------------
// sources

import {
  IMPORT_UI,
  createTextCatalog,
  loadZhUiText,
  type ImportLang,
  type TextCatalog,
} from "./l10n.ts";

// The active text catalog. en_US keeps the historical behavior; setImportLang
// swaps in the merged zh_CN catalog (upstream zh + supplement + en fallback).
let po: TextCatalog = createTextCatalog("en_US");
let activeLang: ImportLang = "en_US";

// Player-visible lines for the headless NPC-versus-NPC auto battle. Kept
// local to the importer instead of IMPORT_UI so the zh_CN catalog merge in
// importer/l10n.ts stays the single owner of translated content.
const NPC_BATTLE_TEXT: Record<ImportLang, { label: (fighter: string, foe: string) => string; resolved: string }> = {
  en_US: { label: (fighter, foe) => `[BATTLE] ${fighter} vs ${foe}`, resolved: "(auto-resolved)" },
  zh_CN: { label: (fighter, foe) => `【对战】${fighter} 对 ${foe}`, resolved: "（自动结算）" },
};

// Lookup-context recording for the zh_CN fallback report. The catalog only
// records which keys missed; these sets record where each key was looked up
// so the report can say whether a missing key is real dialog, a choice
// value, or a name lookup. Language-independent (the same events run in
// both builds), so they accumulate across the en and zh builds.
const dialogLookupKeys = new Set<string>();
const choiceLookupKeys = new Set<string>();

/** Swap the text catalog for a whole-project build. buildProject is
 *  re-entrant, so a second build with another language follows in the same
 *  process. */
export function setImportLang(lang: ImportLang): void {
  activeLang = lang;
  po = createTextCatalog(lang);
}

export function importLang(): ImportLang {
  return activeLang;
}

/** zh_CN builds only: keys that fell back to en_US, and keys absent from
 *  every catalog (sorted). */
export function importL10nGaps(): { fallbackKeys: string[]; missingKeys: string[] } {
  return {
    fallbackKeys: [...po.fallbackKeys].sort(),
    missingKeys: [...po.missingKeys].sort(),
  };
}

/** How a key absent from every catalog was used, for the fallback report. */
export type MissingKeyCategory = "dialog" | "choice" | "name";

/** Categorize a missing key by where it was looked up: real dialog
 *  (translated_dialog/char_talk), a choice option value, or a name lookup
 *  (map/NPC/monster/item names and descriptions). Battle-layer lookups are
 *  always name lookups. A key used in several contexts is reported by its
 *  most specific one (dialog > choice > name). */
export function categorizeMissingKey(key: string): MissingKeyCategory {
  if (dialogLookupKeys.has(key)) return "dialog";
  if (choiceLookupKeys.has(key)) return "choice";
  return "name";
}

/** Categorize a batch of missing keys, sorted by key. */
export function categorizeMissingKeys(keys: readonly string[]): { key: string; category: MissingKeyCategory }[] {
  return [...keys].sort().map((key) => ({ key, category: categorizeMissingKey(key) }));
}

/** The zh_CN l10n section of the import report: gaps plus per-key
 *  categories so the coverage report can say what each missing key is. */
function l10nReportSection() {
  const gaps = importL10nGaps();
  return { ...gaps, missingKeyCategories: categorizeMissingKeys(gaps.missingKeys) };
}
const allMaps = new Map(loadAllMaps().map((m) => [m.slug, m]));
const FAINT_NOTICE_SWITCH = "sys.faint_notice";
// GM1 fix 1: set by fadeout_music, cleared by play_music. Upstream clears
// current_song the moment fadeout starts, so music_playing is false while
// the audible fade is still running; the kit keeps bgmPlaying true until
// the fade completes. This flag bridges the gap without a kit change.
const MUSIC_FADING_SWITCH = "sys.music_fading";
const faintPointMaps = new Set(
  [...allMaps.values()].flatMap((map) => map.events.flatMap((event) => event.acts
    .filter((action) => action.type === "set_teleport_faint" && action.args[1])
    .map((action) => action.args[1]!.replace(/\.tmx$/, "")))),
);
// NPCs that some event fights against the player. NPC-versus-NPC battles are
// resolved by a headless battle between both parties with the saved RNG and
// record battle_last_winner, so the leather gym Points pages gated on the
// winner run.
const playerOpponents = new Set(
  [...allMaps.values()].flatMap((map) => map.events.flatMap((event) => event.acts
    .filter((action) => action.type === "start_battle" || action.type === "start_double_battle")
    .map((action) => playerOpponent(action.args))
    .filter((opponent): opponent is string => opponent !== null))),
);
// NPCs that fight only in NPC-versus-NPC battles. COV-B auto-resolves these
// with the battle rules and saved RNG and records battle_last_winner, so the
// winner slug must be a registered enum value.
const npcBattleParticipants = new Set(
  [...allMaps.values()].flatMap((map) => map.events.flatMap((event) => event.acts
    .filter((action) => action.type === "start_battle" || action.type === "start_double_battle")
    .filter((action) => playerOpponent(action.args) === null)
    .flatMap((action) => [action.args[0], action.args[1]].filter((arg): arg is string =>
      !!arg && arg !== "player")))),
);
const monsterSlugs = new Set(
  readdirSync(join(TUXEMON_SRC, "mods/tuxemon/db/monster"))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.slice(0, -5)),
);

interface SourceAnimationRow {
  file: string;
  slug: string;
  frame_x: number;
  frame_y: number;
}

const sourceAnimationDb = new Map<string, SourceAnimationRow>();
const sourceAnimationDir = join(TUXEMON_SRC, "mods/tuxemon/db/animation");
for (const file of existsSync(sourceAnimationDir) ? readdirSync(sourceAnimationDir).sort() : []) {
  if (!file.endsWith(".yaml")) continue;
  const doc = Bun.YAML.parse(readFileSync(
    join(sourceAnimationDir, file),
    "utf8",
  )) as SourceAnimationRow | SourceAnimationRow[] | null;
  for (const row of Array.isArray(doc) ? doc : doc ? [doc] : []) {
    if (typeof row.slug === "string" && typeof row.file === "string" &&
        Number.isInteger(row.frame_x) && row.frame_x > 0 &&
        Number.isInteger(row.frame_y) && row.frame_y > 0) {
      sourceAnimationDb.set(row.slug, row);
    }
  }
}

const animationDefs = new Map<string, AnimationDef>();

export interface BackdropSource {
  variant: string;
  background?: string;
  foreground?: string;
  foregroundCrop?: { x: number; y: number; w: number; h: number };
  color?: string;
  /** Lazy backdrops ship as on-demand IMG entries (data.fs / pak blob) and
   * are uploaded only when first shown, so they never enter the boot path. */
  lazy?: boolean;
}

export interface OverlaySource {
  variant: string;
  image?: string;
  color?: string;
}

/** A choice_monster row icon: the sheet rect (menu1_rect) the cooker crops
 *  and scales to the kit's 16 px icon cell. */
export interface MonsterMenuIconSource {
  sprite: string;
  sheet: string;
  crop: { x: number; y: number; w: number; h: number };
}

const backdropSources = new Map<string, BackdropSource>();
const overlaySources = new Map<string, OverlaySource>();
const appearanceSpriteDefs = new Map<string, SpriteDef>();
const SCREEN_BACKDROP_LAYER = "tux_backdrop";
const SCREEN_OVERLAY_LAYER = "tux_overlay";

function safeAssetId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function pngDimensions(path: string): { width: number; height: number } | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.byteLength < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Register a source spritesheet only when a converted command references it.
 * The duration is part of the id because Tuxemon actions override the
 * database's per-frame duration at playback time. */
function ensureMapAnimation(name: string, duration: number): string | null {
  const row = sourceAnimationDb.get(name);
  if (!row || !Number.isFinite(duration) || duration <= 0) return null;
  const sheet = `animations/${row.file}/${name}.png`;
  const dimensions = pngDimensions(join(TUXEMON_SRC, "mods/tuxemon", sheet));
  if (!dimensions || dimensions.width % row.frame_x !== 0 || dimensions.height % row.frame_y !== 0) {
    return null;
  }
  const micros = Math.round(duration * 1_000_000);
  const id = `tux_${safeAssetId(name)}_${micros}us`;
  const cols = dimensions.width / row.frame_x;
  const count = cols * (dimensions.height / row.frame_y);
  const next: AnimationDef = {
    id,
    sheet,
    frameW: row.frame_x,
    frameH: row.frame_y,
    cols,
    count,
    frameDuration: duration,
  };
  const previous = animationDefs.get(id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting animation definition ${id}`);
  }
  animationDefs.set(id, next);
  return id;
}

function ensureBubbleAnimation(name: string): string | null {
  const sheet = `gfx/bubbles/${name}.png`;
  const dimensions = pngDimensions(join(TUXEMON_SRC, "mods/tuxemon", sheet));
  if (!dimensions) return null;
  const id = `tux_bubble_${safeAssetId(name)}`;
  const next: AnimationDef = {
    id,
    sheet,
    frameW: dimensions.width,
    frameH: dimensions.height,
    cols: 1,
    count: 1,
    frameDuration: 1,
    loop: true,
  };
  const previous = animationDefs.get(id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting animation definition ${id}`);
  }
  animationDefs.set(id, next);
  return id;
}

function parseSourceColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const channels = raw.split(":").map(Number);
  if ((channels.length !== 3 && channels.length !== 4) || channels.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255
  )) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: channels[3] ?? 255 };
}

function colorHex(color: { r: number; g: number; b: number; a: number }): string {
  return `#${[color.r, color.g, color.b, color.a]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function ensureBackdrop(
  background: string,
  image: string | undefined,
  category: string | undefined,
): string | null {
  let source: Omit<BackdropSource, "variant">;
  if (background.includes(":")) {
    const color = parseSourceColor(background);
    if (!color) return null;
    source = { color: colorHex(color) };
  } else {
    const backgroundPath = `gfx/ui/background/${background}.png`;
    if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", backgroundPath))) return null;
    let foreground: string | undefined;
    if (image) {
      if (category === "image") foreground = `gfx/ui/background/${image}.png`;
      else if (category === "item" && itemDb.has(image)) foreground = `gfx/items/${image}.png`;
      else if (category === undefined) foreground = image;
      else return null;
      if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", foreground))) return null;
    }
    source = { background: backgroundPath, ...(foreground ? { foreground } : {}) };
  }
  const variant = ["bg", background, image, category]
    .filter((value): value is string => Boolean(value))
    .map(safeAssetId)
    .join("_");
  const next: BackdropSource = { variant, ...source };
  const previous = backdropSources.get(variant);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting backdrop source ${variant}`);
  }
  backdropSources.set(variant, next);
  return variant;
}

/** Monster sprite geometry, mirroring upstream's MonsterSpritesModel
 *  defaults (tuxemon/db.py): sheet gfx/sprites/battle/<slug>-sheet.png,
 *  front (0,0,64,64), menu1 (0,64,24,24), menu2 (24,64,24,24). An explicit
 *  `sprites:` section in db/monster/<slug>.yaml overrides any field. */
interface MonsterSpriteDef {
  sheet: string;
  frontRect: { x: number; y: number; w: number; h: number };
  menu1Rect: { x: number; y: number; w: number; h: number };
  menu2Rect: { x: number; y: number; w: number; h: number };
}

const monsterSpriteCache = new Map<string, MonsterSpriteDef | null>();

function monsterSpriteDef(slug: string): MonsterSpriteDef | null {
  const cached = monsterSpriteCache.get(slug);
  if (cached !== undefined) return cached;
  const readRect = (
    value: unknown,
    fallback: readonly [number, number, number, number],
  ): { x: number; y: number; w: number; h: number } => {
    if (Array.isArray(value) && value.length === 4 &&
        value.every((n) => Number.isInteger(n) && Number(n) >= 0)) {
      const [x, y, w, h] = value as number[];
      if (w > 0 && h > 0) return { x, y, w, h };
    }
    const [x, y, w, h] = fallback;
    return { x, y, w, h };
  };
  let def: MonsterSpriteDef | null = null;
  const path = join(TUXEMON_SRC, "mods/tuxemon/db/monster", `${slug}.yaml`);
  if (existsSync(path)) {
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as {
      sprites?: {
        sheet?: unknown;
        front_rect?: unknown;
        menu1_rect?: unknown;
        menu2_rect?: unknown;
      };
    } | null;
    const sprites = doc?.sprites;
    const rawSheet = typeof sprites?.sheet === "string" && sprites.sheet
      ? sprites.sheet
      : `gfx/sprites/battle/${slug}-sheet`;
    const sheet = rawSheet.endsWith(".png") ? rawSheet : `${rawSheet}.png`;
    if (existsSync(join(TUXEMON_SRC, "mods/tuxemon", sheet))) {
      def = {
        sheet,
        frontRect: readRect(sprites?.front_rect, [0, 0, 64, 64]),
        menu1Rect: readRect(sprites?.menu1_rect, [0, 64, 24, 24]),
        menu2Rect: readRect(sprites?.menu2_rect, [24, 64, 24, 24]),
      };
    }
  }
  monsterSpriteCache.set(slug, def);
  return def;
}

/** change_bg_monster: the monster's front battle sprite, centered on the
 *  blocking screen backdrop — the kit's form of upstream's
 *  MonsterImageState (background + front sprite, dialog opens on top). */
function ensureMonsterBackdrop(background: string, monster: string): string | null {
  const sprites = monsterSpriteDef(monster);
  if (!sprites) return null;
  const backgroundPath = `gfx/ui/background/${background}.png`;
  if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", backgroundPath))) return null;
  const dimensions = pngDimensions(join(TUXEMON_SRC, "mods/tuxemon", sprites.sheet));
  const { x, y, w, h } = sprites.frontRect;
  if (!dimensions || x + w > dimensions.width || y + h > dimensions.height) return null;
  const variant = ["bg", background, monster, "monster"].map(safeAssetId).join("_");
  const next: BackdropSource = {
    variant,
    background: backgroundPath,
    foreground: sprites.sheet,
    foregroundCrop: { x, y, w, h },
    lazy: true,
  };
  const previous = backdropSources.get(variant);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting backdrop source ${variant}`);
  }
  backdropSources.set(variant, next);
  return variant;
}

/** choice_monster row icon: the monster's animated menu face reduced to the
 *  kit's single static 16 px picture. Returns the registered sprite key, or
 *  null when the sheet or menu rect is unavailable (a text-only row). */
const monsterMenuIconSources = new Map<string, MonsterMenuIconSource>();

function ensureMonsterMenuIcon(slug: string): string | null {
  const sprites = monsterSpriteDef(slug);
  if (!sprites) return null;
  const dimensions = pngDimensions(join(TUXEMON_SRC, "mods/tuxemon", sprites.sheet));
  const { x, y, w, h } = sprites.menu1Rect;
  if (!dimensions || x + w > dimensions.width || y + h > dimensions.height) return null;
  const sprite = `tux_monster_menu_${slug}`;
  appearanceSpriteDefs.set(sprite, { kind: "image", src: sprites.sheet });
  const next = { sprite, sheet: sprites.sheet, crop: { x, y, w, h } };
  const previous = monsterMenuIconSources.get(sprite);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting monster menu icon ${sprite}`);
  }
  monsterMenuIconSources.set(sprite, next);
  return sprite;
}

function ensureCharacterBackdrop(background: string, character: string): string | null {
  const row = npcDb.get(character);
  const combatSheet = row?.template.combat_sheet;
  const frameW = row?.template.combat_frame_width ?? 64;
  const frameH = row?.template.combat_frame_height ?? 64;
  if (!combatSheet || !Number.isInteger(frameW) || frameW <= 0 ||
      !Number.isInteger(frameH) || frameH <= 0) return null;
  const backgroundPath = `gfx/ui/background/${background}.png`;
  const foreground = `gfx/sprites/player/${combatSheet}.png`;
  const dimensions = pngDimensions(join(TUXEMON_SRC, "mods/tuxemon", foreground));
  if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", backgroundPath)) ||
      !dimensions || dimensions.width < frameW * 2 || dimensions.height < frameH) return null;
  const variant = ["bg", background, character, "character"].map(safeAssetId).join("_");
  const next: BackdropSource = {
    variant,
    background: backgroundPath,
    foreground,
    foregroundCrop: { x: frameW, y: 0, w: frameW, h: frameH },
  };
  const previous = backdropSources.get(variant);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting backdrop source ${variant}`);
  }
  backdropSources.set(variant, next);
  return variant;
}

function ensureOverlay(raw: string): string | null {
  let source: Omit<OverlaySource, "variant">;
  if (raw.endsWith(".png")) {
    if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", raw))) return null;
    source = { image: raw };
  } else {
    const color = parseSourceColor(raw);
    if (!color) return null;
    source = { color: colorHex(color) };
  }
  const variant = `${source.image ? "image" : "color"}_${safeAssetId(raw)}`;
  const next: OverlaySource = { variant, ...source };
  const previous = overlaySources.get(variant);
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`conflicting overlay source ${variant}`);
  }
  overlaySources.set(variant, next);
  return variant;
}

/** Variable mirroring the current screen overlay variant so `check_world
 *  layer` can compare it without engine-layer read access. Clear is 0. */
const LAYER_VARIANT_VARIABLE = "v.layer_variant";

/** Variant id for a color overlay, or null for an invalid/non-color value. */
function overlayVariantFor(raw: string): string | null {
  if (raw.endsWith(".png")) return null;
  return parseSourceColor(raw) ? `color_${safeAssetId(raw)}` : null;
}

/** Enum code for a layer variant; registered by the pre-pass below. */
function layerVariantCode(variant: string): number {
  return code("layer_variant", variant);
}

function ensureAppearanceSprite(name: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  const src = `sprites/${name}.png`;
  if (!existsSync(join(TUXEMON_SRC, "mods/tuxemon", src))) return false;
  appearanceSpriteDefs.set(name, { kind: "image", src });
  return true;
}

interface NpcRow {
  slug: string;
  template: {
    sprite_name: string;
    is_static_prop?: boolean;
    combat_sheet?: string;
    combat_frame_width?: number;
    combat_frame_height?: number;
  };
  speech?: { profile?: { default?: Record<string, string | string[] | undefined> } };
  persistence?: boolean;
}
const npcDb = new Map<string, NpcRow>();
for (const f of readdirSync(join(TUXEMON_SRC, "mods/tuxemon/db/npc")).sort()) {
  const doc = Bun.YAML.parse(readFileSync(join(TUXEMON_SRC, "mods/tuxemon/db/npc", f), "utf8")) as NpcRow | NpcRow[];
  for (const row of Array.isArray(doc) ? doc : [doc]) npcDb.set(row.slug, row);
}
// NPCs that survive a map change upstream (`persistence`, default false).
const PERSISTENT_NPCS = [...npcDb.values()].filter((row) => row.persistence === true).map((row) => row.slug);
const NPC_PARTIES_CLEARED_VARIABLE = "local.tux.npc_parties_cleared";
// Emitted right before every imported transfer, so the parties go with the
// map change itself (as change_map does) and no saveable frame on the new
// map still holds the old map's NPCs. The per-map entry page below is the
// catch-all for entries that are not imported transfers (a demo warp).
const clearNpcParties = (): Command => ({ op: "ext", call: "tux.clear_npc_parties", args: { keep: [...PERSISTENT_NPCS] } });

// Upstream clears the screen overlay on every change_map (transition.py), so
// the layer_variant mirror must reset on every map entry too; otherwise a map
// entered without its own set_layer sees the previous map's color.
const resetLayerVariant = (): Command => ({
  op: "variable",
  id: LAYER_VARIANT_VARIABLE,
  set: { op: "set", value: 0 },
});

interface EconomyEntry {
  slug: string;
  price?: number;
  cost?: number;
  inventory?: number;
  level?: number;
  variables?: { key: string; value: string }[];
}
interface EconomyRow {
  slug: string;
  items?: EconomyEntry[];
  monsters?: EconomyEntry[];
}
const economyDb = new Map<string, EconomyRow>();
for (const f of readdirSync(join(TUXEMON_SRC, "mods/tuxemon/db/economy")).sort()) {
  const doc = Bun.YAML.parse(readFileSync(join(TUXEMON_SRC, "mods/tuxemon/db/economy", f), "utf8")) as EconomyRow | EconomyRow[];
  for (const row of Array.isArray(doc) ? doc : [doc]) economyDb.set(row.slug, row);
}

interface ItemRow {
  slug: string;
  cost?: number | null;
  /** Upstream art path relative to the mod root (e.g. `gfx/items/potion.png`). */
  sprite?: string;
  usable_in?: string[];
  conditions?: { type?: string; parameters?: unknown[]; operator?: string }[];
  effects?: { type?: string; parameters?: unknown[] }[];
  behaviors?: { resellable?: boolean };
  use_success?: string;
}
const itemDb = new Map<string, ItemRow>();
let itemSourceRows = 0;
for (const f of readdirSync(join(TUXEMON_SRC, "mods/tuxemon/db/item")).sort()) {
  if (!f.endsWith(".yaml")) continue;
  const doc = Bun.YAML.parse(readFileSync(join(TUXEMON_SRC, "mods/tuxemon/db/item", f), "utf8")) as ItemRow | ItemRow[];
  for (const row of Array.isArray(doc) ? doc : [doc]) {
    itemSourceRows++;
    // A handful of upstream files accidentally repeat the cream_puffs slug.
    // Tuxemon addresses items by slug, so retain the first deterministic
    // definition instead of emitting duplicate project ids.
    if (!itemDb.has(row.slug)) itemDb.set(row.slug, row);
  }
}

interface WorldDestroyItem {
  item: string;
  targetSprite: string;
  success: string;
}

/**
 * Pocket RPG Kit does not yet expose a world backpack menu. Preserve the
 * two corpus-defined non-consumable destroy tools without hard-coding maps:
 * interacting with the matching facing_sprite target uses the held tool.
 */
const worldDestroyItems: readonly WorldDestroyItem[] = [...itemDb.values()]
  .flatMap((row): WorldDestroyItem[] => {
    if (!row.usable_in?.includes("WorldState") ||
        !row.effects?.some((effect) => effect.type === "remove_entity")) return [];
    const facing = row.conditions?.find((condition) =>
      condition.type === "facing_sprite" && condition.operator !== "not"
    );
    const targetSprite = facing?.parameters?.[0];
    if (typeof targetSprite !== "string" || !targetSprite) return [];
    return [{
      item: row.slug,
      targetSprite,
      success: po.get(row.use_success ?? "") ?? row.use_success ?? IMPORT_UI[activeLang].itemRemoved(row.slug, targetSprite),
    }];
  })
  .sort((a, b) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0);

// ---------------------------------------------------------------------------
// conversion log: every action/condition met, and what happened to it

export type Fate = "T1" | "T1-lowered" | "T2-dropped" | "T3-placeholder" | "T3-dropped" | "T4-dropped" | "structural";
const log = new Map<string, { key: string; fate: Fate; count: number; note: string }>();
function note(kind: "act" | "cond" | "behav" | "trigger", type: string, fate: Fate, why: string): void {
  const key = `${kind}:${type}:${fate}`;
  const row = log.get(key);
  if (row) row.count++;
  else log.set(key, { key, fate, count: 1, note: why });
}

interface RecordedDisposition {
  disposition: Disposition;
  reason: string;
  /** Override the coverage row type (defaults to the source rule type). */
  type?: string;
}

export interface DialogLayoutCoverageReport {
  actionsWithLayout: number;
  native: number;
  dropped: number;
  parameters: {
    position: { source: number; native: number; dropped: number };
    hAlignment: { source: number; native: number; dropped: number };
    vAlignment: { source: number; native: number; dropped: number };
  };
}

function dispositionFor(fate: Fate): Disposition {
  if (fate === "T1") return "native";
  if (fate === "T1-lowered") return "degraded";
  if (fate === "T3-placeholder") return "placeholder";
  return "dropped";
}

const sourceEventKey = (event: TuxEvent): string => event.objectId === null
  ? `${event.source}:${event.kind}:${event.name}`
  : `${event.source}:object:${event.objectId}`;

class EventCoverage {
  readonly actions = new Map<Rule, RecordedDisposition>();
  readonly conditions = new Map<Cond, RecordedDisposition>();

  constructor(readonly event: TuxEvent) {}

  action(rule: Rule, fate: Fate, reason: string, type?: string): void {
    if (!rule.synthetic) this.actions.set(rule, { disposition: dispositionFor(fate), reason, ...(type ? { type } : {}) });
  }

  condition(rule: Cond, fate: Fate, reason: string): void {
    if (!rule.synthetic) this.conditions.set(rule, { disposition: dispositionFor(fate), reason });
  }

  dropAll(reason: string): void {
    for (const action of this.event.acts) {
      if (!action.synthetic) this.actions.set(action, { disposition: "dropped", reason });
    }
    for (const condition of this.event.conds) {
      if (!condition.synthetic) this.conditions.set(condition, { disposition: "dropped", reason });
    }
  }

  entries(): CoverageEntry[] {
    const missing = "conversion emitted no supported behavior";
    return [
      ...this.event.acts.filter((rule) => !rule.synthetic).map((rule) => ({
        kind: "action" as const,
        type: this.actions.get(rule)?.type ?? rule.type,
        sourceType: rule.type,
        ...(this.actions.get(rule) ?? { disposition: "dropped" as const, reason: missing }),
      })),
      ...this.event.conds.filter((rule) => !rule.synthetic).map((rule) => ({
        kind: "condition" as const,
        type: `${rule.op} ${rule.type}`,
        sourceType: rule.type,
        ...(this.conditions.get(rule) ?? { disposition: "dropped" as const, reason: missing }),
      })),
    ];
  }
}

class ConversionCoverage {
  private readonly canonical: TuxEvent[];
  private readonly canonicalKeys: Set<string>;
  private selected = new Map<string, EventCoverage>();

  constructor(events: TuxEvent[]) {
    this.canonical = events;
    this.canonicalKeys = new Set(events.map(sourceEventKey));
    if (this.canonicalKeys.size !== events.length) {
      throw new Error("source-file coverage event keys are not unique");
    }
  }

  reset(): void {
    this.selected.clear();
  }

  /** Scenario YAML is materialized on many maps. Source-file coverage must
   * not depend on which map sorts first: retain the materialization that
   * demonstrates the most supported behavior for that one source event. */
  private quality(event: EventCoverage): readonly number[] {
    const dispositions = event.entries().map((entry) => entry.disposition);
    return [
      dispositions.filter((value) => value !== "dropped").length,
      dispositions.filter((value) => value === "native").length,
      dispositions.filter((value) => value === "degraded").length,
      dispositions.filter((value) => value === "placeholder").length,
    ];
  }

  private better(candidate: EventCoverage, current: EventCoverage): boolean {
    const left = this.quality(candidate);
    const right = this.quality(current);
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i]! > right[i]!;
    }
    return false;
  }

  commit(event: EventCoverage): void {
    const key = sourceEventKey(event.event);
    if (!this.canonicalKeys.has(key)) return;
    const current = this.selected.get(key);
    if (!current || this.better(event, current)) this.selected.set(key, event);
  }

  report(): CoverageReport {
    const entries: CoverageEntry[] = [];
    for (const source of this.canonical) {
      const selected = this.selected.get(sourceEventKey(source));
      if (selected) {
        const sourceActions = source.acts.filter((rule) => !rule.synthetic).map((rule) => rule.type);
        const selectedActions = selected.event.acts.filter((rule) => !rule.synthetic).map((rule) => rule.type);
        const sourceConditions = source.conds.filter((rule) => !rule.synthetic).map((rule) => `${rule.op} ${rule.type}`);
        const selectedConditions = selected.event.conds.filter((rule) => !rule.synthetic).map((rule) => `${rule.op} ${rule.type}`);
        if (sourceActions.join("\0") !== selectedActions.join("\0") ||
            sourceConditions.join("\0") !== selectedConditions.join("\0")) {
          throw new Error(`coverage materialization differs from source event ${sourceEventKey(source)}`);
        }
        entries.push(...selected.entries());
      } else {
        const absent = new EventCoverage(source);
        absent.dropAll("source event is not materialized by any map");
        entries.push(...absent.entries());
      }
    }
    return buildCoverageReport(this.canonical.length, entries);
  }

  /** Parameter-level audit over the same canonical event materialization as
   * action coverage. A layout parameter is Native only when the selected
   * translated_dialog branch itself is Native; structurally absent events
   * remain Dropped instead of being promoted by the source-type capability. */
  dialogLayoutReport(): DialogLayoutCoverageReport {
    const report: DialogLayoutCoverageReport = {
      actionsWithLayout: 0,
      native: 0,
      dropped: 0,
      parameters: {
        position: { source: 0, native: 0, dropped: 0 },
        hAlignment: { source: 0, native: 0, dropped: 0 },
        vAlignment: { source: 0, native: 0, dropped: 0 },
      },
    };
    const count = (
      row: { source: number; native: number; dropped: number },
      native: boolean,
    ): void => {
      row.source++;
      if (native) row.native++;
      else row.dropped++;
    };
    for (const source of this.canonical) {
      const selected = this.selected.get(sourceEventKey(source));
      for (let index = 0; index < source.acts.length; index++) {
        const action = source.acts[index]!;
        if (action.synthetic || action.type !== "translated_dialog") continue;
        const fields = [Boolean(action.args[2]), Boolean(action.args[3]), Boolean(action.args[4])] as const;
        if (!fields.some(Boolean)) continue;
        const selectedAction = selected?.event.acts[index];
        const native = selected !== undefined && selectedAction !== undefined &&
          selected.actions.get(selectedAction)?.disposition === "native";
        report.actionsWithLayout++;
        if (native) report.native++;
        else report.dropped++;
        if (fields[0]) count(report.parameters.position, native);
        if (fields[1]) count(report.parameters.hAlignment, native);
        if (fields[2]) count(report.parameters.vAlignment, native);
      }
    }
    const rows = [
      { source: report.actionsWithLayout, native: report.native, dropped: report.dropped },
      ...Object.values(report.parameters),
    ];
    if (rows.some((row) => row.native + row.dropped !== row.source)) {
      throw new Error("dialog layout coverage does not balance");
    }
    return report;
  }
}

const conversionCoverage = new ConversionCoverage(loadAllFileEvents());
let activeCoverage: EventCoverage | undefined;

function noteAction(rule: Rule, type: string, fate: Fate, why: string, coverageType?: string): void {
  note("act", type, fate, why);
  activeCoverage?.action(rule, fate, why, coverageType);
}

function noteCondition(rule: Cond, type: string, fate: Fate, why: string): void {
  note("cond", type, fate, why);
  activeCoverage?.condition(rule, fate, why);
}

// ---------------------------------------------------------------------------
// variables: string values -> enum codes (global, over every map, stable)

const enumValues = new Map<string, Set<string>>();
const valuesFor = (name: string): Set<string> =>
  enumValues.get(name) ?? enumValues.set(name, new Set()).get(name)!;
const addValue = (name: string, value: string) => valuesFor(name).add(value);
const DYNAMIC_VARIABLE_WRITERS: Record<string, number> = {
  translated_dialog_choice: 1,
  choice_monster: 1,
  choice_npc: 1,
  random_integer: 0,
  set_random_variable: 0,
  copy_variable: 0,
  format_variable: 0,
  get_player_monster: 0,
  get_pending_moves: 0,
};
for (const ev of loadAllFileEvents()) {
  for (const a of ev.acts) {
    if (a.type === "set_variable") for (const p of a.args) { const i = p.indexOf(":"); addValue(i < 0 ? p : p.slice(0, i), i < 0 ? "" : p.slice(i + 1)); }
    if (a.type === "set_random_variable" && a.args[0] && a.args[1]) {
      for (const value of a.args[1].split(":")) addValue(a.args[0], value);
    }
    if (a.type === "clear_variable") for (const name of a.args) valuesFor(name);
    if (a.type === "variable_math") valuesFor(a.args[3] ?? a.args[0]!);
    if (a.type in DYNAMIC_VARIABLE_WRITERS) {
      const index = DYNAMIC_VARIABLE_WRITERS[a.type]!;
      const name = a.args[index];
      if (name) valuesFor(name);
      // get_player_monster writes a monster iid on select and the enum-coded
      // "no_choice"/"no_options" sentinels on cancel/empty party.
      if (a.type === "get_player_monster" && name) {
        addValue(name, "no_choice");
        addValue(name, "no_options");
      }
    }
    if (a.type === "translated_dialog_choice" || a.type === "choice_monster" || a.type === "choice_npc") for (const o of a.args[0]!.split(":")) addValue(a.args[1]!, o);
    if (a.type === "start_battle" || a.type === "start_double_battle") {
      const participants = [a.args[0], a.args[1] ?? "player"].filter((value): value is string => Boolean(value));
      const legacyOpponent = participants[0] === "player" ? participants[1] : participants[0];
      if (legacyOpponent) addValue("battle_last_trainer", legacyOpponent);
      const opponent = participants[0] === "player" ? participants[1]
        : participants[1] === "player" ? participants[0] : undefined;
      if (opponent) {
        addValue("battle_last_winner", opponent);
        addValue("battle_last_loser", opponent);
      }
    }
    if (a.type === "wild_encounter" && a.args[0]) addValue("battle_last_trainer", a.args[0]);
  }
  for (const c of ev.conds) {
    if (c.type === "variable_set") for (const p of c.args) {
      const i = p.indexOf(":");
      const name = i < 0 ? p : p.slice(0, i);
      valuesFor(name);
      if (i >= 0 && p.slice(i + 1) !== "") addValue(name, p.slice(i + 1));
    }
    if (c.type === "variable_is") {
      for (const value of [c.args[0], c.args[2]]) {
        if (value && !/^-?\d+(?:\.\d+)?$/.test(value)) valuesFor(value);
      }
    }
  }
}
for (const economy of economyDb.values()) {
  for (const entry of economy.items ?? []) {
    for (const condition of entry.variables ?? []) addValue(condition.key, condition.value);
  }
}
for (const map of allMaps.values()) {
  for (const event of map.events) {
    for (const action of event.acts) {
      if (action.type === "load_yaml" && action.args[0]) {
        addValue(`__loaded_yaml.${map.slug}.${action.args[0]}`, "yes");
      }
    }
  }
}
for (const destroyItem of worldDestroyItems) {
  for (const npc of npcDb.values()) {
    if (npc.template.sprite_name === destroyItem.targetSprite) addValue(npc.slug, "remove_entity");
  }
}
for (const v of ["won", "lost", "draw"]) addValue("battle_last_result", v);
addValue("battle_last_winner", "player");
addValue("battle_last_loser", "player");
// An NPC-versus-NPC battle writes its winner into battle_last_winner, its
// loser into battle_last_loser, and the loser into battle_last_trainer
// (upstream's loser handling overwrites the winner's trainer write), so both
// participants need codes in all three domains.
for (const participant of npcBattleParticipants) {
  addValue("battle_last_winner", participant);
  addValue("battle_last_loser", participant);
  addValue("battle_last_trainer", participant);
}
// Register every screen overlay variant used by set_layer / check_world so
// the layer-variant mirror variable has enum codes to compare against.
for (const map of allMaps.values()) {
  for (const event of map.events) {
    for (const action of event.acts) {
      if (action.type === "set_layer" && action.args[0]) {
        const variant = ensureOverlay(action.args[0]);
        if (variant) addValue("layer_variant", variant);
      }
    }
    for (const cond of event.conds) {
      if (cond.type === "check_world" && cond.args[0] === "layer" && cond.args[1]) {
        const variant = overlayVariantFor(cond.args[1]);
        if (variant) {
          ensureOverlay(cond.args[1]);
          addValue("layer_variant", variant);
        }
      }
    }
  }
}
const enumTable = new Map([...enumValues.entries()].map(([k, s]) => [k, [...s].sort()]));

// Variables that scripts treat as numbers (variable_math, format_variable)
// or print in dialogue (${{var:name}}) keep Python's str() of their value in
// the kit bank instead of an enum code; copy_variable joins both sides into
// the set. Their writers and readers are lowered to the tux.*_variable
// commands and the tux.variable_text condition. Any other enum writer on such
// a variable would mix the two encodings, so the import refuses it.
const TEXT_VARIABLES: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  const placeholder = /\$\{\{var:([^}]*)\}\}/g;
  const catalogs = [
    join(TUXEMON_SRC, "mods/tuxemon/l18n/en_US/LC_MESSAGES/base.po"),
    join(TUXEMON_SRC, "mods/tuxemon/l18n/zh_CN/LC_MESSAGES/base.po"),
    join(import.meta.dir, "../l10n/zh_CN/supplement.po"),
    join(import.meta.dir, "../l10n/zh_CN/overrides.po"),
  ];
  for (const path of catalogs) {
    if (!existsSync(path)) continue;
    for (const match of readFileSync(path, "utf8").matchAll(placeholder)) names.add(match[1]!);
  }
  const events = loadAllFileEvents();
  for (const ev of events) for (const a of ev.acts) {
    if (a.type === "variable_math") {
      for (const name of [a.args[0], a.args[2], a.args[3]]) {
        if (name && pyFloatFromText(name) === null) names.add(name);
      }
    }
    if (a.type === "format_variable" && a.args[0]) names.add(a.args[0]);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const ev of events) for (const a of ev.acts) {
      if (a.type !== "copy_variable" || !a.args[0] || !a.args[1]) continue;
      if (names.has(a.args[0]) !== names.has(a.args[1])) {
        names.add(a.args[0]);
        names.add(a.args[1]);
        grew = true;
      }
    }
  }
  for (const ev of events) {
    for (const a of ev.acts) {
      const index = a.type === "set_random_variable" ? 0 : DYNAMIC_VARIABLE_WRITERS[a.type];
      const name = index === undefined || a.type === "copy_variable" || a.type === "format_variable"
        ? undefined
        : a.args[index];
      if (name && names.has(name)) throw new Error(`${a.type} writes enum codes into text variable ${name}`);
    }
    for (const c of ev.conds) {
      if (c.type === "variable_is" && [c.args[0], c.args[2]].some((name) => name && names.has(name))) {
        throw new Error(`variable_is compares text variable in ${ev.name}`);
      }
    }
  }
  return names;
})();
/** Text variables are written by game-extension commands, so they exist only
 *  in builds with the battle runtime; other builds keep enum codes. */
let textVariablesOn = false;
const isTextVariable = (name: string) => textVariablesOn && TEXT_VARIABLES.has(name);
// The {x:<key>} resolver (battle/text-tokens.ts) ships with the battle runtime.
let textTokensOn = false;
const varId = (name: string) => `v.${name.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
function code(name: string, value: string): number {
  const vals = enumTable.get(name);
  const i = vals ? vals.indexOf(value) : -1;
  if (i < 0) throw new Error(`no enum code for ${name}:${value}`);
  return i + 1;
}

// ---------------------------------------------------------------------------
// conditions -> clauses

type Clause =
  | { k: "var"; id: string; op: ">=" | "<=" | "==" | "!="; value: number }
  | { k: "sw"; id: string; on: boolean }
  | { k: "item"; id: string; count: number; has: boolean }
  | { k: "gold"; amount: number; has: boolean }
  | { k: "facing"; dir: Dir }
  | { k: "worldIdle"; negate: boolean }
  | { k: "bgmPlaying"; id: string; negate: boolean }
  | { k: "native"; condition: Condition; negate: boolean }
  | { k: "ext"; call: string; args: JsonValue }
  | { k: "const"; value: boolean; reason?: string };

export function lowerCurrentStateCondition(
  op: Cond["op"],
  stateList: string,
): Extract<Condition, { kind: "worldIdle" }> | boolean {
  // Tuxemon tests the top state against an OR-list. WorldState is the only
  // listed state in which our map interpreter is runnable: battles, host
  // menus, and transfers own/freeze the world instead. The supported arm is
  // therefore exactly the kit's derived freely-controllable-world predicate.
  if (stateList.split(":").includes("WorldState")) {
    return { kind: "worldIdle", ...(op === "not" ? { negate: true } : {}) };
  }
  // There is no independently runnable map analogue for the remaining source
  // states. Preserve the old constant fold (including `not`) explicitly.
  return op === "not";
}

const npcVar = (slug: string) => `local.npc.${slug.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
const collisionVar = (map: string, key: string) =>
  `local.collision.${map.replace(/[^A-Za-z0-9_.-]/g, "_")}.${key.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
const TRIGGER_CONDS = new Set(["char_at", "char_facing", "char_moved", "button_pressed", "char_facing_tile", "char_facing_char", "player_facing_tile"]);

function cmpClause(id: string, op: string, n: number, negate: boolean): Clause {
  // Tuxemon operators -> the kit's four; negation flips.
  const table: Record<string, [">=" | "<=" | "==" | "!=", number]> = {
    less_than: ["<=", n - 1],
    less_or_equal: ["<=", n],
    greater_than: [">=", n + 1],
    greater_or_equal: [">=", n],
    equals: ["==", n],
    not_equals: ["!=", n],
  };
  let [o, v]: [">=" | "<=" | "==" | "!=", number] = table[op] ?? ["==", n];
  if (negate) {
    if (o === "<=") { o = ">="; v = v + 1; }
    else if (o === ">=") { o = "<="; v = v - 1; }
    else o = o === "==" ? "!=" : "==";
  }
  return { k: "var", id, op: o, value: v };
}

/** One Tuxemon condition -> clauses (AND), or null when it is a trigger-
 *  shape condition consumed by the trigger choice. */
function clauses(
  c: Cond,
  m: TuxMap,
  options: ImportOptions,
  surfaceLabels: Readonly<Record<string, readonly number[]>>,
): Clause[] | null {
  const a = c.args;
  const not = c.op === "not";
  const K = (value: boolean, reason?: string): Clause[] => [{
    k: "const",
    value: not ? !value : value,
    ...(reason ? { reason } : {}),
  }];
  if (TRIGGER_CONDS.has(c.type)) {
    if (c.type === "char_facing" && options.facing && c.op === "is" &&
        c.args[0] === "player" && DIRS.has(c.args[1]!)) {
      noteCondition(c, `${c.op} ${c.type}`, "T1", "K1 facing page condition");
      return [{ k: "facing", dir: c.args[1] as Dir }];
    }
    if (c.type === "char_facing" && c.op === "is" && c.args[0] === "player" &&
        DIRS.has(c.args[1]!)) {
      noteCondition(c, `${c.op} ${c.type}`, "T2-dropped", "trigger predicate unavailable in v1");
      return null;
    }
    if (c.type === "char_facing") {
      const reason = c.args[0] === "player" && !DIRS.has(c.args[1]!)
        ? `source direction '${c.args[1] ?? ""}' is not up/down/left/right and can never equal Tuxemon's Direction`
        : "live facing for this character/operator is unavailable in v1";
      noteCondition(c, `${c.op} ${c.type}`, "T2-dropped", reason);
      return K(false, `${c.op} char_facing: ${reason}`);
    }
    if (c.type === "button_pressed" && (c.op !== "is" || c.args[0] !== "INTERACT")) {
      const reason = `source button '${c.args[0] ?? ""}' is not a supported Tuxemon intention`;
      noteCondition(c, `${c.op} ${c.type}`, "T4-dropped", reason);
      return K(false, `${c.op} button_pressed: ${reason}`);
    }
    if (c.type === "char_facing_tile" && c.args[1]) {
      const reason = "surface-labelled facing tiles need a live player-cell terrain predicate";
      noteCondition(c, `${c.op} ${c.type}`, "T2-dropped", reason);
      return K(false, `${c.op} char_facing_tile: ${reason}`);
    }
    const native = c.type === "button_pressed" || c.type === "char_at" ||
      c.type === "char_moved" || c.type === "char_facing_tile";
    noteCondition(
      c,
      `${c.op} ${c.type}`,
      native ? "T1" : "T2-dropped",
      native ? "consumed by trigger selection" : "trigger predicate unavailable in v1",
    );
    return null;
  }
  switch (c.type) {
    case "variable_set": {
      if (not && a.length > 1) { noteCondition(c, "not variable_set(multi)", "T2-dropped", "NOT of several vars is an OR"); return K(true); }
      noteCondition(c, `${c.op} variable_set`, "T1", "page/if variable compare on the enum code");
      return a.map((p) => {
        const i = p.indexOf(":");
        const k = i < 0 ? p : p.slice(0, i);
        const v = i < 0 ? "" : p.slice(i + 1);
        if (isTextVariable(k) && (v !== "" || !not)) {
          // A text variable is present while it holds a string; the kit's
          // numeric compare is false for strings, so only "not set" (== 0)
          // stays native.
          return { k: "ext", call: "tux.variable_text", args: {
            variable: varId(k), ...(v === "" ? {} : { value: v }), negate: not,
          } } as Clause;
        }
        if (v === "") return { k: "var", id: varId(k), op: not ? "==" : "!=", value: 0 } as Clause;
        return { k: "var", id: varId(k), op: not ? "!=" : "==", value: code(k, v) } as Clause;
      });
    }
    case "char_exists":
      noteCondition(
        c,
        `${c.op} char_exists`,
        options.localReset ? "T1" : "T1-lowered",
        options.localReset
          ? "local.npc.<slug> presence resets on map entry"
          : "local.npc.<slug> presence variable (per-visit reset is T2)",
      );
      return [{ k: "var", id: npcVar(a[0]!), op: not ? "==" : "!=", value: 0 }];
    case "char_sprite": {
      const character = a[0];
      const sprite = a[1];
      if (!character || !sprite) {
        noteCondition(c, `${c.op} char_sprite`, "T4-dropped", "character or sprite is missing");
        return K(false);
      }
      noteCondition(c, `${c.op} char_sprite`, "T1", "KV1 effective walking appearance condition");
      return [{
        k: "native",
        condition: {
          kind: "appearance",
          target: character === "player" ? "player" : { event: `npc_${slug(character)}` },
          sprite,
        },
        negate: not,
      }];
    }
    case "check_char_parameter": {
      const [character, parameter, value] = a;
      if (character === "player" && parameter === "moving") {
        // Upstream's map-wide random-encounter guard is true while the player
        // has velocity. triggerClass lowers it to one deterministic step
        // trigger on the authored event cells.
        noteCondition(c, `${c.op} ${c.type}`, "T1-lowered",
          "moving guard lowered to a step trigger (map-wide in upstream)");
        return null;
      }
      if (options.battle && character === "player" && parameter === "name" && value !== undefined) {
        noteCondition(c, `${c.op} check_char_parameter(name)`, "T1", "live playerName exact comparison");
        return [{
          k: "ext",
          call: "tux.player_name_is",
          args: { name: value, negate: not },
        }];
      }
      const reason = character === "player" && parameter === "moving"
        ? "the extension condition context has no live player movement state"
        : `character parameter '${parameter ?? ""}' is unavailable to map conditions`;
      noteCondition(c, `${c.op} check_char_parameter`, "T2-dropped", reason);
      return K(false, `${c.op} check_char_parameter: ${reason}`);
    }
    case "char_in": {
      const reason = "the condition context has no live player cell or terrain-surface label";
      noteCondition(c, `${c.op} char_in`, "T2-dropped", reason);
      return K(false, `${c.op} char_in: ${reason}`);
    }
    case "step_tracker": {
      const [character, tracker, raw] = a;
      const milestone = Number(raw);
      if (!options.battle || character !== "player" || !tracker || raw === undefined || raw === "" || !Number.isFinite(milestone)) {
        const reason = !options.battle
          ? "step trackers live in the game extension state (P2 runtime)"
          : character !== "player"
            ? "only the player's completed tile steps reach the kit step hook"
            : "tracker id or milestone is malformed";
        noteCondition(c, `${c.op} step_tracker`, "T2-dropped", reason);
        return K(false, `${c.op} step_tracker: ${reason}`);
      }
      noteCondition(c, `${c.op} step_tracker`, "T1", "tux.step_tracker: milestone triggered and not yet shown");
      return [{ k: "ext", call: "tux.step_tracker", args: { character, tracker, milestone, negate: not } }];
    }
    case "tile_property_updated": {
      const label = a[0];
      const moverate = Number(a[1]);
      if (!label || (moverate !== 0 && moverate !== 1)) {
        noteCondition(c, `${c.op} tile_property_updated`, "T4-dropped", "only corpus moverates 0 and 1 map to passage");
        return K(false);
      }
      const cells = surfaceLabels[label] ?? [];
      if (!cells.length) {
        noteCondition(c, `${c.op} tile_property_updated`, "T1", "empty source label keeps all([]) truth semantics");
        return K(true);
      }
      const passage = moverate === 1 ? "pass" as const : null;
      const index = cells[0]!;
      // The pinned corpus starts every surfable cell at moverate 0 and its
      // only writers update the complete label atomically. Therefore every
      // reachable value is synchronized and one representative cell is
      // exactly equivalent to upstream's all(cells), without multiplying
      // shared scenario pages by thousands of conditions.
      noteCondition(
        c,
        `${c.op} tile_property_updated`,
        "T1-lowered",
        "KV1 representative cell under the corpus's atomic whole-label invariant",
      );
      return [{
        k: "native",
        condition: {
          kind: "tileProperty",
          x: index % m.width,
          y: Math.floor(index / m.width),
          passage,
        },
        negate: not,
      }];
    }
    case "battle_outcome":
      if (options.battle) {
        noteCondition(c, `${c.op} battle_outcome`, "T1", "tux.battle_outcome extension condition");
        return [{ k: "ext", call: "tux.battle_outcome", args: {
          fighter: a[0]!, outcome: a[1]!, opponent: a[2]!, negate: not,
        } }];
      }
      if (a[1] !== "won") { noteCondition(c, `${c.op} battle_outcome(${a[1]})`, "T3-placeholder", "P1 never loses"); return K(false); }
      noteCondition(c, `${c.op} battle_outcome`, "T3-placeholder", "switch bo.<opp>.won written by the battle placeholder");
      return [{ k: "sw", id: `bo.${a[2]}.won`, on: !not }];
    case "battle_outcome_count":
      if (options.battle) {
        noteCondition(c, `${c.op} battle_outcome_count`, "T1", "tux.battle_outcome_count extension condition");
        return [{ k: "ext", call: "tux.battle_outcome_count", args: {
          fighter: a[0]!, outcome: a[1]!, opponent: a[2]!, count: Number(a[3]), negate: not,
        } }];
      }
      noteCondition(c, `${c.op} battle_outcome_count`, "T3-placeholder", "variable boc.<opp>.won counted by the placeholder");
      return [cmpClause(`boc.${a[2]}.won`, "greater_or_equal", Number(a[3]), not)];
    case "char_defeated":
      if (options.battle) {
        noteCondition(c, `${c.op} char_defeated`, "T1", "tux.char_defeated reads live party HP");
        return [{ k: "ext", call: "tux.char_defeated", args: { character: a[0]!, negate: not } }];
      }
      noteCondition(c, `${c.op} char_defeated`, "T3-placeholder", "player never defeated in P1; NPC: switch defeated.<slug>");
      if (a[0] === "player") return K(false);
      return [{ k: "sw", id: `defeated.${a[0]}`, on: !not }];
    case "check_evolution":
      if (options.battle) {
        noteCondition(c, `${c.op} check_evolution`, "T1", "tux.check_evolution reads pending party progression");
        return [{ k: "ext", call: "tux.check_evolution", args: {
          character: a[0] ?? "player", negate: not,
        } }];
      }
      noteCondition(c, `${c.op} ${c.type}`, "T3-dropped", "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "party_size":
      if (options.battle) {
        noteCondition(c, `${c.op} party_size`, "T1", "tux.party_size reads the persistent party");
        return [{ k: "ext", call: "tux.party_size", args: {
          character: a[0]!, operator: a[1]!, value: Number(a[2]), negate: not,
        } }];
      }
      if (a[0] !== "player") { noteCondition(c, `${c.op} party_size(npc)`, "T3-placeholder", "NPC parties assumed non-empty"); return K(true); }
      noteCondition(c, `${c.op} party_size`, "T3-placeholder", "variable sys.party_size kept by add_monster");
      return [cmpClause("sys.party_size", a[1]!, Number(a[2]), not)];
    case "has_monster":
      if (options.battle) {
        noteCondition(c, `${c.op} has_monster`, "T1", "tux.has_monster reads the persistent party");
        return [{ k: "ext", call: "tux.has_monster", args: {
          character: a[0]!, species: a[1]!, negate: not,
        } }];
      }
      noteCondition(c, `${c.op} has_monster`, "T3-placeholder", "switch mon.<slug> set by add_monster");
      return [{ k: "sw", id: `mon.${a[1]}`, on: !not }];
    case "has_tuxepedia":
      if (options.battle && a[0] === "player" && a[1]
        && (a[2] === "seen" || a[2] === "caught")) {
        noteCondition(c, `${c.op} has_tuxepedia`, "T1", "tux.has_tuxepedia reads saved player seen/caught state");
        return [{ k: "ext", call: "tux.has_tuxepedia", args: {
          character: "player", species: a[1], status: a[2], negate: not,
        } }];
      }
      noteCondition(c, `${c.op} has_tuxepedia`, "T2-dropped", "only the player's seen/caught Tuxepedia state is imported");
      return K(false, `${c.op} has_tuxepedia: only the player's seen/caught Tuxepedia state is imported`);
    case "char_healed":
      if (options.battle && a[0] === "player") {
        noteCondition(c, `${c.op} char_healed`, "T1", "tux.char_healed reads every saved player monster's current/max HP");
        return [{ k: "ext", call: "tux.char_healed", args: {
          character: "player", negate: not,
        } }];
      }
      noteCondition(c, `${c.op} char_healed`, "T2-dropped", "only the player's full HP snapshots are imported");
      return K(false, `${c.op} char_healed: only the player's full HP snapshots are imported`);
    case "has_item": {
      if (a[0] !== "player") {
        noteCondition(c, `${c.op} has_item(npc)`, "T3-dropped", "NPC inventory is combat-only");
        return K(false);
      }
      const count = a[2] && a[3] ? Number(a[3]) + (a[2] === "greater_than" ? 1 : 0) : 1;
      noteCondition(c, `${c.op} has_item`, a[2] && !["greater_than", "greater_or_equal"].includes(a[2]) ? "T2-dropped" : "T1", "session item count >= n");
      return [{ k: "item", id: a[1]!, count, has: !not }];
    }
    case "money_is": {
      if (!/^\d+$/.test(a[2]!)) {
        noteCondition(c, `${c.op} money_is(variable)`, "T2-dropped", "gold comparison uses a variable operand");
        return K(true);
      }
      const n = Number(a[2]);
      const op = a[1];
      const atLeast = op === "greater_than" ? n + 1
        : op === "greater_or_equal" ? n
        : op === "less_or_equal" ? n + 1
        : op === "less_than" ? n
        : null;
      if (atLeast === null) {
        noteCondition(c, `${c.op} money_is(${op})`, "T2-dropped", "unsupported gold comparison");
        return K(true);
      }
      noteCondition(c, `${c.op} money_is`, "T1", "gold >= n");
      const lowerBound = op === "greater_than" || op === "greater_or_equal";
      return [{ k: "gold", amount: atLeast, has: lowerBound ? !not : not }];
    }
    case "tracker":
      noteCondition(c, `${c.op} tracker`, "T1", "switch tracker.<map> set by add_tracker");
      return [{ k: "sw", id: `tracker.${a[1]}`, on: !not }];
    case "current_state": {
      const lowered = lowerCurrentStateCondition(c.op, a[0]!);
      if (typeof lowered === "boolean") {
        noteCondition(
          c,
          `${c.op} current_state`,
          "T2-dropped",
          "combat/menu/teleporter states do not run map fibers in the kit; folded to their unreachable result",
        );
        return [{
          k: "const",
          value: lowered,
          reason: `${c.op} current_state: combat/menu/teleporter states do not run map fibers in the kit`,
        }];
      }
      noteCondition(
        c,
        `${c.op} current_state`,
        "T1",
        "WorldState arm -> derived worldIdle condition; scene/menu alternatives freeze map fibers",
      );
      return [{ k: "worldIdle", negate: lowered.negate === true }];
    }
    case "location_inside":
      noteCondition(c, `${c.op} location_inside`, "T1", "static map property, folded at import");
      return K(m.props.inside === "true");
    case "location_type":
      noteCondition(c, `${c.op} location_type`, "T1", "static map property, folded at import");
      return K(a[0]!.split(":").includes(m.props.map_type ?? "notype"));
    case "time_is":
      noteCondition(c, `${c.op} time_is`, "T1", "tux.time_is reads the saved deterministic calendar");
      return [{ k: "ext", call: "tux.time_is", args: timeIsArgs(c) }];
    case "music_playing":
      // G6: Tuxemon's music_playing is also true while paused or in combat;
      // bgmPlaying is false for a paused/ME-suspended BGM. Every map use is
      // the `not music_playing X` guard around `play_music X` on map entry,
      // where the BGM is never paused and combat is not active, so the direct
      // mapping is behavior-safe (GM0 §5 G6).
      //
      // GM1 fix 1: upstream fadeout_music clears current_song immediately,
      // so music_playing is false while the audible fade is still running.
      // The kit keeps bgmPlaying true until the fade completes, which let
      // the 37707_tower parallel page re-trigger fadeoutBgm every frame and
      // pin the fade counter at its total. fadeout_music now sets
      // MUSIC_FADING_SWITCH (cleared by play_music), and the positive form
      // excludes the fading window. The negated form keeps the historical
      // mapping: no negated guard exists on the only fadeout map, and the
      // divergence is bounded by the fade duration.
      noteCondition(c, `${c.op} music_playing`, "T1", "bgmPlaying condition (paused/combat inversion noted; safe for the map-enter idiom)");
      return [
        { k: "bgmPlaying", id: audioId(a[0]!), negate: not },
        ...(not ? [] : [{ k: "sw" as const, id: MUSIC_FADING_SWITCH, on: false }]),
      ];
    case "environment_is":
      if (options.battle) {
        noteCondition(c, `${c.op} environment_is`, "T1", "tux.environment_is reads the active battle backdrop");
        return [{ k: "ext", call: "tux.environment_is", args: { environment: a[0]!, negate: not } }];
      }
      noteCondition(c, `${c.op} environment_is`, "T3-dropped", "battle backdrop only");
      return K(false);
    case "kennel":
      if (options.battle && a[0] && a[1] && ["visible", "hidden", "exist"].includes(a[2] ?? "")) {
        noteCondition(c, `${c.op} kennel`, "T1", "tux.kennel reads the saved player boxes");
        return [{ k: "ext", call: "tux.kennel", args: {
          character: a[0], kennel: a[1], option: a[2]!, negate: not,
        } }];
      }
      noteCondition(c, `${c.op} kennel`, "T3-dropped", options.battle ? "unknown kennel option: fixed answer" : "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "has_kennel":
      if (options.battle && a[0] && a[1] && a[2] && /^\d+$/.test(a[3] ?? "")) {
        noteCondition(c, `${c.op} has_kennel`, "T1", "tux.has_kennel counts one saved player box; a missing box fails both forms");
        return [{ k: "ext", call: "tux.has_kennel", args: {
          character: a[0], kennel: a[1], operator: a[2], value: Number(a[3]), negate: not,
        } }];
      }
      noteCondition(c, `${c.op} has_kennel`, "T3-dropped", options.battle ? "malformed box count: fixed answer" : "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "party_infected":
      if (options.battle) {
        noteCondition(c, `${c.op} party_infected`, "T1", "tux.party_infected counts infected party monsters (all/some/none)");
        return [{ k: "ext", call: "tux.party_infected", args: {
          character: a[0]!, plague: a[1]!, value: a[2]!, negate: not,
        } }];
      }
      noteCondition(c, `${c.op} party_infected`, "T3-placeholder", "no plague in P1: none=true");
      return K(a[2] === "none");
    case "check_party_parameter":
      if (options.battle) {
        noteCondition(c, `${c.op} check_party_parameter`, "T1", "tux.check_party_parameter counts party members by attribute equality");
        return [{ k: "ext", call: "tux.check_party_parameter", args: {
          character: a[0]!, attribute: a[1]!, value: a[2]!, operator: a[3]!, times: Number(a[4]), negate: not,
        } }];
      }
      noteCondition(c, `${c.op} ${c.type}`, "T3-dropped", "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "check_max_tech":
      if (options.battle) {
        // Upstream also stores the matching monster list in
        // event_data["check_max_tech"], but its only reader is
        // get_pending_moves (the combat-menu move-replacement flow), which
        // is not modelled, and both corpus use sites are guarded by
        // MainCombatMenuState (also unmodelled). The side effect is
        // therefore provably unconsumed, so the boolean is Native.
        noteCondition(c, `${c.op} check_max_tech`, "T1", "tux.check_max_tech flags a monster past its species move cap (matching-list side effect unconsumed: only reader is the unmodelled get_pending_moves combat-menu flow)");
        return [{ k: "ext", call: "tux.check_max_tech", args: {
          character: a[0] ?? "player", ...(a[1] ? { number: Number(a[1]) } : {}), negate: not,
        } }];
      }
      noteCondition(c, `${c.op} ${c.type}`, "T3-dropped", "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "bill_is":
      if (options.battle) {
        noteCondition(c, `${c.op} bill_is`, "T1", "tux.bill_is compares a bill amount (missing/zero bill is false)");
        return [{ k: "ext", call: "tux.bill_is", args: {
          character: a[0]!, bill: a[1]!, operator: a[2]!, amount: Number(a[3]), negate: not,
        } }];
      }
      noteCondition(c, `${c.op} ${c.type}`, "T3-dropped", "monster/party/meta state unknown to P1: fixed answer");
      return K(false);
    case "check_world": {
      if (a[0] === "layer") {
        if (a[1] === undefined) {
          noteCondition(c, `${c.op} check_world`, "T1", "layer check with no value is always true upstream");
          return K(true);
        }
        const variant = overlayVariantFor(a[1]);
        if (!variant) {
          noteCondition(c, `${c.op} check_world`, "T4-dropped", "layer color is invalid");
          return K(false);
        }
        noteCondition(c, `${c.op} check_world`, "T1", "compares the tracked screen overlay variant");
        return [cmpClause(LAYER_VARIANT_VARIABLE, "equals", layerVariantCode(variant), not)];
      }
      // bubble: the kit tracks balloons as transient visuals with no queryable
      // state, and no corpus use exists; fold to the same answer a missing
      // bubble would give upstream.
      noteCondition(c, `${c.op} check_world(bubble)`, "T1-lowered", "no persistent bubble state to query; folded");
      return K(not);
    }
    default:
      noteCondition(c, `${c.op} ${c.type}`, "T3-dropped", "monster/party/meta state unknown to P1: fixed answer");
      return K(
        ["cooldown_days"].includes(c.type),
        `${c.op} ${c.type}: no imported runtime state or predicate`,
      );
  }
}

function toIf(cl: Clause): { cond: Condition; negate: boolean } {
  switch (cl.k) {
    case "var": return { cond: { kind: "variable", id: cl.id, op: cl.op, value: cl.value }, negate: false };
    case "sw": return { cond: { kind: "switch", id: cl.id, value: cl.on }, negate: false };
    case "item": return { cond: { kind: "item", id: cl.id, count: cl.count }, negate: !cl.has };
    case "gold": return { cond: { kind: "gold", amount: cl.amount }, negate: !cl.has };
    case "facing": return {
      cond: { kind: "facing", dir: cl.dir } as unknown as Condition,
      negate: false,
    };
    case "worldIdle": return {
      cond: { kind: "worldIdle", ...(cl.negate ? { negate: true } : {}) },
      negate: false,
    };
    case "bgmPlaying": return {
      cond: { kind: "bgmPlaying", id: cl.id, ...(cl.negate ? { negate: true } : {}) },
      negate: false,
    };
    case "native": return { cond: cl.condition, negate: cl.negate };
    case "ext": return { cond: { kind: "ext", call: cl.call, args: cl.args }, negate: false };
    case "const": throw new Error("const clause");
  }
}

/** Map pages are selected before their terminal time ticker runs. Projecting
 * one reference tick makes the selected pages and the clock committed later
 * in that same reducer tick agree exactly at hour/stage boundaries. Guards
 * inside an already-running fiber use the committed clock and keep offset 0. */
function pageTickCondition(condition: Condition): Condition {
  if (condition.kind !== "ext" || condition.call !== "tux.time_is"
    || condition.args === null || typeof condition.args !== "object"
    || Array.isArray(condition.args)) return condition;
  return {
    ...condition,
    args: { ...condition.args, tickOffset: 1 },
  };
}

/** Wrap commands in nested ifs, one per clause (AND). */
function guard(cls: Clause[], body: Command[]): Command[] {
  let out = body;
  for (const cl of [...cls].reverse()) {
    const { cond, negate } = toIf(cl);
    out = [negate ? { op: "if", if: cond, then: [], else: out } : { op: "if", if: cond, then: out }];
  }
  return out;
}

/** Split clauses into the one v1 PageCondition can carry and the rest. */
function pageCondition(
  cls: Clause[],
  options: ImportOptions,
): { cond?: FuturePageCondition; rest: Clause[] } {
  if (options.condAll && cls.length) {
    const converted: FutureCondition[] = [];
    let convertible = true;
    for (const cl of cls) {
      if (cl.k === "const") {
        convertible = false;
        break;
      }
      const { cond, negate } = toIf(cl);
      if (negate) {
        convertible = false;
        break;
      }
      converted.push(pageTickCondition(cond) as FutureCondition);
    }
    if (convertible && converted.length) {
      return { cond: { all: converted }, rest: [] };
    }
  }
  const cond: PageCondition = {};
  const rest: Clause[] = [];
  const facing: FutureCondition[] = [];
  for (const cl of cls) {
    if (cl.k === "facing" && options.facing) facing.push({ kind: "facing", dir: cl.dir });
    else if (cl.k === "var" && !cond.variable) cond.variable = { id: cl.id, op: cl.op, value: cl.value };
    else if (cl.k === "sw" && cl.on && cond.switch === undefined) cond.switch = cl.id;
    else if (cl.k === "item" && cl.has && cl.count === 1 && cond.item === undefined) cond.item = cl.id;
    else rest.push(cl);
  }
  const future = cond as FuturePageCondition;
  if (facing.length) future.all = facing;
  return { cond: Object.keys(future).length ? future : undefined, rest };
}

// ---------------------------------------------------------------------------
// text

function wrap(text: string, width = 52): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (let w = word; w.length; ) {
        const piece = w.length > width ? w.slice(0, width) : w;
        w = w.slice(piece.length);
        if (!cur) cur = piece;
        else if (cur.length + 1 + piece.length <= width) cur += " " + piece;
        else { lines.push(cur); cur = piece; }
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [" "];
}

function format(s: string, m: TuxMap): string {
  return s
    .replace(/\$\{\{name\}\}/g, "{name}")
    .replace(/\$\{\{NAME\}\}/g, PLAYER_NAME.toUpperCase())
    .replace(/\$\{\{currency\}\}/g, "$")
    .replace(/\$\{\{map_name\}\}/g, po.get(m.props.slug ?? m.slug) ?? m.slug)
    .replace(/\$\{\{(north|south|east|west)\}\}/g, (_x, d: string) => po.get(m.props[d] ?? "") ?? m.props[d] ?? "")
    .replace(/\$\{\{var:([^}]*)\}\}/g, (token, name: string) => isTextVariable(name) ? `{v:${varId(name)}}` : token)
    .replace(/\$\{\{today\}\}/g, () => textTokensOn ? "{x:today}" : "???")
    .replace(/\$\{\{map_desc\}\}/g, () => textTokensOn ? "{x:map_desc}" : "???")
    .replace(/\$\{\{monster_0_name\}\}/g, () => textTokensOn ? "{x:monster_0_name}" : "???")
    .replace(/\$\{\{monster_0_level\}\}/g, () => textTokensOn ? "{x:monster_0_level}" : "???")
    .replace(/\$\{\{money_formatted\}\}/g, () => textTokensOn ? "{x:money}" : "???")
    .replace(/\$\{\{[^}]*\}\}/g, "???");
}

/** A translation key -> text boxes: pages split at "\n" (Tuxemon's
 *  paginator), each page word-wrapped to 52 columns and cut into <=4-line
 *  boxes (the kit's text command limits). */
const DIALOG_POSITIONS: Readonly<Record<string, TextBoxPosition>> = Object.freeze({
  top: "top",
  center: "center",
  bottom: "bottom",
  topleft: "topLeft",
  topright: "topRight",
  bottomleft: "bottomLeft",
  bottomright: "bottomRight",
  left: "left",
  right: "right",
});
const DIALOG_H_ALIGN = new Set(["left", "center", "right"] as const);
const DIALOG_V_ALIGN = new Set(["top", "center", "bottom"] as const);

/** Translate Tuxemon's dialog enum spellings to the kit's optional layout.
 * Invalid values follow upstream safe_enum_value and fall back to defaults.
 * Defaults stay absent so content without layout parameters remains byte-for-
 * byte identical. */
export function dialogLayout(args: readonly string[]): TextBoxLayout {
  const layout: TextBoxLayout = {};
  const position = DIALOG_POSITIONS[args[2] ?? ""] ?? "bottom";
  if (position !== "bottom") layout.position = position;
  const align = DIALOG_H_ALIGN.has(args[3] as "left" | "center" | "right")
    ? args[3] as "left" | "center" | "right"
    : "left";
  if (align !== "left") layout.align = align;
  const valign = DIALOG_V_ALIGN.has(args[4] as "top" | "center" | "bottom")
    ? args[4] as "top" | "center" | "bottom"
    : "top";
  if (valign !== "top") layout.valign = valign;
  return layout;
}

function dialog(key: string, m: TuxMap, layout: TextBoxLayout = {}): Command[] {
  dialogLookupKeys.add(key);
  const raw = po.get(key);
  if (raw === undefined) { note("act", "translated_dialog(missing key)", "T4-dropped", "msgid absent from en_US"); return [{ op: "text", lines: [key.slice(0, 52)], ...layout }]; }
  const out: Command[] = [];
  for (const page of format(raw, m).replace(/\\n/g, "\n").split("\n").map((p) => p.trim()).filter(Boolean)) {
    const lines = wrap(page);
    for (let i = 0; i < lines.length; i += 4) out.push({ op: "text", lines: lines.slice(i, i + 4), ...layout });
  }
  return out.length ? out : [{ op: "text", lines: [" "], ...layout }];
}

function enumChoice(options: readonly string[], variable: string): Command {
  const make = (remaining: readonly string[]): Command => {
    const take = remaining.length <= 4 ? remaining.length : 3;
    const page: { text: string; commands: Command[] }[] = remaining.slice(0, take).map((option) => ({
      text: (choiceLookupKeys.add(option), po.get(option) ?? option).slice(0, 24) || option.slice(0, 24),
      commands: [{
        op: "variable" as const,
        id: varId(variable),
        set: { op: "set" as const, value: code(variable, option) },
      }],
    }));
    if (take < remaining.length) {
      page.push({ text: IMPORT_UI[activeLang].nextPage, commands: [make(remaining.slice(take))] });
    }
    return { op: "choices", prompt: "", options: page };
  };
  return make(options);
}

const npcName = (slug: string) => (po.get(slug) ?? slug).slice(0, 40);

/** Upstream translates monster/NPC slugs through the .po catalog; fall back
 *  to a titled slug for keys the catalog does not carry. */
const titleCase = (slug: string) => slug
  .split("_")
  .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
  .join(" ");

/** Resolve a Tuxemon character argument to a kit route target. Missing map
 *  events are a runtime no-op in the kit, matching moveRoute resolution. */
function charTarget(who: string, isSelf: boolean): RouteTarget {
  if (who === "player") return "player";
  if (isSelf) return "this";
  return { event: `npc_${slug(who)}` };
}

/** Tuxemon moverate (tiles/sec, walkrate 3.75, run 7.35) -> the kit's MV
 *  exponential speed grade 1..6 (grade 5 = 8 ticks/tile at 60 Hz). The
 *  grade scale is 2x per step, so the nearest grade is picked in log space. */
function speedGrade(rate: number): MoveSpeed {
  const grade = Math.round(5 + Math.log2(rate / 7.5));
  return Math.max(1, Math.min(6, grade)) as MoveSpeed;
}

/** Tuxemon wander cadence (seconds between decisions, default 1.0) -> the
 *  kit's MV frequency grade 1..5 (grade n waits 30*(5-n) 60 Hz ticks). */
function frequencyGrade(seconds: number): MoveFrequency {
  const grade = Math.round(5 - 2 * seconds);
  return Math.max(1, Math.min(5, grade)) as MoveFrequency;
}

/** Numeric monster fields get_player_monster filters with an operator. */
const MONSTER_NUMERIC_FIELDS = new Set([
  "level", "weight", "height", "max_hp", "current_hp",
  "armour", "dodge", "melee", "ranged", "speed",
]);

/** Bake a get_player_monster filter into the extChoice/party_match args.
 *  String fields compare equality; numeric fields carry an operator. */
function partyFilter(g: readonly string[]): { field: string; value: string | number; op?: string }[] {
  const field = g[1];
  if (!field) return [];
  if (MONSTER_NUMERIC_FIELDS.has(field)) {
    const op = g[2];
    const extra = g[3];
    if (op !== undefined && extra !== undefined && extra !== "" && Number.isFinite(Number(extra))) {
      return [{ field, op, value: Number(extra) }];
    }
    // Upstream skips the comparison and matches nothing without a value.
    return [{ field: "__never__", value: "" }];
  }
  return [{ field, value: g[2] ?? "" }];
}

// ---------------------------------------------------------------------------
// actions -> commands

const DIRS = new Set(["up", "down", "left", "right"]);
const RACE_APPEARANCE_SPRITES = new Set([
  "adventurer",
  "adventurerblack",
  "brownheroine_brown",
  "enbyasian",
  "heroine",
  "penguin",
]);
const FACE: Record<string, MoveStep> = { up: "faceUp", down: "faceDown", left: "faceLeft", right: "faceRight" };
const MOVE: Record<string, MoveStep> = { up: "moveUp", down: "moveDown", left: "moveLeft", right: "moveRight" };
const items = new Map<string, Item>();
const transferRepairs: TransferRepair[] = [];
const transferCollision = new Map<string, Set<string>>();
const INSTANT = new Set(["set_variable", "clear_variable", "add_item", "add_tracker", "create_npc", "remove_npc", "modify_money", "set_teleport_faint", "set_monster_health", "set_monster_status", "unlock_controls", "lock_controls", "park_experience", "remove_step_tracker", "set_layer"]);

function importedItem(id: string): Item {
  const row = itemDb.get(id);
  const price = typeof row?.cost === "number" && Number.isSafeInteger(row.cost) && row.cost >= 0
    ? row.cost
    : 0;
  return {
    id,
    name: (po.get(id) ?? id).slice(0, 24),
    // Replaced by the item-icon plan below once the full catalog is known.
    sprite: "tux.0",
    usable: row?.usable_in?.includes("WorldState") ?? false,
    price,
    sellable: row?.behaviors?.resellable === true,
  };
}

function ensureItem(id: string): void {
  if (!items.has(id)) items.set(id, importedItem(id));
}

const TRANSFER_NEIGHBORS = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
] as const;

function transferCellIsWalkable(map: TuxMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const blocked = transferCollision.get(map.slug) ?? (() => {
    const cells = readCollisionCells(join(MAPS_DIR, `${map.slug}.tmx`));
    transferCollision.set(map.slug, cells);
    return cells;
  })();
  if (blocked.has(`${x},${y}`)) return false;
  return TRANSFER_NEIGHBORS.some(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    return nx >= 0 && ny >= 0 && nx < map.width && ny < map.height &&
      !blocked.has(`${nx},${ny}`);
  });
}

/** Geometric four-neighbour BFS from a clamped upstream coordinate. The
 * search crosses blocked cells while looking for the nearest usable landing;
 * collision connectivity cannot be assumed when the starting point itself is
 * bad. Neighbour order is fixed for byte-stable tie breaking. */
function nearestWalkableTransferCell(map: TuxMap, startX: number, startY: number): { x: number; y: number } {
  const queue: { x: number; y: number }[] = [{ x: startX, y: startY }];
  const seen = new Set([`${startX},${startY}`]);
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (transferCellIsWalkable(map, cell.x, cell.y)) return cell;
    for (const [dx, dy] of TRANSFER_NEIGHBORS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      const key = `${x},${y}`;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height || seen.has(key)) continue;
      seen.add(key);
      queue.push({ x, y });
    }
  }
  throw new Error(`map ${map.slug} has no walkable transfer landing`);
}

interface Ctx {
  m: TuxMap;
  options: ImportOptions;
  economies: ReadonlyMap<string, string>;
  surfaceLabels: Readonly<Record<string, readonly number[]>>;
  /** Source event retained only long enough to attach stable world-opening
   * provenance to its own top-level transition_teleport action. */
  sourceEvent?: TuxEvent;
  seamlessPortalIds: ReadonlySet<string>;
  /** the NPC slug whose event runs these commands (talk pages), if any */
  self?: string;
}

function portalIdForAction(ctx: Readonly<Ctx>, action: Rule): string | null {
  const event = ctx.sourceEvent;
  if (!event || event.origin !== "tmx") return null;
  const actionIndex = event.acts.indexOf(action);
  const eventIndex = ctx.m.events.indexOf(event);
  if (actionIndex < 0 || eventIndex < 0) return null;
  return outdoorWorldPortalId(ctx.m.slug, event, eventIndex, actionIndex);
}

function shopPlaceholder(npc: string, menu: string, economySlug: string | undefined): Command[] {
  const ui = IMPORT_UI[activeLang];
  const economy = economySlug ? economyDb.get(economySlug) : undefined;
  const wantsMonsters = menu.includes("monster");
  const stock = wantsMonsters ? economy?.monsters : economy?.items;
  const shown = (stock ?? []).slice(0, 4).map((entry) => {
    const name = po.get(entry.slug) ?? entry.slug.replaceAll("_", " ");
    return `${name}${entry.price === undefined ? "" : ` $${entry.price}`}`;
  });
  const remainder = Math.max(0, (stock?.length ?? 0) - shown.length);
  const summary = shown.length
    ? ui.shopStock(shown.join(", ") + (remainder ? ui.shopMore(remainder) : ""))
    : economy ? ui.shopEmpty : ui.shopStock(ui.shopEconomyUnavailable);
  const lines = [
    `${ui.shopLabel(npcName(npc))} — ${ui.shopMenu[menu] ?? menu}`,
    summary,
    ui.shopPlaceholderNote,
  ].flatMap((line) => wrap(line));
  const commands: Command[] = [];
  for (let i = 0; i < lines.length; i += 4) commands.push({ op: "text", lines: lines.slice(i, i + 4) });
  return commands;
}

function economyGoodCondition(entry: EconomyEntry): PageCondition | undefined {
  const conditions: Condition[] = (entry.variables ?? []).map((condition) => ({
    kind: "variable",
    id: varId(condition.key),
    op: "==",
    value: code(condition.key, condition.value),
  }));
  return conditions.length ? { all: conditions } : undefined;
}

function itemShop(economy: EconomyRow): Command {
  const goods: ShopGood[] = (economy.items ?? []).map((entry) => {
    ensureItem(entry.slug);
    const condition = economyGoodCondition(entry);
    const finiteStock = typeof entry.inventory === "number" &&
      Number.isSafeInteger(entry.inventory) && entry.inventory >= 0;
    return {
      item: entry.slug,
      ...(typeof entry.price === "number" ? { price: entry.price } : {}),
      ...(typeof entry.cost === "number" ? { sellPrice: entry.cost } : {}),
      ...(finiteStock ? { stock: entry.inventory } : {}),
      ...(condition ? { condition } : {}),
    };
  });
  return { op: "shop", id: economy.slug, goods, sell: true, sellList: "hide" };
}

const poText = (key: string, fallback?: string): string | undefined => po.get(key)?.replaceAll("\\n", " ") ?? fallback;

function labelArgs(entries: Record<string, string | undefined>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out;
}

/** Upstream `parse_flag`: true/1/yes (case-insensitive) is true. */
const parseFlag = (value: string | undefined): boolean =>
  value !== undefined && ["true", "1", "yes"].includes(value.trim().toLowerCase());

/** Box display names come from the translated box id (upstream T.translate). */
const STORAGE_BOX_IDS = ["Kennel", "quarantine"];

function pcScene(): Command {
  const boxNames: Record<string, JsonValue> = {};
  for (const id of STORAGE_BOX_IDS) boxNames[id] = poText(id, id)!;
  return {
    op: "scene",
    id: "tux.pc",
    args: {
      labels: labelArgs({
        pickUp: poText("menu_storage"),
        dropOff: poText("menu_dropoff"),
        logOff: poText("log_off"),
        pick: poText("pick_up"),
        moveTo: poText("move_to_kennel"),
        yes: poText("yes"),
        no: poText("no"),
        empty: poText("menu_storage_empty_kennel"),
        full: poText("menu_storage_full_kennel"),
        added: poText("menu_storage_take_monster"),
        releaseConfirm: poText("release_confirmation"),
        released: poText("tuxemon_released"),
      }),
      boxNames,
    },
  } as Command;
}

function daycareScene(): Command {
  return {
    op: "scene",
    id: "tux.daycare",
    args: {
      labels: labelArgs({
        summary: poText("menu_daycare_summary"),
        parents: poText("menu_daycare_parents"),
        empty: poText("menu_daycare_empty"),
        mode: poText("menu_daycare_mode"),
        thanks: poText("menu_daycare_thanks"),
        add: poText("menu_daycare_add"),
        withdraw: poText("menu_daycare_withdraw"),
        collect: poText("menu_daycare_collect"),
        modeTraining: poText("menu_daycare_mode_training"),
        modeBreeding: poText("menu_daycare_mode_breeding"),
        modeIncompatible: poText("menu_daycare_mode_incompatible"),
        modeEmpty: poText("menu_daycare_mode_empty"),
        training: poText("menu_daycare_training"),
        expTotal: poText("menu_daycare_exp_total"),
        costTotal: poText("menu_daycare_cost_total"),
        expPerStep: poText("menu_daycare_exp_per_step"),
        costPerStep: poText("menu_daycare_cost_per_step"),
        expPerStepTotal: poText("menu_daycare_exp_per_step_total"),
        costPerStepTotal: poText("menu_daycare_cost_per_step_total"),
        trainingSingle: poText("menu_daycare_training_active_single"),
        trainingDouble: poText("menu_daycare_training_active_double"),
        trainingInactive: poText("menu_daycare_training_inactive"),
        breeding: poText("menu_daycare_breeding"),
        progress: poText("menu_daycare_progress"),
        ready: poText("menu_daycare_ready"),
        halfway: poText("menu_daycare_halfway"),
        notReady: poText("menu_daycare_not_ready"),
        noBreeding: poText("menu_daycare_no_breeding"),
        full: poText("menu_storage_full_kennel"),
        select: poText("menu_select"),
        back: poText("menu_back"),
        upKey: poText("menu_up_key"),
        downKey: poText("menu_down_key"),
        leftKey: poText("menu_left_key"),
        rightKey: poText("menu_right_key"),
        primaryKey: poText("menu_primary_select_key"),
        secondaryKey: poText("menu_secondary_select_key"),
        male: poText("gender_male"),
        female: poText("gender_female"),
        neuter: poText("gender_neuter"),
      }),
    },
  } as Command;
}

/** Monster stock of one economy; upstream defaults inventory to 1. Entries
 *  gated by economy `variables` are not representable in the scene. */
function monsterShopScene(economy: EconomyRow): Command | null {
  const entries = economy.monsters ?? [];
  if (entries.length === 0 || entries.some((entry) => (entry.variables?.length ?? 0) > 0
    || !monsterSlugs.has(entry.slug) || typeof entry.price !== "number")) return null;
  return {
    op: "scene",
    id: "tux.monsterShop",
    args: {
      economy: economy.slug,
      entries: entries.map((entry) => ({
        slug: entry.slug,
        price: entry.price!,
        level: entry.level ?? 1,
        stock: typeof entry.inventory === "number" ? entry.inventory : 1,
      })),
      labels: labelArgs({
        buy: poText("buy"),
        tooExpensive: poText("shop_buy_too_expensive"),
        soldOut: poText("shop_buy_soldout"),
      }),
    },
  } as Command;
}

function battlePlaceholder(opp: string, reason: string = IMPORT_UI[activeLang].battlePlaceholderReason): Command[] {
  const ui = IMPORT_UI[activeLang];
  const body: Command[] = [
    { op: "text", lines: [ui.battleLabel(npcName(opp)).slice(0, 52), ui.paren(reason).slice(0, 52)] },
    { op: "switch", id: `bo.${opp}.won`, value: true },
    { op: "switch", id: `defeated.${opp}`, value: true },
    { op: "variable", id: `boc.${opp}.won`, set: { op: "add", value: 1 } },
    { op: "variable", id: varId("battle_last_result"), set: { op: "set", value: code("battle_last_result", "won") } },
    { op: "variable", id: varId("battle_last_winner"), set: { op: "set", value: code("battle_last_winner", "player") } },
    { op: "variable", id: varId("battle_last_trainer"), set: { op: "set", value: code("battle_last_trainer", opp) } },
  ];
  // Tuxemon skips an illegal battle (empty party) and the event goes on.
  return [{ op: "if", if: { kind: "variable", id: "sys.party_size", op: ">=", value: 1 }, then: body }];
}

interface InlineBattlePartyMember {
  species: string;
  level: number;
  experienceModifier: number;
  moneyModifier: number;
}

function playerOpponent(args: readonly string[]): string | null {
  const first = args[0];
  const second = args[1] ?? "player";
  if (first === "player" && second && second !== "player") return second;
  if (second === "player" && first && first !== "player") return first;
  return null;
}

/** Commands that address a character's live monsters by iid or party slot.
 *  When an event uses any of them, its NPC add_monster calls must stay live
 *  (staged into npcParties by tux.add_monster) instead of being folded into
 *  the battle setup, so the mutations reach the monsters the battle uses. */
const LIVE_PARTY_COMMANDS = new Set([
  "get_party_monster",
  "set_monster_attribute",
  "add_tech",
  "char_plague",
]);

/** Fold literal NPC party construction into the next same-event trainer
 * battle. Variable-backed monsters stay as extension commands because they
 * must resolve against live story variables. Events that inspect or mutate
 * the live party (LIVE_PARTY_COMMANDS) are never folded: the staged party
 * keeps every monster iid-addressable, matching upstream's live NPC party. */
function foldedTrainerParties(acts: readonly Rule[]): {
  folded: Set<number>;
  parties: Map<number, InlineBattlePartyMember[]>;
} {
  const folded = new Set<number>();
  const parties = new Map<number, InlineBattlePartyMember[]>();
  if (acts.some((action) => LIVE_PARTY_COMMANDS.has(action.type))) {
    return { folded, parties };
  }
  const pending = new Map<string, { index: number; member: InlineBattlePartyMember }[]>();
  for (let index = 0; index < acts.length; index++) {
    const action = acts[index]!;
    if (action.type === "add_monster") {
      const [species, rawLevel, rawCharacter, rawExperience, rawMoney] = action.args;
      const character = rawCharacter || "player";
      if (character !== "player" && species && monsterSlugs.has(species)) {
        const rows = pending.get(character) ?? [];
        rows.push({
          index,
          member: {
            species,
            level: Number(rawLevel),
            experienceModifier: rawExperience === undefined ? 1 : Number(rawExperience),
            moneyModifier: rawMoney === undefined ? 0 : Number(rawMoney),
          },
        });
        pending.set(character, rows);
      }
    } else if (action.type === "start_battle" || action.type === "start_double_battle") {
      const opponent = playerOpponent(action.args);
      if (!opponent) continue;
      const rows = pending.get(opponent) ?? [];
      if (rows.length) {
        parties.set(index, rows.map((row) => row.member));
        for (const row of rows) folded.add(row.index);
        pending.delete(opponent);
      }
    }
  }
  return { folded, parties };
}

function monsterSpeciesArg(raw: string): JsonValue {
  if (monsterSlugs.has(raw)) return raw;
  return { variable: varId(raw), values: enumTable.get(raw) ?? [] };
}

function numeric(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function convertActions(acts: readonly Rule[], ctx: Ctx): Command[] {
  const out: Command[] = [];
  const foldedParties = ctx.options.battle
    ? foldedTrainerParties(acts)
    : { folded: new Set<number>(), parties: new Map<number, InlineBattlePartyMember[]>() };
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    const g = a.args;
    const isSelf = (slug?: string) => slug !== undefined && slug === ctx.self;
    switch (a.type) {
      case "translated_dialog":
        if (i > 0 && acts[i - 1]!.type === "teleport_faint" && g[0] === "heal_before_leave") {
          noteAction(a, a.type, "T1-lowered", "post-transfer faint notice runs on the destination map");
        } else {
          noteAction(a, a.type, "T1", "text boxes from the active .po catalog with native position and alignment");
          out.push(...dialog(g[0]!, ctx.m, dialogLayout(g)));
        }
        break;
      case "translated_dialog_choice": case "choice_monster": case "choice_npc": {
        const opts = format(g[0]!, ctx.m).split(":");
        if (a.type !== "translated_dialog_choice" && ctx.options.extChoice) {
          // KC1: a static extChoice list. The resolver writes the enum code
          // so variable_set conditions keep comparing codes. TextFormatter
          // substitutions (${{...}}) are applied before splitting, like dialog.
          const variable = g[1]!;
          const commonLabel = a.type === "choice_npc" && g[2] ? po.get(g[2]) ?? g[2] : undefined;
          const options = opts.map((option) => {
            choiceLookupKeys.add(option);
            const own = po.get(option) ?? titleCase(option);
            // Upstream choice_npc shares one label across buttons and tells
            // options apart by per-option NPC pictures; the option's own
            // name is appended as well so every line reads on its own.
            const label = commonLabel ? `${commonLabel} (${own})` : own;
            return {
              key: option,
              label: label.slice(0, 24) || option.slice(0, 24),
              code: code(variable, option),
            };
          });
          if (a.type === "choice_npc") {
            // Each option is an NPC entry (db/npc/appearance_options.yaml);
            // its walker's front idle frame is the option icon, the small
            // form of upstream's front combat sheet.
            noteAction(a, a.type, "T1", "choices with each option NPC's front walker frame as its icon");
            out.push({
              op: "choices",
              prompt: "",
              options: options.map((option) => {
                const sprite = npcDb.get(option.key)?.template.sprite_name;
                return {
                  text: option.label,
                  ...(sprite && ensureAppearanceSprite(sprite) ? { icon: { sprite } } : {}),
                  commands: [{ op: "variable" as const, id: varId(variable), set: { op: "set" as const, value: option.code } }],
                };
              }),
            });
            break;
          }
          if (a.type === "choice_monster") {
            // Each option is a monster slug; its menu face (menu1_rect) is
            // the option icon, the static 16 px form of upstream's animated
            // ChoiceMonster faces.
            noteAction(a, a.type, "T1", "choices with each monster's menu face as its icon");
            out.push({
              op: "choices",
              prompt: "",
              options: options.map((option) => {
                const iconSprite = ensureMonsterMenuIcon(option.key);
                return {
                  text: option.label,
                  ...(iconSprite ? { icon: { sprite: iconSprite } } : {}),
                  commands: [{ op: "variable" as const, id: varId(variable), set: { op: "set" as const, value: option.code } }],
                };
              }),
            });
            break;
          }
          noteAction(a, a.type, "T1", "KC1 extChoice static list -> enum code via the resolver");
          out.push(command({
            op: "extChoice",
            call: "tux.enum_choice",
            args: { variable: varId(variable), options },
            prompt: "",
          }));
          break;
        }
        const fate: Fate = a.type === "translated_dialog_choice"
          ? (opts.length > 4 ? "T1-lowered" : "T1")
          : "T3-placeholder";
        noteAction(
          a,
          a.type + (opts.length > 4 ? "(paginated)" : ""),
          fate,
          opts.length > 4 ? "nested choice pages retain every option" : "choices -> enum code",
        );
        out.push(enumChoice(opts, g[1]!));
        break;
      }
      case "set_variable": {
        noteAction(a, a.type, "T1", "variable set enum code (text variables: the literal string)");
        const texts: Record<string, string> = {};
        for (const p of g) {
          const j = p.indexOf(":");
          const k = j < 0 ? p : p.slice(0, j);
          const value = j < 0 ? "" : p.slice(j + 1);
          if (isTextVariable(k)) texts[varId(k)] = value;
          else out.push({ op: "variable", id: varId(k), set: { op: "set", value: code(k, value) } });
        }
        if (Object.keys(texts).length) out.push({ op: "ext", call: "tux.set_variable_text", args: { writes: texts } });
        break;
      }
      case "clear_variable":
        noteAction(a, a.type, "T1", "variable set 0");
        for (const p of g) out.push({ op: "variable", id: varId(p), set: { op: "set", value: 0 } });
        break;
      case "random_integer":
        noteAction(a, a.type, "T1", "variable random integer");
        out.push({
          op: "variable",
          id: varId(g[0]!),
          set: { op: "random", min: Number(g[1]), max: Number(g[2]) },
        });
        break;
      case "set_random_variable": {
        const codes = g[1]!.split(":")
          .map((value) => code(g[0]!, value))
          .sort((a, b) => a - b);
        noteAction(a, a.type, "T1", "variable random enum code");
        out.push({
          op: "variable",
          id: varId(g[0]!),
          set: { op: "random", min: codes[0]!, max: codes.at(-1)! },
        });
        break;
      }
      case "wait":
        noteAction(a, a.type, "T1", "wait seconds");
        if (Number(g[0]) > 0) out.push({ op: "wait", seconds: Math.min(30, Number(g[0])) });
        break;
      case "play_map_animation": {
        const [name, rawDuration, rawLoop, character] = g;
        const duration = Number(rawDuration);
        const anim = name ? ensureMapAnimation(name, duration) : null;
        const validLoop = rawLoop === "loop" || rawLoop === "noloop";
        const knownTarget = character === "player" || (character !== undefined &&
          ctx.m.events.some((event) => event.acts.some((candidate) =>
            candidate.type === "create_npc" && candidate.args[0] === character
          )));
        if (!anim || !validLoop || !knownTarget) {
          noteAction(
            a,
            a.type,
            "T4-dropped",
            !anim ? "animation metadata, sheet, or positive frame duration is unavailable"
              : !validLoop ? "loop mode is neither loop nor noloop"
              : "animation target is not a character on this map",
          );
          break;
        }
        noteAction(a, a.type, "T1", "KA1 map animation at the character's sampled tile");
        out.push({
          op: "mapAnim",
          id: `tux_map_${safeAssetId(name!)}`,
          anim,
          target: character === "player" ? "player" : { event: `npc_${slug(character!)}` },
          follow: false,
          layer: "above",
          loop: rawLoop === "loop",
        });
        break;
      }
      case "play_sound": {
        // G8: the old `se` emit dropped the authored volume (compile default
        // 80). playSe carries the converted percent; the host resolves the id
        // through Project.audio and stays silent for ids without an asset.
        const id = audioId(g[0]!);
        const vol = g[1] !== undefined && g[1] !== "" && Number.isFinite(Number(g[1]))
          ? Math.round(Number(g[1]) * 100)
          : undefined;
        noteAction(a, a.type, "T1", `playSe ${id}${audioAssetIds().has(id) ? "" : " (no asset: silent)"}`);
        out.push({ op: "playSe", id, ...(vol !== undefined ? { volume: vol } : {}) });
        break;
      }
      case "play_tile_animation": {
        const [rawX, rawY, name, rawDuration, rawLoop] = g;
        const x = Number(rawX);
        const y = Number(rawY);
        const duration = Number(rawDuration);
        const anim = name ? ensureMapAnimation(name, duration) : null;
        const validCell = Number.isInteger(x) && Number.isInteger(y) &&
          x >= 0 && y >= 0 && x < ctx.m.width && y < ctx.m.height;
        const validLoop = rawLoop === "loop" || rawLoop === "noloop";
        if (!anim || !validCell || !validLoop) {
          noteAction(
            a,
            a.type,
            "T4-dropped",
            !anim ? "animation metadata, sheet, or positive frame duration is unavailable"
              : !validCell ? "animation tile is outside the current map"
              : "loop mode is neither loop nor noloop",
          );
          break;
        }
        noteAction(a, a.type, "T1", "KA1 map animation at a fixed tile");
        out.push({
          op: "mapAnim",
          id: `tux_map_${safeAssetId(name!)}`,
          anim,
          x,
          y,
          layer: "above",
          loop: rawLoop === "loop",
        });
        break;
      }
      case "screen_transition":
      {
        const duration = numeric(g[0], 0.3);
        const color = g[1] ? parseSourceColor(g[1]) : { r: 0, g: 0, b: 0, a: 255 };
        if (duration < 0 || !color) {
          noteAction(a, a.type, "T4-dropped", "fade duration or colon-delimited RGB(A) color is invalid");
          break;
        }
        noteAction(a, a.type, "T1", "KS1 blocking fade out followed by fade in");
        out.push({ op: "screenFade", direction: "out", duration, color, wait: true });
        out.push({ op: "screenFade", direction: "in", duration, color, wait: true });
        break;
      }
      case "camera_position": {
        const hasPosition = g[0] !== undefined && g[1] !== undefined;
        if (!hasPosition) {
          noteAction(a, a.type, "T1", "KS1 camera resumes live player following");
          out.push({ op: "camera", target: "player", duration: 0 });
          break;
        }
        const x = Number(g[0]);
        const y = Number(g[1]);
        if (!Number.isInteger(x) || !Number.isInteger(y) ||
            x < 0 || y < 0 || x >= ctx.m.width || y >= ctx.m.height) {
          noteAction(a, a.type, "T4-dropped", "source camera position is outside the active map boundary");
          break;
        }
        noteAction(a, a.type, "T1", "KS1 camera snaps to a fixed tile");
        out.push({ op: "camera", target: { x, y }, duration: 0 });
        break;
      }
      case "set_bubble": {
        const [character, bubble] = g;
        const knownTarget = character === "player" || (character !== undefined &&
          ctx.m.events.some((event) => event.acts.some((candidate) =>
            candidate.type === "create_npc" && candidate.args[0] === character
          )));
        const icon = bubble ? ensureBubbleAnimation(bubble) : undefined;
        if (!character || !knownTarget || (bubble && !icon)) {
          noteAction(
            a,
            a.type,
            "T4-dropped",
            !knownTarget ? "bubble target is not a character on this map" : "bubble image is unavailable",
          );
          break;
        }
        noteAction(a, a.type, "T1", bubble ? "KS1 persistent balloon" : "KS1 balloon clear");
        out.push({
          op: "balloon",
          target: character === "player" ? "player" : { event: `npc_${slug(character)}` },
          ...(icon ? { icon } : {}),
        });
        break;
      }
      case "change_bg": {
        const [background, image, category] = g;
        if (!background) {
          noteAction(a, a.type, "T1", "KS1 closes the blocking screen backdrop");
          out.push({ op: "screenBackdrop", layer: SCREEN_BACKDROP_LAYER, variant: null });
          break;
        }
        const variant = ensureBackdrop(background, image, category);
        if (!variant) {
          noteAction(a, a.type, "T4-dropped", "background or optional foreground image is unavailable");
          break;
        }
        noteAction(a, a.type, "T1", "KS1 blocking screen backdrop");
        out.push({ op: "screenBackdrop", layer: SCREEN_BACKDROP_LAYER, variant });
        break;
      }
      case "change_bg_char": {
        const [background, character] = g;
        const variant = background && character
          ? ensureCharacterBackdrop(background, character)
          : null;
        if (!variant) {
          noteAction(a, a.type, "T4-dropped", "background, NPC template, or combat-sheet front art is unavailable");
          break;
        }
        noteAction(a, a.type, "T1", "KV1 combat-sheet front art on a blocking screen backdrop");
        out.push({ op: "screenBackdrop", layer: SCREEN_BACKDROP_LAYER, variant });
        break;
      }
      case "set_layer": {
        const value = g[0];
        if (!value || value.toLowerCase() === "none") {
          noteAction(a, a.type, "T1", "KV1 clears the map overlay layer");
          out.push({ op: "layer", layer: SCREEN_OVERLAY_LAYER, visible: null, variant: null });
          out.push({ op: "variable", id: LAYER_VARIANT_VARIABLE, set: { op: "set", value: 0 } });
          break;
        }
        const variant = ensureOverlay(value);
        if (!variant) {
          noteAction(a, a.type, "T4-dropped", "overlay color is invalid or image is unavailable");
          break;
        }
        noteAction(a, a.type, "T1", "KV1 selects a prepackaged map overlay");
        out.push({ op: "layer", layer: SCREEN_OVERLAY_LAYER, variant, visible: true });
        out.push({ op: "variable", id: LAYER_VARIANT_VARIABLE, set: { op: "set", value: layerVariantCode(variant) } });
        break;
      }
      case "set_template": {
        const [character, sprite, combatSheet] = g;
        const knownTarget = character === "player" || (character !== undefined &&
          ctx.m.events.some((event) => event.acts.some((candidate) =>
            candidate.type === "create_npc" && candidate.args[0] === character
          )));
        if (!character || !sprite || !knownTarget) {
          noteAction(a, a.type, "T4-dropped", "appearance target or sprite is unavailable");
          break;
        }
        const target = character === "player"
          ? "player" as const
          : isSelf(character) ? "this" as const : { event: `npc_${slug(character)}` };
        if (sprite === "default") {
          noteAction(a, a.type, "T1", "KV1 restores the character's saved race/page appearance baseline");
          out.push({ op: "appearance", target, sprite: null });
          break;
        }
        if (!ensureAppearanceSprite(sprite)) {
          noteAction(a, a.type, "T4-dropped", "walking appearance sheet is unavailable");
          break;
        }
        const saveDefault = character === "player" && combatSheet !== undefined &&
          RACE_APPEARANCE_SPRITES.has(sprite);
        noteAction(
          a,
          a.type,
          saveDefault ? "T1-lowered" : "T1",
          saveDefault
            ? "KV1 saves the race walking baseline; its combat-sheet choice remains battle-owned"
            : "KV1 selects a runtime walking appearance",
        );
        out.push({
          op: "appearance",
          target,
          sprite,
          ...(saveDefault ? { saveDefault: true } : {}),
        });
        break;
      }
      case "update_tile_properties": {
        const label = g[0];
        const moverate = Number(g[1]);
        if (!label || (moverate !== 0 && moverate !== 1)) {
          noteAction(a, a.type, "T4-dropped", "only corpus moverates 0 and 1 map to passage");
          break;
        }
        const cells = ctx.surfaceLabels[label] ?? [];
        noteAction(
          a,
          a.type,
          "T1",
          cells.length
            ? "KV1 expands the source surface label to exact per-map passage overrides"
            : "source surface label has no cells on this map; native no-op",
        );
        for (const index of cells) {
          out.push({
            op: "tileProperty",
            x: index % ctx.m.width,
            y: Math.floor(index / ctx.m.width),
            // Every authored surfable tile in the pinned corpus starts at
            // moverate 0. Clearing the override restores that authored block;
            // moverate 1 explicitly opens it.
            passage: moverate === 1 ? "pass" : null,
          });
        }
        break;
      }
      case "add_item": {
        if (g[2] && g[2] !== "player") { noteAction(a, "add_item(npc)", "T3-dropped", "NPC bags are combat-only"); break; }
        const q = g[1] ? Number(g[1]) : 1;
        if (!q) { noteAction(a, "add_item(zero)", "T4-dropped", "zero quantity is a no-op"); break; }
        noteAction(a, a.type, "T1", "session item add/sub");
        ensureItem(g[0]!);
        const amount = Math.min(99, Math.abs(q)) * (q > 0 ? 1 : -1);
        out.push({ op: "item", item: g[0]!, set: amount > 0 ? "add" : "sub", count: Math.abs(amount) });
        break;
      }
      case "modify_money":
        if (g[0] !== "player" || !g[1]) { noteAction(a, "modify_money(var/npc)", "T2-dropped", "amount from a variable"); break; }
        noteAction(a, a.type, "T1", "gold add/sub");
        out.push({ op: "gold", set: Number(g[1]) >= 0 ? "add" : "sub", amount: Math.abs(Number(g[1])) });
        break;
      case "add_tracker":
        noteAction(a, a.type, "T1-lowered", "switch tracker.<map>");
        out.push({ op: "switch", id: `tracker.${g[1]}`, value: true });
        break;
      case "create_npc":
        noteAction(
          a,
          a.type,
          ctx.options.place && ctx.options.localReset ? "T1" : "T1-lowered",
          ctx.options.place
            ? "local.npc.<slug> = 1 plus K1 place"
            : "local.npc.<slug> = 1 (spawn position other than the event's is T2 place)",
        );
        if (ctx.options.battle) {
          // Upstream create_npc is a no-op for an NPC already on the map;
          // otherwise it builds a fresh NPC whose party starts empty.
          out.push({
            op: "if",
            if: { kind: "variable", id: npcVar(g[0]!), op: "==", value: 0 },
            then: [{ op: "ext", call: "tux.clear_npc_party", args: { character: g[0]! } }],
          });
        }
        out.push({ op: "variable", id: npcVar(g[0]!), set: { op: "set", value: 1 } });
        if (ctx.options.place) {
          out.push(command({
            op: "place",
            target: { event: `npc_${slug(g[0]!)}` },
            x: Math.max(0, Math.min(ctx.m.width - 1, Number(g[1]))),
            y: Math.max(0, Math.min(ctx.m.height - 1, Number(g[2]))),
          }));
        }
        break;
      case "remove_npc":
        noteAction(a, a.type, ctx.options.localReset ? "T1" : "T1-lowered", "local.npc.<slug> = 0");
        out.push({ op: "variable", id: npcVar(g[0]!), set: { op: "set", value: 0 } });
        if (ctx.options.battle) out.push({ op: "ext", call: "tux.clear_npc_party", args: { character: g[0]! } });
        break;
      case "lock_controls": case "unlock_controls":
        if (ctx.options.inputLock) {
          noteAction(a, a.type, "T1", "K1 cross-event input lock command");
          out.push(command({ op: a.type === "lock_controls" ? "lockInput" : "unlockInput" }));
        } else {
          noteAction(a, a.type, "T1-lowered", "blocking fibers already freeze the player (cross-event locks are T2)");
        }
        break;
      case "char_stop":
        if (ctx.options.moveControl) {
          noteAction(a, a.type, "T1", "KM1 moveControl stop (cancels the active route and page patrol)");
          out.push(command({ op: "moveControl", target: charTarget(g[0]!, isSelf(g[0])), control: { kind: "stop" } }));
        } else {
          noteAction(a, a.type, "T1-lowered", "blocking fibers already freeze the player (cross-event locks are T2)");
        }
        break;
      case "char_face": {
        const [who, dir] = [g[0]!, g[1]!];
        const target = who === "player"
          ? "player" as const
          : isSelf(who) ? "this" as const : { event: `npc_${slug(who)}` };
        if (!DIRS.has(dir)) {
          if (ctx.options.routes) {
            noteAction(a, "char_face(toward char)", "T1", "K2 arbitrary-target turn-toward route");
            const step: FutureMoveStep = dir === "player"
              ? "turnTowardPlayer"
              : { turnToward: { event: `npc_${slug(dir)}` } };
            out.push(command({ op: "moveRoute", target, wait: false, route: { steps: [step], repeat: false, skippable: true } }));
          } else {
            noteAction(a, "char_face(toward char)", "T2-dropped", "needs turnToward step");
          }
          break;
        }
        if (who === "player" || isSelf(who)) {
          noteAction(a, a.type, "T1-lowered", `moveRoute ${who === "player" ? "player" : "this"} face`);
          out.push({ op: "moveRoute", target: who === "player" ? "player" : "this", wait: false, route: { steps: [FACE[dir]!], repeat: false, skippable: true } });
        } else if (ctx.options.routes) {
          noteAction(a, a.type, "T1", "K2 moveRoute targets an arbitrary event");
          out.push(command({ op: "moveRoute", target, wait: false, route: { steps: [FACE[dir]!], repeat: false, skippable: true } }));
        } else noteAction(a, "char_face(other npc)", "T2-dropped", "moveRoute target must be an event id");
        break;
      }
      case "char_move": {
        const who = g[0]!;
        if (who !== "player" && !isSelf(who) && !ctx.options.routes) {
          noteAction(a, "char_move(other npc)", "T2-dropped", "moveRoute target must be an event id");
          break;
        }
        const steps: MoveStep[] = [];
        for (const mv of g.slice(1)) {
          const [d, n] = mv.trim().split(/\s+/);
          for (let k = 0; k < Number(n ?? 1); k++) steps.push(MOVE[d!]!);
        }
        noteAction(a, a.type, ctx.options.routes && who !== "player" && !isSelf(who) ? "T1" : "T1-lowered", "moveRoute steps");
        const target = who === "player" ? "player" as const
          : isSelf(who) ? "this" as const : { event: `npc_${slug(who)}` };
        // Tuxemon's char_move stops the route when a step is obstructed, then
        // lets the event continue. A skippable kit route has that same
        // contract; a non-skippable waiter would hold the cutscene forever.
        out.push(command({ op: "moveRoute", target, wait: true, route: { steps, repeat: false, skippable: true } }));
        break;
      }
      case "transition_teleport": {
        if (g[0] !== "player") { noteAction(a, "transition_teleport(npc)", "T2-dropped", "only the player transfers"); break; }
        // Tuxemon keeps running the actions after a teleport in the same
        // frame; the kit's transfer ends the page. Hoist trailing instants,
        // fold a trailing `char_face player,<dir>` into the transfer's dir.
        let dir: Dir | "keep" = "keep";
        const hoisted: Rule[] = [];
        for (const b of acts.slice(i + 1)) {
          if (b.type === "char_face" && b.args[0] === "player" && DIRS.has(b.args[1]!)) {
            dir = b.args[1] as Dir;
            noteAction(b, "char_face(after teleport)", "T1", "folded into transfer direction");
          }
          else if (INSTANT.has(b.type)) hoisted.push(b);
          else noteAction(b, `${b.type}(after teleport)`, "T4-dropped", "runs on the old map during the fade");
        }
        out.push(...convertActions(hoisted, ctx));
        const map = g[1]!.replace(/\.tmx$/, "");
        const target = allMaps.get(map);
        if (!target) {
          noteAction(a, `${a.type}(missing map)`, "T4-dropped", `unknown target ${map}`);
          return out;
        }
        const requested = { x: Number(g[2]), y: Number(g[3]) };
        const clamped = {
          x: Math.max(0, Math.min(target.width - 1, requested.x)),
          y: Math.max(0, Math.min(target.height - 1, requested.y)),
        };
        let emitted = clamped;
        if (clamped.x !== requested.x || clamped.y !== requested.y) {
          if (!transferCellIsWalkable(target, clamped.x, clamped.y)) {
            emitted = nearestWalkableTransferCell(target, clamped.x, clamped.y);
          }
          transferRepairs.push({ sourceMap: ctx.m.slug, targetMap: map, requested, clamped, emitted });
          noteAction(
            a,
            `${a.type}(repaired)`,
            "T1-lowered",
            emitted === clamped
              ? "upstream landing point clamped into target bounds"
              : "clamped landing was isolated; deterministic BFS selected the nearest walkable cell",
          );
        } else {
          noteAction(a, a.type, "T1", "transfer (terminal; dir from trailing char_face)");
        }
        if (ctx.options.battle) out.push(clearNpcParties());
        out.push(resetLayerVariant());
        const portalId = portalIdForAction(ctx, a);
        out.push({
          op: "transfer",
          map,
          x: emitted.x,
          y: emitted.y,
          dir,
          fade: Math.min(2, Number(g[4] ?? 0.3)),
          ...(portalId && ctx.seamlessPortalIds.has(portalId)
            ? { handoff: { mode: "seamless-v1" as const, portalId } }
            : {}),
        });
        return out;
      }
      case "load_yaml":
        noteAction(a, a.type, "T1-lowered", "import-time events gated until this action runs");
        out.push({
          op: "variable",
          id: varId(`__loaded_yaml.${ctx.m.slug}.${g[0]}`),
          set: { op: "set", value: code(`__loaded_yaml.${ctx.m.slug}.${g[0]}`, "yes") },
        });
        break;
      case "remove_collision":
        noteAction(
          a,
          a.type,
          ctx.options.localReset ? "T1" : "T1-lowered",
          "keyed collision becomes a variable-gated blocking event",
        );
        out.push({
          op: "variable",
          id: collisionVar(ctx.m.slug, g[0]!),
          set: { op: "set", value: 1 },
        });
        break;
      case "start_battle": case "start_double_battle": {
        const opp = g[0] === "player" ? g[1]! : g[0]!;
        const opponent = playerOpponent(g);
        if (ctx.options.battle && opponent) {
          const party = foldedParties.parties.get(i) ?? [];
          noteAction(a, a.type, "T1", party.length
            ? `Battle Processing with ${party.length} folded trainer monsters`
            : "Battle Processing with extension-staged trainer party");
          out.push({
            op: "battle",
            setup: {
              kind: "trainer",
              opponent,
              ...(party.length ? { party } : {}),
              ...(a.type === "start_double_battle" ? { fieldSize: 2 } : {}),
              inside: ctx.m.props.inside === "true",
              hour: 12,
            } as unknown as JsonValue,
          });
        } else if (ctx.options.battle) {
          // NPC-versus-NPC: run a headless AI-vs-AI battle with the saved
          // RNG. A decisive outcome is recorded the way upstream's
          // CombatState does: battle_last_winner = winner, battle_last_loser
          // = loser, and battle_last_trainer = the loser (upstream's loser
          // handling overwrites the winner's trainer write). On a true draw
          // upstream raises before writing either variable; this port writes
          // the draw result and the challenger's trainer code instead, a
          // deliberate deterministic fallback (Degraded in the coverage).
          const fighter = g[0]!;
          const foe = g[1]!;
          noteAction(a, a.type, "T1-lowered", "NPC-versus-NPC battle auto-resolved with the battle rules and saved RNG; outcome recorded");
          const npcBattleText = NPC_BATTLE_TEXT[activeLang];
          out.push({
            op: "text",
            lines: [npcBattleText.label(npcName(fighter), npcName(foe)).slice(0, 52), npcBattleText.resolved.slice(0, 52)],
          });
          out.push({ op: "ext", call: "tux.npc_battle", args: {
            fighter,
            foe,
            fighterWinnerCode: code("battle_last_winner", fighter),
            foeWinnerCode: code("battle_last_winner", foe),
            fighterLoserCode: code("battle_last_loser", fighter),
            foeLoserCode: code("battle_last_loser", foe),
            fighterTrainerCode: code("battle_last_trainer", fighter),
            foeTrainerCode: code("battle_last_trainer", foe),
            drawCode: code("battle_last_result", "draw"),
          } });
        } else {
          noteAction(a, a.type, "T3-placeholder", "inline placeholder: text + outcome writes");
          out.push(...battlePlaceholder(opp));
        }
        break;
      }
      case "char_talk": {
        const line = npcDb.get(g[0]!)?.speech?.profile?.default?.[g[1]!];
        const key = Array.isArray(line) ? line[0] : line;
        if (!key) { noteAction(a, "char_talk(no line)", "T4-dropped", "profile has no such field"); break; }
        noteAction(a, a.type, "T1", "text of the NPC's dialogue-profile msgid");
        out.push(...dialog(key, ctx.m));
        break;
      }
      case "add_monster": {
        if (ctx.options.battle) {
          if (foldedParties.folded.has(i)) {
            noteAction(a, "add_monster(npc folded)", "T1", "literal trainer monster folded into Battle Processing setup");
            break;
          }
          const character = g[2] || "player";
          noteAction(a, a.type, "T1", character === "player"
            ? "tux.add_monster spawns into the persistent party"
            : "tux.add_monster stages a live-variable or cross-event trainer monster");
          out.push({
            op: "ext",
            call: "tux.add_monster",
            args: {
              species: monsterSpeciesArg(g[0]!),
              level: Number(g[1]),
              character,
              experienceModifier: numeric(g[3], 1),
              moneyModifier: numeric(g[4], 0),
            },
          });
          break;
        }
        if (g[2] && g[2] !== "player") { noteAction(a, "add_monster(npc)", "T3-dropped", "trainer teams are P2"); break; }
        noteAction(a, a.type, "T3-placeholder", "sys.party_size += 1, switch mon.<slug>");
        out.push({ op: "variable", id: "sys.party_size", set: { op: "add", value: 1 } });
        out.push({ op: "switch", id: `mon.${g[0]}`, value: true });
        break;
      }
      case "evolution": {
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T4-dropped", "presentation / meta");
          break;
        }
        const character = g[0] || "player";
        const args = { character, inside: ctx.m.props.inside === "true" };
        noteAction(a, a.type, "T1", "confirmation choice followed by upstream-compatible spawn/transfer/replace");
        out.push({
          op: "choices",
          prompt: (po.get("allow_evolution") ?? "Allow evolution?").slice(0, 52),
          options: [
            {
              text: (po.get("yes") ?? "Yes").slice(0, 24),
              commands: [{ op: "ext", call: "tux.evolution", args }],
            },
            {
              text: (po.get("no") ?? "No").slice(0, 24),
              commands: [{ op: "ext", call: "tux.cancel_evolution", args: { character } }],
            },
          ],
        });
        break;
      }
      case "random_monster":
        if (ctx.options.battle) {
          const character = g[1] || "player";
          noteAction(a, a.type, "T1", character === "player"
            ? "tux.random_monster draws a qualified species from the deterministic pool and spawns it"
            : "tux.random_monster draws a qualified species and stages it for the NPC team");
          out.push({ op: "ext", call: "tux.random_monster", args: {
            level: Number(g[0]),
            ...(character !== "player" ? { character } : {}),
            ...(g[2] ? { experienceModifier: numeric(g[2], 1) } : {}),
            ...(g[3] ? { moneyModifier: numeric(g[3], 0) } : {}),
          } });
          break;
        }
        if (g[1]) {
          noteAction(a, "random_monster(npc)", "T3-dropped", "trainer teams are P2");
        } else {
          noteAction(a, a.type, "T3-placeholder", "sys.party_size += 1");
          out.push({ op: "variable", id: "sys.party_size", set: { op: "add", value: 1 } });
          out.push({ op: "switch", id: "mon.random", value: true });
        }
        break;
      case "remove_monster":
        if (ctx.options.battle) {
          noteAction(a, a.type, "T1", "tux.remove_monster deletes the iid from its owner (player party/kennel or NPC party)");
          out.push({ op: "ext", call: "tux.remove_monster", args: { variable: varId(g[0]!) } });
        } else {
          noteAction(a, a.type, "T3-placeholder", "sys.party_size -= 1 when non-empty");
          out.push({
            op: "if",
            if: { kind: "variable", id: "sys.party_size", op: ">=", value: 1 },
            then: [{ op: "variable", id: "sys.party_size", set: { op: "sub", value: 1 } }],
          });
        }
        break;
      case "get_party_monster":
        if (ctx.options.battle) {
          // NPC parties are staged live (not folded) when the event inspects
          // them, and NPC-versus-NPC battles keep the parties in npcParties,
          // so the iid_slot_* writes always have a party to read.
          noteAction(a, a.type, "T1", "tux.get_party_monsters dumps the party iids into iid_slot_* variables (upstream opens no menu)");
          out.push({ op: "ext", call: "tux.get_party_monsters", args: { character: g[0] || "player" } });
        } else {
          noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        }
        break;
      case "wild_encounter":
        if (ctx.options.battle) {
          noteAction(a, a.type, "T1", "Battle Processing with a scripted wild monster");
          out.push({ op: "battle", setup: {
            kind: "wild",
            species: g[0]!,
            level: Number(g[1]),
            experienceModifier: numeric(g[2], 1),
            moneyModifier: numeric(g[3], 0),
            ...(g[4] ? { environment: g[4] } : {}),
            inside: ctx.m.props.inside === "true",
            hour: 12,
          } });
        } else {
          noteAction(a, a.type, "T3-placeholder", "scripted wild battle auto-wins in P1");
          out.push(...battlePlaceholder(g[0]!));
        }
        break;
      case "random_encounter":
        if (ctx.options.battle) {
          noteAction(a, a.type, "T1-lowered",
            "deterministic encounter-table sampling with live-clock daytime; no repellent, scaling or held items (unused in corpus)");
          out.push({ op: "battle", setup: {
            kind: "random",
            table: g[0]!,
            probability: numeric(g[1], 1),
            inside: ctx.m.props.inside === "true",
          } });
        } else {
          noteAction(a, a.type, "T3-placeholder", "intentionally silent in P1");
        }
        break;
      case "open_shop": {
        const economySlug = ctx.economies.get(g[0]!);
        const economy = economySlug ? economyDb.get(economySlug) : undefined;
        const monsterShop = g[1] === "buy_monster" && ctx.options.battle && economy
          ? monsterShopScene(economy)
          : null;
        if (g[1] === "both_item" && economy && (economy.items?.length ?? 0) > 0) {
          noteAction(a, a.type, "T1", "K4 shop with imported prices, buy-back prices, stock and variable conditions");
          out.push(itemShop(economy));
        } else if (monsterShop) {
          noteAction(a, a.type, "T1", "tux.monsterShop scene: imported price, level and saved per-economy stock; party then Kennel");
          out.push(monsterShop);
        } else {
          noteAction(a, a.type, "T3-placeholder", g[1] === "buy_monster"
            ? "monster trading remains a visible placeholder"
            : "unsupported or missing economy remains a visible placeholder");
          out.push(...shopPlaceholder(g[0]!, g[1]!, economySlug));
        }
        break;
      }
      case "set_economy":
        if (g[0] && g[1] && ctx.economies.get(g[0]) === g[1] && economyDb.has(g[1])) {
          noteAction(a, a.type, "T1", "statically binds this map's NPC to an imported economy");
        } else {
          noteAction(a, a.type, "T4-dropped", "economy or NPC binding is missing");
        }
        break;
      case "pathfind": {
        if (!ctx.options.routes) {
          noteAction(a, a.type, "T2-dropped", "runtime pathfinding / other-event routes / NPC motion props");
          break;
        }
        const who = g[0]!;
        const target = who === "player" ? "player" as const
          : isSelf(who) ? "this" as const : { event: `npc_${slug(who)}` };
        noteAction(a, a.type, "T1", "K2 deterministic pathTo route");
        out.push(command({
          op: "moveRoute",
          target,
          wait: true,
          route: {
            steps: [{ pathTo: { x: Number(g[1]), y: Number(g[2]) } }],
            repeat: false,
            skippable: false,
          },
        }));
        break;
      }
      case "pathfind_to_char": {
        if (!ctx.options.routes) {
          noteAction(a, a.type, "T2-dropped", "runtime pathfinding / other-event routes / NPC motion props");
          break;
        }
        const [toward, who, side, distance] = g;
        const target = who === "player" ? "player" as const
          : isSelf(who) ? "this" as const : { event: `npc_${slug(who!)}` };
        const approach: { target: "player" | { event: string }; side?: Dir; distance?: number } = {
          target: toward === "player" ? "player" : { event: `npc_${slug(toward!)}` },
        };
        if (DIRS.has(side)) approach.side = side as Dir;
        if (distance !== undefined && distance !== "") approach.distance = Math.max(1, Math.trunc(Number(distance)));
        noteAction(a, a.type, "T1", "K2 deterministic approach route");
        out.push(command({
          op: "moveRoute",
          target,
          wait: true,
          route: { steps: [{ approach }], repeat: false, skippable: false },
        }));
        break;
      }
      case "char_wander": {
        if (!ctx.options.moveControl) {
          noteAction(a, a.type, "T2-dropped", "runtime pathfinding / other-event routes / NPC motion props");
          break;
        }
        const who = g[0]!;
        // Upstream: `self.frequency or DEFAULT_FREQUENCY` (None or 0 -> 1.0),
        // clipped to [0.5, 5] by the action contract.
        const freq = Math.max(0.5, Math.min(5, numeric(g[1], 1)));
        const control: MoveControl = { kind: "wander", frequency: frequencyGrade(freq) };
        const [tx, ty, bx, by] = [g[2], g[3], g[4], g[5]].map((v) => (v === undefined || v === "" ? NaN : Number(v)));
        if ([tx, ty, bx, by].every(Number.isFinite) && bx >= tx && by >= ty) {
          const bounds: WanderBounds = { x: tx, y: ty, width: bx - tx + 1, height: by - ty + 1 };
          control.bounds = bounds;
        }
        noteAction(a, a.type, "T1-lowered", "KM1 moveControl wander (seeded RNG; seconds -> nearest MV frequency grade)");
        out.push(command({ op: "moveControl", target: charTarget(who, isSelf(who)), control }));
        break;
      }
      case "char_speed": {
        if (!ctx.options.moveControl) {
          noteAction(a, a.type, "T2-dropped", "runtime pathfinding / other-event routes / NPC motion props");
          break;
        }
        const rate = Number(g[1]);
        if (!Number.isFinite(rate) || rate <= 0 || rate >= 20) {
          noteAction(a, "char_speed(invalid)", "T2-dropped", `moverate ${g[1]} is outside the upstream (0, 20) range`);
          break;
        }
        noteAction(a, a.type, "T1-lowered", "KM1 moveControl speed (tiles/sec -> nearest MV exponential grade)");
        out.push(command({ op: "moveControl", target: charTarget(g[0]!, isSelf(g[0])), control: { kind: "speed", value: speedGrade(rate) } }));
        break;
      }
      case "char_run":
        // Upstream char_run sets the absolute run rate (7.35 tiles/s) only
        // while the character is already moving, and the boost reverts to
        // walk speed when movement stops. The kit's run control is a
        // persistent relative +1 speed grade with no movement-scoped
        // lifetime: emitting it would speed every later route (route1's
        // idle christie would run her whole pathfind, where upstream is a
        // no-op). Drop the action; the one wander use may lose a transient
        // single-step boost.
        noteAction(a, a.type, "T2-dropped", "upstream run rate applies only while moving and reverts on idle; the kit has no movement-scoped speed");
        break;
      case "set_facing_mode": {
        const FACING: Record<string, FacingMode> = {
          follow_movement: "followMovement",
          locked: "locked",
          scripted: "scripted",
        };
        const mode = FACING[(g[1] ?? "").trim().toLowerCase()];
        if (ctx.options.moveControl && mode) {
          noteAction(a, a.type, "T1", "KM1 moveControl facingMode");
          out.push(command({ op: "moveControl", target: charTarget(g[0]!, isSelf(g[0])), control: { kind: "facingMode", value: mode } }));
        } else {
          noteAction(a, a.type, "T2-dropped", mode ? "runtime movement props are disabled" : `unknown facing mode '${g[1] ?? ""}'`);
        }
        break;
      }
      case "char_position": {
        if (!ctx.options.moveControl) {
          noteAction(a, a.type, "T2-dropped", "runtime pathfinding / other-event routes / NPC motion props");
          break;
        }
        const x = Math.max(0, Math.min(ctx.m.width - 1, Number(g[1])));
        const y = Math.max(0, Math.min(ctx.m.height - 1, Number(g[2])));
        // Fold an immediately-following `char_face <same target>,<dir>` into
        // the placement's dir. The kit installs pending routes before it
        // applies placements, and a player placement stops the player route,
        // so a separate face route would be swallowed. Upstream places and
        // faces as two instants, so the fold is exact.
        let dir: Dir | undefined;
        const next = acts[i + 1];
        if (next?.type === "char_face" && next.args[0] === g[0] && DIRS.has(next.args[1]!)) {
          dir = next.args[1] as Dir;
          noteAction(next, "char_face(after position)", "T1", "folded into placement dir");
          i++;
        }
        noteAction(a, a.type, "T1-lowered", "place command (out-of-map coordinates are clamped; upstream raises)");
        out.push(command({ op: "place", target: charTarget(g[0]!, isSelf(g[0])), x, y, ...(dir ? { dir } : {}) }));
        break;
      }
      case "play_music": {
        // G2/G3: fade-in and loop count have no KAU1 equivalent (no authored
        // use). G4/G5: same-song no-op and crossfade are covered by the
        // `not music_playing` guards in 196/200 cases. Dead slugs (not in any
        // music DB) get a playBgm with no Project.audio entry -> silent.
        const id = audioId(g[0]!);
        const vol = g[1] !== undefined && g[1] !== "" && Number.isFinite(Number(g[1]))
          ? Math.round(Number(g[1]) * 100)
          : undefined;
        noteAction(a, a.type, "T1", `playBgm ${id}${audioAssetIds().has(id) ? "" : " (no asset: silent)"}`);
        // Upstream play_music sets current_song, so music_playing is true
        // again even if a fadeout was in flight. Clear the fading flag.
        // Guarded so the common case (no fade) writes no switch state.
        out.push(...guard([{ k: "sw", id: MUSIC_FADING_SWITCH, on: true }], [
          { op: "switch", id: MUSIC_FADING_SWITCH, value: false },
        ]));
        out.push({ op: "playBgm", id, ...(vol !== undefined ? { volume: vol } : {}) });
        break;
      }
      case "fadeout_music": {
        // ms -> virtual seconds; 0 -> stopBgm (frames <= 0 deletes immediately).
        const ms = Number(g[0] ?? 1000);
        if (ms <= 0) {
          noteAction(a, a.type, "T1", "stopBgm (fadeout 0)");
          out.push({ op: "stopBgm" });
        } else {
          // Set the fading flag so music_playing is false immediately; the
          // kit would otherwise keep bgmPlaying true until the fade ends and
          // a guarded parallel page could re-trigger this every frame.
          noteAction(a, a.type, "T1", `fadeoutBgm ${(ms / 1000).toFixed(3)}s + fading flag`);
          out.push({ op: "fadeoutBgm", duration: ms / 1000 });
          out.push({ op: "switch", id: MUSIC_FADING_SWITCH, value: true });
        }
        break;
      }
      case "pause_music":
        noteAction(a, a.type, "T1", "pauseBgm");
        out.push({ op: "pauseBgm" });
        break;
      case "unpause_music":
        noteAction(a, a.type, "T1", "resumeBgm");
        out.push({ op: "resumeBgm" });
        break;
      case "rename_player":
        if (ctx.options.battle && g[0] === "player") {
          noteAction(a, a.type, "T1-lowered", "rpgkit.nameInput; random-name button is not available");
          out.push({
            op: "scene",
            id: "rpgkit.nameInput",
            args: {
              maxLength: 15,
              default: "",
              title: po.get("name") ?? "Name",
              charset: TUXEMON_NAME_CHARSET,
              columns: 10,
              swallowCancel: true,
            },
          });
        } else {
          noteAction(a, a.type, "T2-dropped", "NPC rename and non-battle profiles have no name scene");
        }
        break;
      case "set_environment":
        if (ctx.options.battle) {
          noteAction(a, a.type, "T1", "tux.set_environment updates the active battle backdrop");
          out.push({ op: "ext", call: "tux.set_environment", args: g[0] ? { environment: g[0] } : {} });
        } else noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        break;
      case "set_monster_health":
        if (ctx.options.battle) {
          const args: Record<string, JsonValue> = {};
          if (g[0]) args.variable = varId(g[0]);
          if (g[1] !== undefined && g[1] !== "") args.health = {
            kind: g[1]!.includes(".") ? "fraction" : "points",
            value: Number(g[1]),
          };
          noteAction(a, a.type, "T1", "tux.set_monster_health updates persistent party HP");
          out.push({ op: "ext", call: "tux.set_monster_health", args });
        } else noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        break;
      case "set_monster_status":
        if (ctx.options.battle) {
          const args: Record<string, JsonValue> = {};
          if (g[0]) args.variable = varId(g[0]);
          if (g[1]) args.status = g[1];
          noteAction(a, a.type, "T1", "tux.set_monster_status updates persistent party status");
          out.push({ op: "ext", call: "tux.set_monster_status", args });
        } else noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        break;
      case "set_teleport_faint":
        if (ctx.options.battle) {
          noteAction(a, a.type, "T1", "tux.set_faint_point stores the character's recovery destination");
          out.push({ op: "ext", call: "tux.set_faint_point", args: {
            character: g[0]!, map: g[1]!.replace(/\.tmx$/, ""), x: Number(g[2]), y: Number(g[3]),
          } });
        } else noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        break;
      case "teleport_faint":
        if (ctx.options.battle) {
          const character = g[0] || "player";
          const healing = ["true", "1", "yes", "on"].includes((g[1] ?? "").toLowerCase());
          const carriesNotice = acts[i + 1]?.type === "translated_dialog" &&
            acts[i + 1]?.args[0] === "heal_before_leave";
          noteAction(a, a.type, "T1", "guarded variable transfer to the stored faint point");
          out.push({
            op: "if",
            if: { kind: "ext", call: "tux.has_faint_point", args: { character } },
            then: [
              { op: "ext", call: "tux.prepare_faint_transfer", args: { character, healing, currentMap: ctx.m.slug } },
              ...(carriesNotice ? [{ op: "switch" as const, id: FAINT_NOTICE_SWITCH, value: true }] : []),
              {
                op: "if",
                if: {
                  kind: "ext",
                  call: "tux.faint_point_is_map",
                  args: { character, map: ctx.m.slug, negate: true },
                },
                then: [clearNpcParties(), resetLayerVariant(), {
                  op: "transfer",
                  map: { variable: "tux.faint.map" },
                  x: { variable: "tux.faint.x" },
                  y: { variable: "tux.faint.y" },
                  dir: "keep",
                  fade: numeric(g[2], 0.3),
                }],
              },
            ],
          });
        } else noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        break;
      case "set_tuxepedia":
        if (ctx.options.battle && g[0] && g[1] && g[2]) {
          noteAction(a, a.type, "T1-lowered", "persistent seen/caught status; repeat counters and NPC journals are not retained");
          out.push({
            op: "ext",
            call: "tux.set_tuxepedia",
            args: { character: g[0], species: g[1], status: g[2] },
          });
        } else noteAction(a, a.type, "T3-dropped", "monster subsystem or required arguments unavailable");
        break;
      case "open_journal":
        if (ctx.options.battle && g[0]) {
          noteAction(a, a.type, "T1-lowered", "read-only tux.journal scene with compact imported details");
          out.push({ op: "scene", id: "tux.journal", args: { monster: g[0], reveal: true } });
        } else noteAction(a, a.type, "T3-dropped", "monster subsystem or target unavailable");
        break;
      case "get_player_monster": {
        const rename = acts[i + 1];
        if (ctx.options.battle && g[0] && rename?.type === "rename_monster" && rename.args[0] === g[0]) {
          const variable = varId(g[0]);
          noteAction(a, "get_player_monster(rename)", "T1-lowered", "party picker specialized for the adjacent rename action");
          out.push({
            op: "scene",
            id: "tux.monsterPicker",
            args: { variable, title: po.get("menu_rename") ?? "Choose a Tuxemon" },
            onDone: [
              {
                op: "ext",
                call: "tux.prepare_monster_rename",
                args: { variable, nameVariable: MONSTER_RENAME_NAME_VARIABLE },
              },
              {
                op: "scene",
                id: "rpgkit.nameInput",
                args: {
                  variable: MONSTER_RENAME_NAME_VARIABLE,
                  maxLength: 15,
                  title: po.get("name") ?? "Name",
                  charset: TUXEMON_NAME_CHARSET,
                  columns: 10,
                  swallowCancel: true,
                },
              },
              {
                op: "ext",
                call: "tux.apply_monster_rename",
                args: { variable, nameVariable: MONSTER_RENAME_NAME_VARIABLE },
              },
            ],
          });
        } else if (ctx.options.extChoice && g[0]) {
          const name = g[0]!;
          const filters = partyFilter(g);
          const args: Record<string, JsonValue> = {
            variable: varId(name),
            cancelCode: code(name, "no_choice"),
            filters,
          };
          const choice = command({
            op: "extChoice",
            call: "tux.party_monsters",
            args,
            prompt: "Choose a monster",
            ...(filters.length ? { cancel: true } : {}),
          });
          noteAction(a, a.type, "T1", "KC1 extChoice over the live party (empty party -> no_options; cancel -> no_choice)");
          // Upstream opens no menu when no monster matches: write no_options.
          out.push({
            op: "if",
            if: { kind: "ext", call: "tux.party_match", args: { filters } },
            then: [choice],
            else: [{ op: "variable", id: varId(name), set: { op: "set", value: code(name, "no_options") } }],
          });
        } else {
          noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
        }
        break;
      }
      case "rename_monster":
        if (ctx.options.battle && g[0] && acts[i - 1]?.type === "get_player_monster"
          && acts[i - 1]?.args[0] === g[0]) {
          noteAction(a, a.type, "T1", "handled by the preceding party-picker scene completion");
        } else {
          noteAction(a, a.type, "T3-dropped", "requires an adjacent get_player_monster picker");
        }
        break;
      case "set_monster_attribute": {
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
          break;
        }
        const variable = g[0]!;
        const attribute = g[1]!;
        const value = g[2] ?? "";
        if (!variable || !attribute) {
          noteAction(a, a.type, "T4-dropped", "missing variable or attribute");
          break;
        }
        noteAction(a, a.type, "T1", "tux.set_monster_attribute updates gender/acquisition/name on the iid-named monster");
        out.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: varId(variable), attribute, value } });
        break;
      }
      case "set_bill": {
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
          break;
        }
        const character = g[0] || "player";
        const bill = g[1]!;
        if (!bill) { noteAction(a, a.type, "T4-dropped", "missing bill slug"); break; }
        noteAction(
          a,
          a.type,
          "T1-lowered",
          "tux.set_bill creates or replaces the amount; interest rate, late fee and battle-earnings share are not retained or applied",
        );
        out.push({ op: "ext", call: "tux.set_bill", args: {
          character, bill, amount: numeric(g[2], 0),
        } });
        break;
      }
      case "modify_bill": {
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)");
          break;
        }
        const character = g[0] || "player";
        const bill = g[1]!;
        if (!bill) { noteAction(a, a.type, "T4-dropped", "missing bill slug"); break; }
        const args: Record<string, JsonValue> = { character, bill };
        if (g[2] !== undefined && g[2] !== "") args.amount = numeric(g[2], 0);
        else if (g[3]) args.variable = varId(g[3]);
        noteAction(a, a.type, "T1", "tux.modify_bill adds to or subtracts from a bill (deletes it at zero)");
        out.push({ op: "ext", call: "tux.modify_bill", args });
        break;
      }
      case "variable_math": {
        const [left, operator, right, result] = g;
        const operand = (text: string | undefined): JsonValue | null => {
          if (!text) return null;
          const literal = pyFloatFromText(text);
          return literal === null ? { variable: varId(text) } : { value: literal };
        };
        const l = operand(left);
        const r = operand(right);
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "text variables are written by the game extension (P2 runtime)");
          break;
        }
        if (!l || !r || !operator || !["+", "-", "*", "/", "="].includes(operator)
          || (result === undefined || result === "" ? pyFloatFromText(left!) !== null : pyFloatFromText(result) !== null)) {
          noteAction(a, a.type, "T4-dropped", "upstream raises on this operator or result");
          break;
        }
        noteAction(a, a.type, "T1", "tux.variable_math: float arithmetic (floor-division to int) stored as Python str()");
        out.push({ op: "ext", call: "tux.variable_math", args: {
          left: l, operator, right: r, result: varId(result || left!),
        } });
        break;
      }
      case "format_variable": {
        const [name, format] = g;
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "text variables are written by the game extension (P2 runtime)");
          break;
        }
        if (!name || !format || !["int", "-int", "float", "-float"].includes(format)) {
          noteAction(a, a.type, "T4-dropped", "upstream raises on this format");
          break;
        }
        noteAction(a, a.type, "T1", "tux.format_variable: Python int()/float() (optionally negated) stored as str()");
        out.push({ op: "ext", call: "tux.format_variable", args: { variable: varId(name), format } });
        break;
      }
      case "copy_variable": {
        const [target, source] = g;
        if (!target || !source || !isTextVariable(target) || !isTextVariable(source)) {
          noteAction(a, a.type, "T2-dropped", "enum codes are numbered per variable; only text variables copy verbatim");
          break;
        }
        noteAction(a, a.type, "T1", "variable copy of the stored text");
        out.push({ op: "variable", id: varId(target), set: { op: "copy", from: varId(source) } });
        break;
      }
      case "add_step_tracker": case "remove_step_tracker": case "set_step_tracker_milestone_shown": {
        const character = g[0];
        const tracker = g[1];
        if (!ctx.options.battle) {
          noteAction(a, a.type, "T3-dropped", "step trackers live in the game extension state (P2 runtime)");
          break;
        }
        if (character !== "player") {
          noteAction(a, a.type, "T2-dropped", "only the player's completed tile steps reach the kit step hook");
          break;
        }
        if (!tracker) { noteAction(a, a.type, "T4-dropped", "missing tracker id"); break; }
        if (a.type === "remove_step_tracker") {
          noteAction(a, a.type, "T1", "tux.remove_step_tracker deletes the saved tracker (missing tracker is a no-op)");
          out.push({ op: "ext", call: "tux.remove_step_tracker", args: { character, tracker } });
          break;
        }
        if (a.type === "set_step_tracker_milestone_shown") {
          const milestone = Number(g[2]);
          if (g[2] === undefined || g[2] === "" || !Number.isFinite(milestone)) {
            noteAction(a, a.type, "T4-dropped", "milestone is not a number");
            break;
          }
          noteAction(a, a.type, "T1", "tux.set_step_tracker_milestone_shown acknowledges a triggered milestone");
          out.push({ op: "ext", call: "tux.set_step_tracker_milestone_shown", args: { character, tracker, milestone } });
          break;
        }
        const countdown = Number(g[2]);
        const milestones = g[3] ? g[3].split(":").map(Number) : [];
        const autoReset = g[4] === undefined || g[4] === "" ? false : g[4] === "true" ? true : g[4] === "false" ? false : null;
        const initial = g[5] === undefined || g[5] === "" ? undefined : Number(g[5]);
        if (g[2] === undefined || g[2] === "" || !Number.isFinite(countdown) || !milestones.every(Number.isFinite)
          || autoReset === null || (initial !== undefined && !Number.isFinite(initial))) {
          noteAction(a, a.type, "T4-dropped", "countdown, milestones, auto-reset or initial countdown is malformed");
          break;
        }
        noteAction(
          a,
          a.type,
          "T1-lowered",
          "tux.add_step_tracker saves a countdown advanced by the kit playerStep hook: one per completed tile, where upstream applies the signed tile delta (dx+dy, so up/left steps and teleport jumps also count)",
        );
        out.push({ op: "ext", call: "tux.add_step_tracker", args: {
          character, tracker, countdown, milestones,
          ...(autoReset ? { autoReset } : {}),
          ...(initial === undefined ? {} : { initialCountdown: initial }),
        } });
        break;
      }
      case "set_mission":
        // Upstream only walks missions already held by the character's
        // MissionManager, which is filled solely by decoding a save; no
        // script or engine path creates a mission, so a game started from
        // the pinned content never holds one and the action logs and stops.
        noteAction(a, a.type, "T1", "upstream no-op: no mission is ever created, so none can meet its prerequisites");
        break;
      case "autosave":
        noteAction(a, a.type, "T1", "kit autosave command publishes an exact-tick snapshot to the host's dedicated slot");
        out.push({ op: "autosave" });
        break;
      case "access_pc":
        if (ctx.options.battle && g[0] === "player") {
          noteAction(a, a.type, "T1-lowered", "tux.pc monster storage (pick up, drop off, move, release); no item locker, email or multiplayer entries");
          out.push(pcScene());
        } else noteAction(a, a.type, "T3-dropped", ctx.options.battle ? "PC storage is modelled for the player only" : "monster/combat subsystem (P2)");
        break;
      case "create_kennel":
        if (ctx.options.battle && g[0] === "player" && g[1]
          && (g[3] === undefined || /^[1-9]\d*$/.test(g[3]))) {
          noteAction(a, a.type, "T1", "tux.create_kennel adds a saved player box (hidden flag, capacity)");
          out.push({ op: "ext", call: "tux.create_kennel", args: {
            character: "player",
            kennel: g[1],
            hidden: parseFlag(g[2]),
            ...(g[3] === undefined ? {} : { capacity: Math.min(30, Number(g[3])) }),
          } });
        } else noteAction(a, a.type, "T3-dropped", ctx.options.battle ? "boxes are modelled for the player only" : "monster/combat subsystem (P2)");
        break;
      case "set_kennel_visible":
        // Upstream raises for the main Kennel; that call can never succeed.
        if (ctx.options.battle && g[0] === "player" && g[1] && g[1] !== "Kennel") {
          noteAction(a, a.type, "T1", "tux.set_kennel_visible toggles a saved player box");
          out.push({ op: "ext", call: "tux.set_kennel_visible", args: {
            character: "player",
            kennel: g[1],
            visible: parseFlag(g[2]),
          } });
        } else noteAction(a, a.type, "T3-dropped", ctx.options.battle ? "boxes are modelled for the player only; the main Kennel cannot be hidden" : "monster/combat subsystem (P2)");
        break;
      case "trading":
        if (ctx.options.battle && g[0] && g[1] && monsterSlugs.has(g[1])) {
          noteAction(a, a.type, "T1", "tux.trade scene: scripted trade into the same party slot, caught entry, eight-second transition");
          out.push({ op: "scene", id: "tux.trade", args: labelArgs({
            variable: varId(g[0]),
            species: g[1],
            message: poText("trade_completed"),
          }) } as Command);
        } else noteAction(a, a.type, "T3-dropped", ctx.options.battle ? "monster-for-monster trades with another party are not modelled" : "monster/combat subsystem (P2)");
        break;
      case "daycare":
        if (ctx.options.battle && g[0] === "player") {
          noteAction(a, a.type, "T1", "tux.daycare two-slot storage, per-step training, deterministic breeding and newborn collection");
          out.push(daycareScene());
        } else {
          noteAction(a, a.type, "T3-dropped", ctx.options.battle
            ? "daycare is modelled for the player only"
            : "monster/combat subsystem (P2)");
        }
        break;
      case "park_experience":
        noteAction(a, a.type, "T3-dropped", "Safari-park session (Eclipse park); not part of the Spyder campaign");
        break;
      case "update_time":
        noteAction(a, a.type, "T1", "tux.update_time writes eight variables from the saved deterministic calendar");
        out.push({ op: "ext", call: "tux.update_time", args: updateTimeArgs(a) });
        break;
      case "add_tech": {
        if (!ctx.options.battle) { noteAction(a, a.type, "T3-dropped", "monster/combat subsystem (P2)"); break; }
        const variable = g[0]!;
        const technique = g[1]!;
        if (!variable || !technique) { noteAction(a, a.type, "T4-dropped", "missing variable or technique"); break; }
        noteAction(a, a.type, "T1", "tux.add_tech teaches the iid-named monster a technique (deduped, no cap)");
        out.push({ op: "ext", call: "tux.add_tech", args: { variable: varId(variable), technique } });
        break;
      }
      case "char_plague": {
        if (!ctx.options.battle) { noteAction(a, a.type, "T3-dropped", "plague is P2"); break; }
        const plague = g[0]!;
        if (!plague) { noteAction(a, a.type, "T4-dropped", "missing plague slug"); break; }
        const condition = g[1] ? g[1]!.toLowerCase() : null;
        if (condition !== null && condition !== "infected" && condition !== "inoculated") {
          noteAction(a, a.type, "T4-dropped", `unsupported plague condition '${g[1]}'`);
          break;
        }
        const character = g[2] || "player";
        noteAction(a, a.type, "T1", condition === null
          ? "tux.char_plague clears a plague on a character's party"
          : `tux.char_plague marks a character's party ${condition}`);
        out.push({ op: "ext", call: "tux.char_plague", args: { plague, condition, character } });
        break;
      }
      case "quarantine": {
        if (!ctx.options.battle) { noteAction(a, a.type, "T3-dropped", "plague is P2"); break; }
        const character = g[0] || "player";
        const plague = g[1]!;
        const action = g[2]!;
        if (!plague || (action !== "in" && action !== "out")) {
          noteAction(a, a.type, "T4-dropped", "missing plague slug or invalid action");
          break;
        }
        const args: Record<string, JsonValue> = { character, plague, action };
        if (g[3] !== undefined && g[3] !== "") args.amount = Number(g[3]);
        noteAction(a, a.type, "T1-lowered", "tux.quarantine transfers infected monsters to/from the hidden quarantine box, honouring its own capacity; a full box keeps the monster in the party and a full party+kennel release keeps it in the box (upstream renames a full box into a successor and overflows the Kennel past its capacity)");
        out.push({ op: "ext", call: "tux.quarantine", args });
        break;
      }
      case "change_bg_monster": {
        const background = g[0]!;
        const monster = g[1]!;
        if (!background || !monster) {
          noteAction(a, a.type, "T4-dropped", "missing background or monster slug");
          break;
        }
        const variant = ensureMonsterBackdrop(background, monster);
        if (!variant) {
          noteAction(a, a.type, "T4-dropped", "background or monster front sprite is unavailable");
          break;
        }
        noteAction(a, a.type, "T1", "monster front battle sprite centered on the blocking screen backdrop; the following dialog opens on top, like the upstream MonsterImageState");
        out.push({ op: "screenBackdrop", layer: SCREEN_BACKDROP_LAYER, variant });
        break;
      }
      default:
        noteAction(a, a.type, "T4-dropped", "presentation / meta");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// events

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "event";
const BLOCKING = new Set<Command["op"]>([
  "text", "choices", "shop", "wait", "transfer", "moveRoute", "battle", "screenFade", "scene",
]);
const hasBlocking = (cmds: Command[]): boolean =>
  cmds.some((c) => BLOCKING.has(c.op) || (c.op === "if" && (hasBlocking(c.then) || hasBlocking(c.else ?? []))) || (c.op === "choices"));
const hasCommand = (cmds: readonly Command[], wanted: FutureCommand["op"]): boolean =>
  cmds.some((c) => {
    if ((c as FutureCommand).op === wanted) return true;
    if (c.op === "if") return hasCommand(c.then, wanted) || hasCommand(c.else ?? [], wanted);
    if (c.op === "choices") {
      return c.options.some((option) => hasCommand(option.commands, wanted)) ||
        hasCommand(c.cancel?.commands ?? [], wanted);
    }
    return false;
  });

interface NpcAgg {
  slug: string;
  x: number;
  y: number;
  wander: boolean;
  /** KM1 wander cadence grade, when a spawn-event char_wander named it. */
  wanderFrequency?: MoveFrequency;
  /** KM1 wander bounds, when a spawn-event char_wander supplied them. */
  wanderBounds?: WanderBounds;
  face?: string;
  talks: { cls: Clause[]; cmds: Command[] }[];
}

interface SpatialPage {
  id: string;
  name: string;
  trigger: "playerTouch" | "action";
  cls: Clause[];
  cmds: Command[];
  /** Commands whose coordinates follow the final coalesced rectangle. */
  regionCommands?: (x: number, y: number, w: number, h: number) => Command[];
  cells: readonly [number, number][];
}

const SPYDER_SURF_EVENTS = new Set([
  "Choice Surf",
  "Push Into Water Down",
  "Push Into Water Left",
  "Push Into Water Right",
  "Push Into Water Up",
  "Surfable",
  "Not surfable",
]);

const isSpyderSurfEvent = (event: TuxEvent): boolean =>
  event.source === "spyder.yaml" && SPYDER_SURF_EVENTS.has(event.name);

function convertMap(
  m: TuxMap,
  options: ImportOptions,
  surfaceLabels: Readonly<Record<string, readonly number[]>>,
  seamlessPortalIds: ReadonlySet<string>,
): { map: MapDef; sprites: Record<string, SpriteDef> } {
  const events: GameEvent[] = [];
  const sprites: Record<string, SpriteDef> = {};
  const npcs = new Map<string, NpcAgg>();
  const hasSpyderSurfScenario = m.props.scenario === "spyder" &&
    m.events.some(isSpyderSurfEvent);
  const npcOf = (s: string, x = 0, y = 0): NpcAgg => npcs.get(s) ?? npcs.set(s, { slug: s, x, y, wander: false, talks: [] }).get(s)!;
  let n = 0;
  const nextId = (name: string) => `e${String(++n).padStart(3, "0")}_${slug(name)}`;
  /** touch/action pages by cell: Tuxemon may stack several guarded events
   *  on one cell (e.g. "My First Mon" / "... - Not Met"); the kit starts
   *  only the first eligible event per trigger, so they merge below. */
  const cellPages = new Map<string, { id: string; name: string; x: number; y: number; trigger: "playerTouch" | "action"; cls: Clause[]; cmds: Command[] }[]>();
  /** K1 areas are partitioned after every source event is known. A partition
   *  has one exact ordered set of source events, which lets overlapping
   *  rectangles keep Tuxemon's "sample every guard, then run every matching
   *  body" semantics without expanding otherwise-disjoint large areas. */
  const spatialPages: SpatialPage[] = [];
  /** Surf boundaries are emitted after the source-authored partition. Keeping
   *  them separate preserves every pre-existing region id and keeps their
   *  false pages out of legacy saves made before the Surfboard is acquired. */
  const surfSpatialPages: SpatialPage[] = [];
  /** Authored cells whose `player,moving,1` guard becomes playerTouch. A Surf
   *  dismount on the same cell must join that source page's latch/body chain:
   *  two independent playerTouch events would compete for one step edge. */
  const movingTouchCells = new Set<string>();
  const collisionRegions = readCollisionRegions(join(MAPS_DIR, `${m.slug}.tmx`));
  const economies = new Map<string, string>();
  for (const event of m.events) {
    for (const action of event.acts) {
      if (action.type === "set_economy" && action.args[0] && action.args[1]) {
        economies.set(action.args[0], action.args[1]);
      }
    }
  }

  // NPCs first: every create_npc on this map names one NPC event
  for (const e of m.events) for (const a of e.acts) if (a.type === "create_npc") {
    const agg = npcOf(a.args[0]!, Number(a.args[1]), Number(a.args[2]));
    if (a.args[3] === "wander") agg.wander = true;
  }

  for (const e of m.events) {
    const eventCoverage = new EventCoverage(e);
    activeCoverage = eventCoverage;
    try {
      // The shared Spyder scenario expresses surfing through dynamic
      // `char_in` / `char_facing_tile` terrain predicates. Project v1 has no
      // live-player-cell condition, but the imported terrain already exposes
      // the exact surfable cell set. Lower the seven cooperating source
      // events together into boundary action/touch pages below instead of
      // dropping them or (worse) allowing their remaining guards to run
      // unconditionally.
      if (isSpyderSurfEvent(e)) {
        // Before surf lowering, the partially convertible Not surfable page
        // occupied one sequential source-event id on every Spyder map. Keep
        // that slot reserved so adding this capability cannot renumber any
        // unrelated imported page or invalidate frozen journey ancestry.
        if (e.name === "Not surfable") nextId(e.name);
        if (!(surfaceLabels.surfable?.length)) {
          const reason = "this map has no authored surfable cells";
          eventCoverage.dropAll(reason);
          note("trigger", "surf(no surface)", "T4-dropped", reason);
          continue;
        }
        const reason = "surfable boundary pages preserve the shared Spyder item, choice, movement, appearance, and dismount flow";
        for (const action of e.acts) {
          const exact = action.type === "translated_dialog" ||
            action.type === "translated_dialog_choice" || action.type === "set_variable";
          noteAction(action, action.type, exact ? "T1" : "T1-lowered", reason);
        }
        for (const condition of e.conds) {
          const exact = condition.type === "has_item" || condition.type === "button_pressed" ||
            condition.type === "variable_set" || condition.type === "tile_property_updated" ||
            condition.type === "current_state" || condition.type === "char_sprite";
          noteCondition(condition, `${condition.op} ${condition.type}`, exact ? "T1" : "T1-lowered", reason);
        }
        note("trigger", "surf(boundary lowering)", "T1-lowered", reason);
        continue;
      }
      if (!e.conds.some((condition) => !condition.synthetic) && !e.behavs.length) {
        const reason = "Tuxemon never starts an event without source conditions or behavior";
        eventCoverage.dropAll(reason);
        note("trigger", "inert(no conditions or behavior)", "T4-dropped", reason);
        continue;
      }
      if (e.origin === "tmx" && (e.w === 0 || e.h === 0)) {
        const reason = "Tuxemon's integer tile boundary never contains a point for a zero-size TMX event";
        eventCoverage.dropAll(reason);
        note("trigger", "inert(zero-size TMX area)", "T4-dropped", reason);
        continue;
      }
      const cls0 = e.conds.map((c) => clauses(
        c,
        m,
        options,
        surfaceLabels,
      ));
      const cls: Clause[] = cls0.filter((x): x is Clause[] => x !== null).flat();
      const fixedFalse = cls.find((clause) => clause.k === "const" && !clause.value);
      if (fixedFalse?.k === "const") {
        const reason = fixedFalse.reason
          ? `fixed-false guard (${fixedFalse.reason}) prevents the source event from starting`
          : "fixed-false guard prevents the source event from starting";
        eventCoverage.dropAll(reason);
        note("trigger", "never-true guard", "T4-dropped", reason);
        continue;
      }
      const live = cls.filter((c) => c.k !== "const");
      for (const b of e.behavs) note("behav", b.type, "structural", "talk -> NPC action page");
      const k = triggerClass(e);

      // spawn: guard + create_npc -> a parallel page flipping local.npc.<slug>
      if (k === "spawn") {
        const wanderControls: { slug: string; control: MoveControl }[] = [];
        for (const a of e.acts) {
          if (a.type === "char_face") {
            if (npcs.has(a.args[0]!) && DIRS.has(a.args[1]!)) {
              npcOf(a.args[0]!).face = a.args[1];
              noteAction(a, a.type, "T1-lowered", "spawn facing becomes the NPC page route");
            } else {
              noteAction(a, "char_face(spawn unsupported)", "T2-dropped", "spawn target or direction is unavailable");
            }
          }
          if (a.type === "char_wander") {
            if (npcs.has(a.args[0]!)) {
              const agg = npcOf(a.args[0]!);
              agg.wander = true;
              if (options.moveControl) {
                // Upstream: `self.frequency or DEFAULT_FREQUENCY` (None or
                // 0 -> 1.0s), clipped to [0.5, 5]s.
                const freq = Math.max(0.5, Math.min(5, numeric(a.args[1], 1)));
                agg.wanderFrequency = frequencyGrade(freq);
                const [tx, ty, bx, by] = [a.args[2], a.args[3], a.args[4], a.args[5]]
                  .map((v) => (v === undefined || v === "" ? NaN : Number(v)));
                if ([tx, ty, bx, by].every(Number.isFinite) && bx >= tx && by >= ty) {
                  agg.wanderBounds = { x: tx, y: ty, width: bx - tx + 1, height: by - ty + 1 };
                }
                const control: MoveControl = { kind: "wander", frequency: agg.wanderFrequency };
                if (agg.wanderBounds) control.bounds = agg.wanderBounds;
                wanderControls.push({ slug: agg.slug, control });
                noteAction(a, a.type, "T1-lowered", "KM1 moveControl wander (seeded RNG, dialog-pausing; seconds -> nearest MV frequency grade)");
              } else {
                noteAction(a, a.type, "T1-lowered", "NPC page uses random movement; frequency/bounds are omitted");
              }
            } else {
              noteAction(a, "char_wander(missing npc)", "T2-dropped", "spawn target is unavailable");
            }
          }
        }
        const cmds = convertActions(
          e.acts.filter((a) => a.type !== "char_face" && a.type !== "char_wander"),
          { m, options, economies, surfaceLabels, sourceEvent: e, seamlessPortalIds },
        );
        for (const wander of wanderControls) {
          cmds.push(command({ op: "moveControl", target: { event: `npc_${slug(wander.slug)}` }, control: wander.control }));
        }
        const blocking = hasBlocking(cmds);
        const page = blocking
          // A blocking spawn usually writes the same local.npc variable its
          // `not char_exists` guard reads. Keeping that guard on the page
          // would make K1 cancel the parallel fiber on the following frame,
          // halfway through its cutscene. Keep the page alive and evaluate
          // the complete guard inside the fiber instead; on the next restart
          // it is false and the body becomes a no-op.
          ? { trigger: "parallel" as const, sprite: null, commands: guard(live, cmds) }
          : (() => {
              const { cond, rest } = pageCondition(live, options);
              return { trigger: "parallel" as const, condition: cond, sprite: null, commands: guard(rest, cmds) };
            })();
        events.push({ id: nextId(e.name), name: `${e.name} (spawn guard)`, x: e.x, y: e.y, pages: [page] });
        note(
          "trigger",
          "spawn",
          "T1-lowered",
          blocking
            ? "parallel page keeps its fiber alive while an internal guard runs the cutscene once"
            : "parallel page: guard -> local.npc.<slug> = 1",
        );
        continue;
      }

      // talk: fold into the NPC's action page
      const talk = e.behavs.find((b) => b.type === "talk");
      if (talk) {
        const agg = npcOf(talk.args[0]!);
        agg.talks.push({
          cls: live,
          cmds: convertActions(e.acts, { m, options, economies, surfaceLabels, sourceEvent: e, seamlessPortalIds, self: talk.args[0] }),
        });
        note("trigger", "talk", "T1", "NPC event action page (if-chain over talk guards)");
        continue;
      }

      const cmds = convertActions(e.acts, { m, options, economies, surfaceLabels, sourceEvent: e, seamlessPortalIds });
      if (!cmds.length) {
        const reason = "every action was removed, so no project event was emitted";
        eventCoverage.dropAll(reason);
        note("trigger", "no-op after conversion", "T4-dropped", reason);
        continue;
      }
      const cells: [number, number][] = [];
      for (let dy = 0; dy < Math.max(1, e.h); dy++) {
        for (let dx = 0; dx < Math.max(1, e.w); dx++) {
          const x = e.x + dx;
          const y = e.y + dy;
          if (x >= 0 && y >= 0 && x < m.width && y < m.height) cells.push([x, y]);
        }
      }

      if (k.startsWith("touch") || k.startsWith("action")) {
        const trigger = k.startsWith("touch") ? "playerTouch" : "action";
        if (!cells.length) {
          const reason = "source trigger area lies outside the map";
          eventCoverage.dropAll(reason);
          note("trigger", `${k}(outside map)`, "T4-dropped", reason);
          continue;
        }
        if (options.areas) {
          if (e.conds.some((condition) => condition.op === "is" &&
            condition.type === "check_char_parameter" &&
            condition.args[0] === "player" && condition.args[1] === "moving" &&
            condition.args[2] === "1")) {
            for (const [x, y] of cells) movingTouchCells.add(`${x},${y}`);
          }
          spatialPages.push({
            id: nextId(e.name),
            name: e.name,
            trigger,
            cls: live,
            cmds,
            cells,
          });
          note("trigger", `${k}(area)`, "T1", "K1 rectangular event area (overlaps partitioned after guard sampling)");
          continue;
        }
        if (cells.length > AREA_CELL_CAP) {
          if (!hasBlocking(cmds) && e.acts.some((action) => action.type === "add_tracker")) {
            const { cond, rest } = pageCondition(live, options);
            events.push({
              id: nextId(e.name),
              name: `${e.name} (whole-map lowering)`,
              x: cells[0]![0],
              y: cells[0]![1],
              pages: [{ trigger: "parallel", condition: cond, sprite: null, commands: guard(rest, cmds) }],
            });
            note("trigger", `${k}(whole-map tracker)`, "T1-lowered", "parallel visit tracker avoids expanding the full map");
          } else {
            const reason = `source trigger area exceeds the v1 ${AREA_CELL_CAP}-cell expansion cap`;
            eventCoverage.dropAll(reason);
            note("trigger", `${k}(area>${AREA_CELL_CAP})`, "T2-dropped", reason);
          }
          continue;
        }
        const base = nextId(e.name);
        const movingTouch = e.conds.some((condition) => condition.op === "is" &&
          condition.type === "check_char_parameter" &&
          condition.args[0] === "player" && condition.args[1] === "moving" &&
          condition.args[2] === "1");
        cells.forEach(([x, y], i) => {
          const key = `${trigger}|${x},${y}`;
          const list = cellPages.get(key) ?? cellPages.set(key, []).get(key)!;
          if (movingTouch) movingTouchCells.add(`${x},${y}`);
          list.push({ id: cells.length > 1 ? `${base}_${i}` : base, name: e.name, x, y, trigger, cls: live, cmds });
        });
        note("trigger", k, cells.length > 1 ? "T1-lowered" : "T1", cells.length > 1 ? "area expanded to one event per cell" : trigger);
        continue;
      }

      // Tuxemon starts every eligible automatic event in the same update.
      // Give each source event its own parallel fiber so one event changing a
      // shared guard cannot prevent its siblings from starting (route1's four
      // grunt departure routes are the canonical case).
      const blocking = hasBlocking(cmds);
      const body = e.kind === "init" ? [...cmds, { op: "erase" } as Command] : cmds;
      if (!live.length) {
        events.push({ id: nextId(e.name), name: e.name, x: e.x, y: e.y, pages: [{ trigger: "parallel", sprite: null, commands: body }] });
      } else if (blocking) {
        // Once an automatic action has started, Tuxemon lets it finish even
        // if a sibling changes the condition that launched it. Keep the page
        // itself alive and sample the source guard inside the new fiber.
        events.push({ id: nextId(e.name), name: e.name, x: e.x, y: e.y, pages: [{ trigger: "parallel", sprite: null, commands: guard(live, body) }] });
      } else {
        const { cond, rest } = pageCondition(live, options);
        events.push({ id: nextId(e.name), name: e.name, x: e.x, y: e.y, pages: [{ trigger: "parallel", condition: cond, sprite: null, commands: guard(rest, body) }] });
      }
      note(
        "trigger",
        e.kind === "init" ? "init" : k,
        "T1",
        blocking ? "parallel automatic fiber (blocking commands arbitrate their own UI)" : "parallel",
      );
    } finally {
      conversionCoverage.commit(eventCoverage);
      activeCoverage = undefined;
    }
  }

  const surfable = surfaceLabels.surfable ?? [];
  if (hasSpyderSurfScenario && surfable.length) {
    const surface = new Set(surfable);
    // The action side may cover every surfable cell: its not-swimming guard
    // means ordinary play can only reach it from shore. Keep the touch side
    // to adjacent land, however, so a false swimmer guard never creates a
    // movement-trigger fiber in the middle of unrelated land routes.
    const waterBoundary = [...surfable].sort((a, b) => a - b);
    const neighbors = (index: number): number[] => {
      const x = index % m.width;
      const y = Math.floor(index / m.width);
      const out: number[] = [];
      if (x > 0) out.push(index - 1);
      if (x + 1 < m.width) out.push(index + 1);
      if (y > 0) out.push(index - m.width);
      if (y + 1 < m.height) out.push(index + m.width);
      return out;
    };
    const shorelineWater = surfable.filter((index) =>
      neighbors(index).some((neighbor) => !surface.has(neighbor))
    );
    const landBoundary = [...new Set(shorelineWater.flatMap((index) =>
      neighbors(index).filter((neighbor) => !surface.has(neighbor))
    ))].sort((a, b) => a - b);
    const swimmingYes = code("swimming", "yes");
    const swimmingNo = code("swimming", "no");
    const addCellPage = (page: Omit<SpatialPage, "cells">, x: number, y: number): void => {
      if (options.areas) {
        surfSpatialPages.push({ ...page, cells: [[x, y]] });
        return;
      }
      const { cond, rest } = pageCondition(page.cls, options);
      events.push({
        id: `${page.id}_${String(y * m.width + x).padStart(5, "0")}`,
        name: page.name,
        x,
        y,
        pages: [{
          trigger: page.trigger,
          condition: cond,
          sprite: null,
          commands: guard(rest, page.cmds),
        }],
      });
    };

    const enterCommands = (x: number, y: number, w: number, h: number): Command[] => [
      { op: "variable", id: varId("swimming"), set: { op: "set", value: swimmingYes } },
      // Open this coalesced shoreline rectangle before the source's automatic
      // push. The upstream Allow Swim page opens the whole label on the next
      // world tick; rectangle-local commands avoid repeating a map-wide cell
      // list in every boundary event.
      ...Array.from({ length: w * h }, (_, index): Command => ({
        op: "tileProperty",
        x: x + index % w,
        y: y + Math.floor(index / w),
        passage: "pass",
      })),
      { op: "appearance", target: "player", sprite: "swimmer" },
      {
        op: "moveRoute",
        target: "player",
        wait: true,
        route: { steps: ["stepForward"], repeat: false, skippable: true },
      },
    ];
    const commandsFor = (x: number, y: number, w: number, h: number): Command[] => [
      ...dialog("itsswimmingtime", m),
      {
        op: "choices",
        prompt: "",
        options: [
          { text: (po.get("yes") ?? "Yes").slice(0, 24), commands: enterCommands(x, y, w, h) },
          {
            text: (po.get("no") ?? "No").slice(0, 24),
            commands: [{ op: "variable", id: varId("swimming"), set: { op: "set", value: swimmingNo } }],
          },
        ],
      },
    ];
    const enter: Omit<SpatialPage, "cells"> = {
      id: "tux_surf_enter",
      name: "Choice Surf",
      trigger: "action",
      cls: [
        { k: "item", id: "surfboard", count: 1, has: true },
        { k: "var", id: varId("swimming"), op: "!=", value: swimmingYes },
      ],
      cmds: [],
      regionCommands: commandsFor,
    };
    if (options.areas) {
      surfSpatialPages.push({
        ...enter,
        cells: waterBoundary.map((index) => [
          index % m.width,
          Math.floor(index / m.width),
        ] as [number, number]),
      });
    } else {
      for (const index of waterBoundary) {
        const x = index % m.width;
        const y = Math.floor(index / m.width);
        addCellPage({ ...enter, cmds: commandsFor(x, y, 1, 1), regionCommands: undefined }, x, y);
      }
    }

    const dismount: Omit<SpatialPage, "cells"> = {
      id: "tux_surf_dismount",
      name: "Not surfable",
      trigger: "playerTouch",
      cls: [{
        k: "native",
        condition: { kind: "appearance", target: "player", sprite: "swimmer" },
        negate: false,
      }],
      cmds: [
        { op: "appearance", target: "player", sprite: null },
        { op: "variable", id: varId("swimming"), set: { op: "set", value: swimmingNo } },
      ],
    };
    if (options.areas) {
      const contended = landBoundary.filter((index) =>
        movingTouchCells.has(`${index % m.width},${Math.floor(index / m.width)}`)
      );
      const standalone = landBoundary.filter((index) =>
        !movingTouchCells.has(`${index % m.width},${Math.floor(index / m.width)}`)
      );
      // Tuxemon samples all matching guards before running their bodies. Fold
      // a colliding completed-step encounter and Surf dismount into the same
      // source partition so both run in order from one playerTouch edge. The
      // remaining Surf cells stay separate to preserve source region IDs.
      if (contended.length) {
        spatialPages.push({
          ...dismount,
          cells: contended.map((index) => [
            index % m.width,
            Math.floor(index / m.width),
          ] as [number, number]),
        });
      }
      if (standalone.length) {
        surfSpatialPages.push({
          ...dismount,
          cells: standalone.map((index) => [
            index % m.width,
            Math.floor(index / m.width),
          ] as [number, number]),
        });
      }
    } else {
      for (const index of landBoundary) {
        const x = index % m.width;
        const y = Math.floor(index / m.width);
        const sourcePages = cellPages.get(`playerTouch|${x},${y}`);
        if (movingTouchCells.has(`${x},${y}`) && sourcePages?.length) {
          sourcePages.push({ ...dismount, x, y });
        } else {
          addCellPage(dismount, x, y);
        }
      }
    }
    note(
      "trigger",
      "surf(boundary pages)",
      "T1-lowered",
      `${waterBoundary.length} water entry cells and ${landBoundary.length} adjacent dismount cells`,
    );
  }

  // A transfer rebuilds the map interpreter, so commands authored after
  // teleport_faint cannot remain on the source-map fiber.  Preserve the
  // upstream-visible recovery notice with a one-shot destination fiber.
  if (options.battle && faintPointMaps.has(m.slug)) {
    events.push({
      id: nextId("Faint Recovery Notice"),
      name: "Faint Recovery Notice",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        sprite: null,
        // Keep the page alive after consuming its own switch. At low host
        // rates several reference ticks fold into one frame; a page-level
        // condition would otherwise cancel the text before it is presented.
        commands: guard([{ k: "sw", id: FAINT_NOTICE_SWITCH, on: true }], [
          { op: "switch", id: FAINT_NOTICE_SWITCH, value: false },
          ...dialog("heal_before_leave", m),
        ]),
      }],
    });
  }

  if (options.areas) {
    // Make a cell membership grid for each trigger. Greedily coalesce equal
    // membership signatures into rectangles. At an overlap, one event owns
    // the rectangle and snapshots every member's guard before any body runs;
    // this is the same latch used by the v1 per-cell lowering below.
    const membership = new Map<string, number[]>();
    spatialPages.forEach((page, index) => {
      for (const [x, y] of page.cells) {
        const key = `${page.trigger}|${x},${y}`;
        const members = membership.get(key) ?? [];
        members.push(index);
        membership.set(key, members);
      }
    });
    const sameMembers = (trigger: "playerTouch" | "action", x: number, y: number, signature: string): boolean =>
      (membership.get(`${trigger}|${x},${y}`) ?? []).join(",") === signature;
    const visited = new Set<string>();
    let region = 0;
    for (const trigger of ["playerTouch", "action"] as const) {
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          const cellKey = `${trigger}|${x},${y}`;
          const members = membership.get(cellKey);
          if (!members?.length || visited.has(cellKey)) continue;
          const signature = members.join(",");
          let w = 1;
          while (x + w < m.width && !visited.has(`${trigger}|${x + w},${y}`) &&
                 sameMembers(trigger, x + w, y, signature)) w++;
          let h = 1;
          rows: while (y + h < m.height) {
            for (let dx = 0; dx < w; dx++) {
              const next = `${trigger}|${x + dx},${y + h}`;
              if (visited.has(next) || !sameMembers(trigger, x + dx, y + h, signature)) break rows;
            }
            h++;
          }
          for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) visited.add(`${trigger}|${x + dx},${y + dy}`);
          }

          const pages = members.map((index) => spatialPages[index]!);
          const first = pages[0]!;
          let condition: FuturePageCondition | undefined;
          let commands: Command[];
          if (pages.length === 1) {
            const page = pageCondition(first.cls, options);
            condition = page.cond;
            commands = guard(page.rest, first.regionCommands?.(x, y, w, h) ?? first.cmds);
          } else {
            const flag = (i: number) => `local.area.${m.slug}.${region}.${i}`;
            commands = [];
            pages.forEach((page, i) => {
              if (page.cls.length) {
                commands.push(
                  { op: "switch", id: flag(i), value: false },
                  ...guard(page.cls, [{ op: "switch", id: flag(i), value: true }]),
                );
              }
            });
            pages.forEach((page, i) => commands.push(...(
              page.cls.length
                ? [{
                    op: "if",
                    if: { kind: "switch", id: flag(i), value: true },
                    then: page.regionCommands?.(x, y, w, h) ?? page.cmds,
                  } as Command]
                : (page.regionCommands?.(x, y, w, h) ?? page.cmds)
            )));
            note("trigger", "stacked event areas", "T1-lowered", "partitioned: match flags then bodies");
          }
          events.push(gameEvent({
            id: `${first.id}_r${String(++region).padStart(3, "0")}`,
            name: pages.map((page) => page.name).join(" + "),
            x,
            y,
            w,
            h,
            pages: [{ trigger, condition, sprite: null, commands }],
          }));
        }
      }
    }

    // Surf's generated boundaries must not participate in the source-page
    // membership signatures above: doing so splits old rectangles and
    // renumbers their stable rNNN ids. Each Surf page has its own trigger, so
    // it can be coalesced independently and appended under a reserved id.
    let surfRegion = 0;
    for (const source of surfSpatialPages) {
      const cells = new Set(source.cells.map(([x, y]) => y * m.width + x));
      const visited = new Set<number>();
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          const cell = y * m.width + x;
          if (!cells.has(cell) || visited.has(cell)) continue;
          let w = 1;
          while (x + w < m.width) {
            const next = y * m.width + x + w;
            if (!cells.has(next) || visited.has(next)) break;
            w++;
          }
          let h = 1;
          rows: while (y + h < m.height) {
            for (let dx = 0; dx < w; dx++) {
              const next = (y + h) * m.width + x + dx;
              if (!cells.has(next) || visited.has(next)) break rows;
            }
            h++;
          }
          for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) visited.add((y + dy) * m.width + x + dx);
          }
          const page = pageCondition(source.cls, options);
          events.push(gameEvent({
            id: `${source.id}_r${String(++surfRegion).padStart(3, "0")}`,
            name: source.name,
            x,
            y,
            w,
            h,
            pages: [{
              trigger: source.trigger,
              condition: page.cond,
              sprite: null,
              commands: guard(page.rest, source.regionCommands?.(x, y, w, h) ?? source.cmds),
            }],
          }));
        }
      }
    }
  }

  // one kit event per (trigger, cell): a lone Tuxemon event keeps its page
  // condition; stacked events become one unconditioned page that latches a
  // match flag per member, then runs every matched body (Tuxemon starts all
  // events whose guards hold on that frame).
  for (const list of cellPages.values()) {
    const first = list[0]!;
    if (list.length === 1) {
      const { cond, rest } = pageCondition(first.cls, options);
      const commands = guard(rest, first.cmds);
      events.push({ id: first.id, name: first.name, x: first.x, y: first.y, pages: [{ trigger: first.trigger, condition: cond, sprite: null, commands }] });
      continue;
    }
    const flag = (i: number) => `local.cell.${m.slug}.${first.id}.${i}`;
    const commands: Command[] = [];
    list.forEach((p, i) => { if (p.cls.length) commands.push({ op: "switch", id: flag(i), value: false }, ...guard(p.cls, [{ op: "switch", id: flag(i), value: true }])); });
    list.forEach((p, i) => commands.push(...(p.cls.length ? [{ op: "if", if: { kind: "switch", id: flag(i), value: true }, then: p.cmds } as Command] : p.cmds)));
    events.push({ id: first.id, name: list.map((p) => p.name).join(" + "), x: first.x, y: first.y, pages: [{ trigger: first.trigger, sprite: null, commands }] });
    note("trigger", "stacked events on one cell", "T1-lowered", "merged: match flags then bodies");
  }

  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // NPC events: page 0 absent; page 1 present while local.npc.<slug> == 1
  for (const agg of npcs.values()) {
    const row = npcDb.get(agg.slug);
    const spriteKey = row ? `npc.${row.template.sprite_name}` : "npc.missing";
    sprites[spriteKey] = { kind: "image", src: row ? `${row.template.is_static_prop ? "sprites_obj" : "sprites"}/${row.template.sprite_name}.png` : "missing.png" };
    // Tuxemon starts EVERY talk event whose guard holds on the INTERACT
    // frame, all guards read before any action runs. Mirror that: latch one
    // match flag per talk first, then run the matched bodies in authored
    // order (sequential where Tuxemon runs them concurrently).
    const chain: Command[] = [];
    const flag = (i: number) => `local.talk.${m.slug}.${slug(agg.slug)}.${i}`;
    agg.talks.forEach((t, i) => {
      if (t.cls.length) chain.push({ op: "switch", id: flag(i), value: false }, ...guard(t.cls, [{ op: "switch", id: flag(i), value: true }]));
    });
    agg.talks.forEach((t, i) => {
      if (!t.cls.length) chain.push(...t.cmds);
      else chain.push({ op: "if", if: { kind: "switch", id: flag(i), value: true }, then: t.cmds });
    });
    const destroyItem = worldDestroyItems.find((candidate) =>
      candidate.targetSprite === row?.template.sprite_name
    );
    if (destroyItem) {
      const fallback = chain.splice(0);
      chain.push({
        op: "if",
        if: { kind: "item", id: destroyItem.item, count: 1 },
        then: [
          { op: "text", lines: [destroyItem.success] },
          {
            op: "variable",
            id: varId(agg.slug),
            set: { op: "set", value: code(agg.slug, "remove_entity") },
          },
          { op: "variable", id: npcVar(agg.slug), set: { op: "set", value: 0 } },
        ],
        ...(fallback.length ? { else: fallback } : {}),
      });
      note(
        "behav",
        "world remove_entity item",
        "T1-lowered",
        `held ${destroyItem.item} auto-uses when interacting with facing_sprite ${destroyItem.targetSprite}`,
      );
    }
    if (agg.talks.length) {
      if (options.routes) {
        chain.unshift(command({
          op: "moveRoute",
          target: "this",
          wait: false,
          route: { steps: ["turnTowardPlayer"], repeat: false, skippable: true },
        }));
        note("behav", "talk(char_face npc,player)", "T1", "K2 turnTowardPlayer route step");
      } else {
        note("behav", "talk(char_face npc,player)", "T2-dropped", "turn toward the player needs a turnTowardPlayer move step");
      }
    }
    const present: Page = {
      condition: { variable: { id: npcVar(agg.slug), op: "==", value: 1 } },
      trigger: "action",
      sprite: spriteKey,
      blocks: true,
      moveType: agg.wander ? "random" : "static",
      ...(agg.wanderFrequency ? { moveFrequency: agg.wanderFrequency } : {}),
      commands: chain,
    };
    if (!agg.wander && agg.face) {
      if (options.place) (present as Page & { dir?: Dir }).dir = agg.face as Dir;
      else present.moveRoute = { steps: [FACE[agg.face]!], repeat: true, skippable: true };
    }
    events.push({
      id: `npc_${slug(agg.slug)}`,
      name: agg.slug,
      x: Math.max(0, Math.min(m.width - 1, agg.x)),
      y: Math.max(0, Math.min(m.height - 1, agg.y)),
      pages: [{ trigger: "action", sprite: null, commands: [] }, present],
    });
  }

  // Keyed collision rectangles become removable event bodies instead of
  // permanent terrain blocks.
  let collisionEvent = 0;
  for (const region of collisionRegions) {
    if (!region.key) continue;
    for (const [x, y] of region.cells) {
      if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
      events.push({
        id: `collision_${slug(region.key)}_${++collisionEvent}`,
        name: `collision:${region.key}`,
        x,
        y,
        pages: [
          { trigger: "action", sprite: null, blocks: true, commands: [] },
          {
            trigger: "action",
            condition: {
              variable: { id: collisionVar(m.slug, region.key), op: "==", value: 1 },
            },
            sprite: null,
            blocks: false,
            commands: [],
          },
        ],
      });
    }
  }

  // Upstream change_map clears every non-persistent NPC on each transition,
  // party included. Imported transfers clear just before they fire; any other
  // map entry (a demo warp) is caught here. Map entry resets the `local.`
  // bank, so one parallel page per map runs exactly once per visit.
  // Parallels start in ascending id order before any blocking fiber, so the
  // `e000_` id clears before any of this map's own events builds a party.
  if (options.battle) {
    events.push({
      id: "e000_npc_parties",
      name: "Map entry: clear non-persistent NPC parties",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        condition: { variable: { id: NPC_PARTIES_CLEARED_VARIABLE, op: "==", value: 0 } },
        sprite: null,
        commands: [
          clearNpcParties(),
          resetLayerVariant(),
          { op: "variable", id: NPC_PARTIES_CLEARED_VARIABLE, set: { op: "set", value: 1 } },
        ],
      }],
    });
  }

  // One invisible, terminal parallel page is restarted by the interpreter on
  // every active 60 Hz reference tick. The extension advances clock/weather
  // and publishes a numeric daylight target only at stage changes; the
  // following built-in branch starts the matching tint once. Combining both
  // jobs avoids dynamic extension page scans on every map tick. Fade, frozen
  // battle, fatal state, and absent host frames bypass the interpreter, so
  // the virtual clock pauses with the map world.
  // Appending the event keeps every imported source event id stable.
  if (options.battle) {
    const morning = DAYLIGHT_TINT_PROFILES.find((profile) => profile.stage === "morning")!;
    const dispatchProfiles = [
      morning,
      ...DAYLIGHT_TINT_PROFILES.filter((profile) => profile !== morning),
    ];
    let daylightDispatch: Command | undefined;
    for (let index = dispatchProfiles.length - 1; index >= 0; index--) {
      const profile = dispatchProfiles[index]!;
      daylightDispatch = {
        op: "if",
        if: {
          kind: "variable",
          id: DAYLIGHT_TARGET_VARIABLE,
          op: "==",
          value: profile.marker,
        },
        then: [
          {
            op: "screenTint",
            layer: DAYLIGHT_TINT_LAYER,
            color: { ...profile.color },
            duration: DAYLIGHT_TWEEN_SECONDS,
            wait: false,
          },
          {
            op: "variable",
            id: DAYLIGHT_STAGE_VARIABLE,
            set: { op: "set", value: profile.marker },
          },
          {
            op: "variable",
            id: DAYLIGHT_TARGET_VARIABLE,
            set: { op: "set", value: 0 },
          },
        ],
        ...(daylightDispatch ? { else: [daylightDispatch] } : {}),
      };
    }
    events.push({
      id: "tux_runtime_time_weather",
      name: "Tuxemon time, weather, and daylight",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        sprite: null,
        commands: [
          {
            op: "ext" as const,
            call: "tux.tick_time_weather",
            args: { daylight: true },
          },
          {
            op: "if" as const,
            if: {
              kind: "variable" as const,
              id: DAYLIGHT_TARGET_VARIABLE,
              op: "!=" as const,
              value: 0,
            },
            then: [daylightDispatch!],
          },
        ],
      }],
    });
  }

  // A handful of source cutscenes intentionally pass a control lock to a
  // second event, but one source map has no unlock action anywhere. Such a
  // lock cannot have a continuation in this map (and K1 resets locks only on
  // transfer), so close each affected page with a deterministic safety
  // unlock. This is corpus-derived rather than a per-map patch.
  if (options.inputLock) {
    const pages = events.flatMap((event) => event.pages.map((page) => ({ event, page })));
    const mapHasLock = pages.some(({ page }) => hasCommand(page.commands, "lockInput"));
    const mapHasUnlock = pages.some(({ page }) => hasCommand(page.commands, "unlockInput"));
    if (mapHasLock && !mapHasUnlock) {
      for (const { event, page } of pages) {
        if (!hasCommand(page.commands, "lockInput")) continue;
        page.commands.push(command({ op: "unlockInput" }));
        note("trigger", "orphan input lock repair", "T1-lowered", `safety unlock appended to ${m.slug}:${event.id}`);
      }
    }
  }

  // Pure guard events do not use their coordinates, but the kit data model
  // still requires every event to live on its map.
  for (const event of events) {
    event.x = Math.max(0, Math.min(m.width - 1, event.x));
    event.y = Math.max(0, Math.min(m.height - 1, event.y));
  }

  // terrain placeholder: one pass tile, Tuxemon collision rects blocked
  const blocked = readCollisionCells(join(MAPS_DIR, `${m.slug}.tmx`));
  for (const region of collisionRegions) {
    if (region.key) {
      for (const [x, y] of region.cells) blocked.delete(`${x},${y}`);
    }
  }
  const passage: [number, "pass" | "block"][] = [];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (blocked.has(`${x},${y}`)) passage.push([y * m.width + x, "block"]);
  return {
    map: {
      id: m.slug,
      name: (po.get(m.props.slug ?? "") ?? m.slug).slice(0, 40),
      width: m.width,
      height: m.height,
      sheets: ["tux"],
      ground: new Array(m.width * m.height).fill("tux.0"),
      passage,
      events,
    },
    sprites,
  };
}

// ---------------------------------------------------------------------------
// project

export interface ImportLogRow {
  key: string;
  fate: Fate;
  count: number;
  note: string;
}

export interface ImportReport {
  format: "pocket-tuxemon/import-report/v1";
  source: {
    maps: "mods/tuxemon/maps";
    locale: ImportLang;
  };
  /** zh_CN builds only: catalog keys that fell back to en_US, and keys
   *  absent from every catalog. */
  l10n?: {
    fallbackKeys: string[];
    missingKeys: string[];
    missingKeyCategories: { key: string; category: MissingKeyCategory }[];
  };
  options?: ImportOptions;
  maps: string[];
  schemaErrors: { path: string; msg: string }[];
  /** Schema pattern mismatches on audio:qoa.* entries, pending the kit schema
   *  extension that accepts the QOA namespace. Not real validation errors. */
  audioQoaPending: { path: string; msg: string }[];
  byFate: Record<string, number>;
  rows: ImportLogRow[];
  transferRepairs: TransferRepair[];
  transferErrors: TransferError[];
  economy: {
    sourceEconomies: number;
    itemGoods: number;
    monsterGoods: number;
    finiteStockGoods: number;
    conditionedGoods: number;
    itemCatalog: {
      sourceRows: number;
      uniqueItems: number;
      descriptions: Record<string, string>;
    };
    limitations: {
      lockerOverflow: { disposition: "degraded"; reason: string };
      itemDescription: { disposition: "degraded"; reason: string };
    };
  };
  /** Item icon atlas plan; gen-assets cooks the binary TILESET entry. */
  itemIcons: {
    sheet: { id: string; pak: string; cols: number; rows: number };
    /** Cell index -> upstream art path relative to the mod root. */
    cells: { cell: number; file: string }[];
    placeholderCell: number;
    /** Item slugs whose DB row names no existing art (placeholder cell). */
    missing: string[];
    uniqueIcons: number;
  };
  seamlessHandoff: SeamlessHandoffReport;
  world: WorldImportReport;
  coverage: CoverageReport;
  /** Source-file parameter coverage for Tuxemon's translated dialog layout.
   * Counts overlap: one action can carry position and both alignments. */
  dialogLayout: DialogLayoutCoverageReport;
  /** D1: the 10-entry weather table exported from mods/tuxemon/db/weather. */
  weather: {
    source: "mods/tuxemon/db/weather/weathers.yaml";
    entries: WeatherEntry[];
  };
}

export type SeamlessHandoffExclusionReason =
  | "safe-opening-not-direct"
  | "unreachable-source-facing"
  | "target-outside-project"
  | "portal-only-opening"
  | "linked-gap"
  | "rejected-contact"
  | "indoor-source"
  | "non-tmx-overlay"
  | "outdoor-nonseam-or-story"
  | "outside-world-layout"
  | "non-player-transfer"
  | "faint-transfer";

export interface SeamlessHandoffReport {
  mode: "seamless-v1";
  sourceTransferActions: number;
  topologySafeOpenings: number;
  enabledTransfers: number;
  enabledPortalIds: string[];
  notEnabledSafePortalIds: string[];
  notEnabled: { reason: SeamlessHandoffExclusionReason; count: number }[];
  topologyExcluded: {
    portalOnlyOpenings: number;
    mixedUnsafeOpenings: number;
    directionOnlySeams: number;
    linkedGaps: number;
    rejectedContacts: number;
    indoorMaps: number;
  };
}

export interface TransferRepair {
  sourceMap: string;
  targetMap: string;
  requested: { x: number; y: number };
  clamped: { x: number; y: number };
  emitted: { x: number; y: number };
}

export interface TransferError {
  sourceMap: string;
  event: string;
  targetMap: string;
  x: number;
  y: number;
  reason: "missing-map" | "out-of-bounds";
}

export interface ImportBuild {
  project: Project;
  variables: Record<string, string[]>;
  worldIndex: OutdoorWorldIndex;
  /** Sorted map ids whose TMX declares inside=true; weather particles skip these. */
  indoorMaps: string[];
  /** Kit map id -> localized map description (the <slug>_description catalog
   *  entry), for the {x:map_desc} text-token resolver. */
  mapDescriptions: Record<string, string>;
  presentation: {
    backdrops: BackdropSource[];
    overlays: OverlaySource[];
    monsterMenuIcons: MonsterMenuIconSource[];
  };
  report: ImportReport;
}

export function availableMapIds(): string[] {
  return [...allMaps.keys()].sort();
}

function transferErrors(project: Project): TransferError[] {
  const maps = new Map(project.maps.map((map) => [map.id, map]));
  const errors: TransferError[] = [];
  const visit = (sourceMap: string, event: string, commands: readonly Command[]): void => {
    for (const command of commands) {
      if (command.op === "transfer") {
        // Faint recovery resolves a previously validated destination from the
        // live extension state. Only literal imports can be checked here.
        if (typeof command.map !== "string" || typeof command.x !== "number" || typeof command.y !== "number") continue;
        const target = maps.get(command.map);
        const reason = !target
          ? "missing-map"
          : command.x < 0 || command.y < 0 || command.x >= target.width || command.y >= target.height
            ? "out-of-bounds"
            : null;
        if (reason) errors.push({
          sourceMap,
          event,
          targetMap: command.map,
          x: command.x,
          y: command.y,
          reason,
        });
      } else if (command.op === "if") {
        visit(sourceMap, event, command.then);
        visit(sourceMap, event, command.else ?? []);
      } else if (command.op === "choices") {
        for (const option of command.options) visit(sourceMap, event, option.commands);
        visit(sourceMap, event, command.cancel?.commands ?? []);
      }
    }
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) visit(map.id, event.id, page.commands);
    }
  }
  return errors;
}

/** Keep handoff markers only where the interpreter can prove direct
 * playerTouch provenance. `if` and `loop` compile inline into the owning
 * page program, so they preserve the runtime's one-frame fiber stack. Choice,
 * battle, and scene continuations run as child programs and must fall back to
 * the legacy transfer timeline. */
function retainDirectHandoffMarkers(mapDefs: readonly MapDef[]): Set<string> {
  const enabled = new Set<string>();
  const visit = (commands: readonly Command[], direct: boolean): void => {
    for (const command of commands) {
      if (command.op === "transfer" && command.handoff) {
        if (direct) enabled.add(command.handoff.portalId);
        else delete command.handoff;
      }
      if (command.op === "if") {
        visit(command.then, direct);
        visit(command.else ?? [], direct);
      } else if (command.op === "loop") {
        visit(command.commands, direct);
      } else if (command.op === "choices") {
        for (const option of command.options) visit(option.commands, false);
        visit(command.cancel?.commands ?? [], false);
      } else if (command.op === "battle") {
        visit(command.onWin ?? [], false);
        visit(command.onLose ?? [], false);
        visit(command.onEscape ?? [], false);
      } else if (command.op === "scene") {
        visit(command.onDone ?? [], false);
        visit(command.onCancel ?? [], false);
      }
    }
  };
  for (const map of mapDefs) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) visit(page.commands, page.trigger === "playerTouch");
    }
  }
  return enabled;
}

function seamlessHandoffReport(
  index: OutdoorWorldIndex,
  selectedMaps: ReadonlySet<string>,
  projectSafePortalIds: ReadonlySet<string>,
  enabledPortalIds: ReadonlySet<string>,
): SeamlessHandoffReport {
  const globalSafePortalIds = new Set(index.worlds.flatMap((world) => world.seams.flatMap((seam) =>
    seam.handoff.openings.filter((opening) => opening.compatibility === "coordinate-preserving")
      .map((opening) => opening.portalId)
  )));
  const portalOnlyIds = new Set(index.worlds.flatMap((world) => world.seams.flatMap((seam) =>
    seam.handoff.openings.filter((opening) => opening.compatibility === "portal-only")
      .map((opening) => opening.portalId)
  )));
  const gapIds = new Set(index.worlds.flatMap((world) => world.diagnostics.rejectedContacts
    .filter((contact) => contact.geometry === "gap")
    .flatMap((contact) => contact.portalIds)));
  const rejectedIds = new Set(index.worlds.flatMap((world) => world.diagnostics.rejectedContacts
    .filter((contact) => contact.geometry !== "gap")
    .flatMap((contact) => contact.portalIds)));
  const outdoorMapIds = new Set(index.worlds.flatMap((world) => world.maps.map((map) => map.mapId)));
  const indoorMapIds = new Set(index.worlds.flatMap((world) => world.excludedMaps.map((map) => map.mapId)));
  const reasons = new Map<SeamlessHandoffExclusionReason, number>();
  const exclude = (reason: SeamlessHandoffExclusionReason): void => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };
  let sourceTransferActions = 0;
  const notEnabledSafePortalIds: string[] = [];

  for (const mapId of [...selectedMaps].sort()) {
    const map = allMaps.get(mapId)!;
    for (const [eventIndex, event] of map.events.entries()) {
      for (const [actionIndex, action] of event.acts.entries()) {
        if (action.type === "teleport_faint") {
          sourceTransferActions++;
          exclude("faint-transfer");
          continue;
        }
        if (action.type !== "transition_teleport") continue;
        sourceTransferActions++;
        if (action.args[0] !== "player") {
          exclude("non-player-transfer");
          continue;
        }
        if (event.origin !== "tmx") {
          exclude("non-tmx-overlay");
          continue;
        }
        const portalId = outdoorWorldPortalId(mapId, event, eventIndex, actionIndex);
        if (projectSafePortalIds.has(portalId)) {
          if (!enabledPortalIds.has(portalId)) {
            notEnabledSafePortalIds.push(portalId);
            const unreachableFacing = event.conds.some((condition) =>
              condition.type === "char_facing" && condition.op === "is" &&
              condition.args[0] === "player" && !DIRS.has(condition.args[1]!)
            );
            exclude(unreachableFacing ? "unreachable-source-facing" : "safe-opening-not-direct");
          }
        } else if (globalSafePortalIds.has(portalId)) {
          exclude("target-outside-project");
        } else if (portalOnlyIds.has(portalId)) {
          exclude("portal-only-opening");
        } else if (gapIds.has(portalId)) {
          exclude("linked-gap");
        } else if (rejectedIds.has(portalId)) {
          exclude("rejected-contact");
        } else if (indoorMapIds.has(mapId)) {
          exclude("indoor-source");
        } else if (outdoorMapIds.has(mapId)) {
          exclude("outdoor-nonseam-or-story");
        } else {
          exclude("outside-world-layout");
        }
      }
    }
  }

  const topologyOpenings = index.worlds.flatMap((world) => world.seams.flatMap((seam) =>
    seam.handoff.openings.map((opening) => ({ seam, opening }))
  ));
  return {
    mode: "seamless-v1",
    sourceTransferActions,
    topologySafeOpenings: projectSafePortalIds.size,
    enabledTransfers: enabledPortalIds.size,
    enabledPortalIds: [...enabledPortalIds].sort(),
    notEnabledSafePortalIds: notEnabledSafePortalIds.sort(),
    notEnabled: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    topologyExcluded: {
      portalOnlyOpenings: topologyOpenings.filter(({ opening }) => opening.compatibility === "portal-only").length,
      mixedUnsafeOpenings: topologyOpenings.filter(({ seam, opening }) =>
        seam.handoff.mode === "mixed" && opening.compatibility === "portal-only"
      ).length,
      directionOnlySeams: index.worlds.flatMap((world) => world.seams)
        .filter((seam) => seam.handoff.mode === "direction-only").length,
      linkedGaps: index.worlds.flatMap((world) => world.diagnostics.rejectedContacts)
        .filter((contact) => contact.geometry === "gap").length,
      rejectedContacts: index.worlds.flatMap((world) => world.diagnostics.rejectedContacts)
        .filter((contact) => contact.geometry === "edge" || contact.geometry === "overlap").length,
      indoorMaps: index.worlds.reduce((sum, world) => sum + world.excludedMaps.length, 0),
    },
  };
}

export function buildProject(
  want: readonly string[] = DEFAULT_MAPS,
  requestedOptions: Partial<ImportOptions> = {},
  providedSurfaceLabels?: TerrainSurfaceLabels,
): ImportBuild {
  const options = resolveOptions(requestedOptions);
  textVariablesOn = options.battle;
  textTokensOn = options.battle;
  log.clear();
  items.clear();
  animationDefs.clear();
  backdropSources.clear();
  overlaySources.clear();
  appearanceSpriteDefs.clear();
  monsterMenuIconSources.clear();
  for (const id of [...itemDb.keys()].sort()) ensureItem(id);
  transferRepairs.length = 0;
  conversionCoverage.reset();
  const world = buildOutdoorWorldIndex([...allMaps.values()]);
  const selectedMaps = new Set(want);
  const worldLayout = projectOutdoorWorldLayout(world.index, selectedMaps);
  const seamlessPortalIds = new Set(worldLayout?.components.flatMap((component) =>
    component.openings
      .filter((opening) => opening.compatibility === "coordinate-preserving")
      .map((opening) => opening.portalId)
  ) ?? []);
  const surfaceLabels = providedSurfaceLabels ?? importTerrainSurfaceLabels(want);

  // Register authored presentation assets before trigger pruning. A fixed
  // source guard may make a command unreachable in today's campaign, but the
  // generated project remains complete if another imported guard becomes
  // executable later (notably the swimmer appearance and night overlay).
  for (const id of want) {
    const map = allMaps.get(id);
    if (!map) throw new Error(`no map ${id}`);
    for (const action of map.events.flatMap((event) => event.acts)) {
      if (action.type === "set_template" && action.args[1] && action.args[1] !== "default") {
        ensureAppearanceSprite(action.args[1]);
      } else if (action.type === "set_layer" && action.args[0] &&
                 action.args[0]!.toLowerCase() !== "none") {
        ensureOverlay(action.args[0]!);
      }
    }
  }

  const mapDefs: MapDef[] = [];
  const sprites: Record<string, SpriteDef> = {};
  // ${{map_desc}} resolves to the current map's description, which upstream
  // stores as the <slug>_description translation (Tuxemon's MapManager). The
  // kit project format has no description field, so the importer emits this
  // slug->description table for the game's {x:map_desc} resolver.
  const mapDescriptions = new Map<string, string>();
  for (const s of want) {
    const m = allMaps.get(s);
    if (!m) throw new Error(`no map ${s}`);
    const r = convertMap(m, options, surfaceLabels[s] ?? {}, seamlessPortalIds);
    mapDefs.push(r.map);
    Object.assign(sprites, r.sprites);
    const tuxemonSlug = m.props.slug ?? m.slug;
    const description = po.peek(`${tuxemonSlug}_description`);
    if (description) mapDescriptions.set(m.slug, description);
  }
  Object.assign(sprites, Object.fromEntries([...appearanceSpriteDefs.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )));

  // Assign every item its atlas cell once the full catalog is known (event
  // conversion can introduce items absent from the DB, e.g. elianeoutput).
  // The binary atlas itself is cooked by gen-assets from this same plan.
  const itemIconPlan = planItemIcons(
    [...items.keys()],
    (slug) => itemDb.get(slug)?.sprite,
    TUXEMON_SRC,
  );
  for (const [slug, sprite] of Object.entries(itemIconPlan.sprites)) {
    items.get(slug)!.sprite = sprite;
  }

  const startId = want.includes("spyder_bedroom") ? "spyder_bedroom" : want[0];
  if (!startId) throw new Error("at least one map must be selected");
  const startMap = mapDefs.find((m) => m.id === startId)!;

  // start_tuxemon.yaml's Spyder branch, as a one-shot boot page. Built
  // lazily: the enum codes it references only exist when the real source
  // (whose start_tuxemon event introduces them) is loaded, and the page is
  // only emitted for spyder_bedroom starts.
  if (startId === "spyder_bedroom") {
    const boot: Command[] = [
      ["scenario_choice", "spyder_campaign"],
      ["gender_choice", "gender_male"],
      ["race_choice", "white_male"],
      ["method_money", "conserved"],
    ].map(([k, v]) => ({
      op: "variable",
      id: varId(k!),
      set: { op: "set", value: code(k!, v!) },
    }) as Command);
    startMap.events!.unshift({
      id: "e000_boot",
      name: "start_tuxemon (Spyder)",
      x: 0,
      y: 0,
      pages: [{
        trigger: "autorun",
        condition: { variable: { id: "sys.boot", op: "==", value: 0 } },
        sprite: null,
        commands: [
          ...boot,
          { op: "variable", id: "sys.boot", set: { op: "set", value: 1 } },
        ],
      }],
    });
  }

  const enabledHandoffPortalIds = retainDirectHandoffMarkers(mapDefs);
  const built: Project = {
    format: "rpgkit-project/v1",
    title: "Pocket Tuxemon",
    tileSize: 16,
    // Tuxemon's dialog state consumes movement and interaction input no
    // matter which event fiber opened the box.
    // textVariables switches on {v:<id>} (the ${{var:X}} templates);
    // textTokens is the {x:<key>} allowlist answered by the game's resolver
    // (battle/text-tokens.ts). Both are battle-runtime features, so a project
    // without the battle extension keeps the literal-braces behavior.
    system: {
      messageBlocksPlayer: true,
      inventory: { maxKinds: 99 },
      ...(options.battle ? {
        textVariables: true,
        textTokens: ["today", "map_desc", "monster_0_name", "monster_0_level", "money"],
      } : {}),
    },
    start: {
      map: startId,
      x: Math.min(4, startMap.width - 1),
      y: Math.min(4, startMap.height - 1),
      dir: "down",
    },
    initialGold: 500,
    playerName: PLAYER_NAME,
    ...(activeLang === "zh_CN" ? { uiText: loadZhUiText() } : {}),
    sheets: [{
      id: "tux",
      pak: "placeholder",
      cols: 1,
      rows: 1,
      defaultPassage: "pass",
    }, itemIconPlan.sheet],
    items: [...items.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ...(animationDefs.size ? {
      animations: [...animationDefs.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    } : {}),
    sprites,
    audio: audioTable(),
    ...(worldLayout ? { worldTraversal: "seamless-v1" as const, worldLayout } : {}),
    maps: mapDefs,
  };

  // Validate the document exactly as serialized (undefined keys disappear).
  const project = JSON.parse(JSON.stringify(built)) as Project;
  const schema = JSON.parse(readFileSync(
    new URL("../vendor/pocket-rpgkit/src/data/schema.json", import.meta.url),
    "utf8",
  ));
  const allSchemaErrors = validateSchema(schema, project);
  // The pinned kit schema only knows the audio:wav.* namespace; the QOA music
  // entries (audio:qoa.*) become valid once the kit schema is extended. Until
  // then, separate those known-pending pattern mismatches from real errors so
  // the gate stays meaningful.
  const isQoaPending = (e: { path: string; msg: string }): boolean =>
    e.path.startsWith("$.audio.") && e.msg.includes("audio:wav");
  const schemaErrors = allSchemaErrors.filter((e) => !isQoaPending(e));
  const audioQoaPending = allSchemaErrors.filter(isQoaPending);
  const rows = [...log.entries()]
    .map(([, v]) => ({
      key: v.key,
      fate: v.fate,
      count: v.count,
      note: v.note,
    }))
    .sort((a, b) =>
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.fate < b.fate ? -1 : a.fate > b.fate ? 1 : 0)
    );
  const byFate: Record<string, number> = {};
  for (const row of rows) {
    byFate[row.fate] = (byFate[row.fate] ?? 0) + row.count;
  }
  const variables = Object.fromEntries(
    [...enumTable.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, values]) => [name, options.battle && name === "battle_last_result"
        ? [...values, "run", "captured"]
        : [...values]]),
  );

  return {
    project,
    variables,
    worldIndex: world.index,
    indoorMaps: [...allMaps.values()]
      .filter((m) => m.props.inside === "true")
      .map((m) => m.slug)
      .sort(),
    mapDescriptions: Object.fromEntries([...mapDescriptions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    presentation: {
      backdrops: [...backdropSources.values()].sort((a, b) =>
        a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0
      ),
      overlays: [...overlaySources.values()].sort((a, b) =>
        a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0
      ),
      monsterMenuIcons: [...monsterMenuIconSources.values()].sort((a, b) =>
        a.sprite < b.sprite ? -1 : a.sprite > b.sprite ? 1 : 0
      ),
    },
    report: {
      format: "pocket-tuxemon/import-report/v1",
      source: { maps: "mods/tuxemon/maps", locale: activeLang },
      ...(activeLang === "zh_CN" ? { l10n: l10nReportSection() } : {}),
      ...(Object.values(options).some(Boolean) ? { options } : {}),
      maps: [...want],
      schemaErrors,
      audioQoaPending,
      byFate,
      rows,
      transferRepairs: [...transferRepairs],
      transferErrors: transferErrors(project),
      economy: {
        sourceEconomies: economyDb.size,
        itemGoods: [...economyDb.values()].reduce((sum, economy) => sum + (economy.items?.length ?? 0), 0),
        monsterGoods: [...economyDb.values()].reduce((sum, economy) => sum + (economy.monsters?.length ?? 0), 0),
        finiteStockGoods: [...economyDb.values()].flatMap((economy) => economy.items ?? [])
          .filter((entry) => typeof entry.inventory === "number" && entry.inventory >= 0).length,
        conditionedGoods: [...economyDb.values()].flatMap((economy) => economy.items ?? [])
          .filter((entry) => (entry.variables?.length ?? 0) > 0).length,
        itemCatalog: {
          sourceRows: itemSourceRows,
          uniqueItems: itemDb.size,
          descriptions: Object.fromEntries([...itemDb.keys()].sort().map((id) => [
            id,
            po.get(`${id}_description`) ?? "",
          ])),
        },
        limitations: {
          lockerOverflow: {
            disposition: "degraded",
            reason: "A purchase that would introduce item kind 100 is refused; Tuxemon routes it to the locker, which is not implemented.",
          },
          itemDescription: {
            disposition: "degraded",
            reason: "Descriptions are retained in this import report because rpgkit-project/v1 Item has no description field.",
          },
        },
      },
      itemIcons: {
        sheet: { id: itemIconPlan.sheet.id, pak: itemIconPlan.sheet.pak!, cols: itemIconPlan.sheet.cols, rows: itemIconPlan.sheet.rows },
        cells: itemIconPlan.cells,
        placeholderCell: itemIconPlan.placeholderCell,
        missing: itemIconPlan.missing,
        uniqueIcons: itemIconPlan.uniqueIcons,
      },
      seamlessHandoff: seamlessHandoffReport(
        world.index,
        selectedMaps,
        seamlessPortalIds,
        enabledHandoffPortalIds,
      ),
      world: world.report,
      coverage: conversionCoverage.report(),
      dialogLayout: conversionCoverage.dialogLayoutReport(),
      weather: {
        source: "mods/tuxemon/db/weather/weathers.yaml",
        entries: loadWeatherTable(),
      },
    },
  };
}

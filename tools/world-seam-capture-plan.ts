import type { Facing, WorldSide } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const WORLD_SEAM_FORMAT = "pocket-tuxemon/world-seam-crossings/v2" as const;
export const WORLD_SEAM_OUTPUT = "docs/screenshots/world-seam" as const;
export const WORLD_SEAM_PHASES = [0, 1, 2, 3, 4, 5, 6, 7, "landing"] as const;

export const WORLD_SEAM_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export type WorldSeamOrientation = "horizontal" | "vertical";
export type WorldSeamPhase = (typeof WORLD_SEAM_PHASES)[number];

/**
 * These are production map entries followed by ordinary directional input.
 * The diagnostic hook is used only to choose a short, deterministic starting
 * point; the edge event, transfer command and seamless reducer handoff are the
 * same ones used by the game.
 */
export interface WorldSeamCrossingPlan {
  orientation: WorldSeamOrientation;
  sourceMap: string;
  targetMap: string;
  sourceSide: WorldSide;
  start: readonly [number, number];
  button: number;
  facing: Facing;
  worldDelta: readonly [number, number];
}

export const WORLD_SEAM_CROSSINGS: readonly WorldSeamCrossingPlan[] = [
  {
    orientation: "horizontal",
    // A fixed-destination rectangle that funnels y=16..18 to y=17 upstream.
    // y=16 used to fade to the fixed landing; it now crosses to its own
    // coordinate-continuous neighbour cell (39,16).
    sourceMap: "classic_aerolume_city",
    targetMap: "classic_route_5",
    sourceSide: "west",
    start: [1, 16],
    button: 0x0080,
    facing: 1,
    worldDelta: [-2, 0],
  },
  {
    orientation: "vertical",
    // One of Route 3's five pinned `bottom` source typos, repaired to the
    // authored south-edge/downward physical crossing.
    sourceMap: "route3",
    targetMap: "leather_town",
    sourceSide: "south",
    start: [32, 38],
    button: 0x0040,
    facing: 0,
    worldDelta: [0, 2],
  },
] as const;

export interface WorldSeamBandStats {
  visibleMaps: string[];
  textures: number;
  resident: number;
  pooled: number;
  created: number;
  pending: number;
}

export interface WorldSeamCaptureFrame {
  orientation: WorldSeamOrientation;
  viewport: { width: number; height: number };
  capture: WorldSeamPhase;
  phase: number | null;
  sourceMap: string;
  targetMap: string;
  activeMap: string;
  file: string;
  camera: [number, number];
  player: {
    tile: [number, number];
    localPixel: [number, number];
    worldPixel: [number, number];
    screenRect: [number, number, number, number];
    facing: Facing;
    movePhase: number;
  };
  fade: null;
  scene: null;
  ground: WorldSeamBandStats;
  upper: WorldSeamBandStats;
  nonBlackPixels: number;
  rgbaFnv1a: string;
  pngSha256: string;
}

export interface WorldSeamContactSheet {
  viewport: { width: number; height: number };
  file: string;
  width: number;
  height: number;
  columns: number;
  rows: Array<{ orientation: WorldSeamOrientation; files: string[] }>;
  pngSha256: string;
}

export interface WorldSeamManifest {
  format: typeof WORLD_SEAM_FORMAT;
  phases: WorldSeamPhase[];
  frames: WorldSeamCaptureFrame[];
  contactSheets: WorldSeamContactSheet[];
}

export function worldSeamFrameFile(
  orientation: WorldSeamOrientation,
  viewport: { width: number; height: number },
  phase: WorldSeamPhase,
): string {
  return `world-seam-${orientation}.${viewport.width}x${viewport.height}.${
    phase === "landing" ? "landing" : `phase-${phase}`
  }.png`;
}

export function worldSeamContactSheetFile(viewport: { width: number; height: number }): string {
  return `world-seam-crossings.${viewport.width}x${viewport.height}.contact-sheet.png`;
}

export function expectedWorldSeamFrameFiles(): string[] {
  return WORLD_SEAM_VIEWPORTS.flatMap((viewport) =>
    WORLD_SEAM_CROSSINGS.flatMap((crossing) =>
      WORLD_SEAM_PHASES.map((phase) => worldSeamFrameFile(crossing.orientation, viewport, phase))
    )
  );
}

function fail(message: string): never {
  throw new Error(`world seam manifest: ${message}`);
}

/** Strict semantic checks shared by generation and the visual regression. */
export function assertWorldSeamManifest(manifest: WorldSeamManifest): void {
  if (manifest.format !== WORLD_SEAM_FORMAT) fail(`unexpected format ${JSON.stringify(manifest.format)}`);
  if (JSON.stringify(manifest.phases) !== JSON.stringify(WORLD_SEAM_PHASES)) {
    fail(`expected phases ${WORLD_SEAM_PHASES.join(",")}`);
  }
  const expectedFiles = expectedWorldSeamFrameFiles();
  if (manifest.frames.length !== expectedFiles.length) {
    fail(`expected ${expectedFiles.length} frames, got ${manifest.frames.length}`);
  }
  if (JSON.stringify(manifest.frames.map((frame) => frame.file)) !== JSON.stringify(expectedFiles)) {
    fail("frame order/files do not match the capture plan");
  }

  for (const viewport of WORLD_SEAM_VIEWPORTS) {
    for (const crossing of WORLD_SEAM_CROSSINGS) {
      const frames = manifest.frames.filter((frame) =>
        frame.viewport.width === viewport.width &&
        frame.viewport.height === viewport.height &&
        frame.orientation === crossing.orientation
      );
      if (frames.length !== WORLD_SEAM_PHASES.length) fail(`${crossing.orientation} has an incomplete sequence`);
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        const capture = WORLD_SEAM_PHASES[index]!;
        if (frame.capture !== capture || frame.phase !== (capture === "landing" ? null : capture)) {
          fail(`${frame.file} has capture=${frame.capture} phase=${frame.phase}`);
        }
        if (frame.sourceMap !== crossing.sourceMap || frame.targetMap !== crossing.targetMap) {
          fail(`${frame.file} has the wrong crossing maps`);
        }
        const expectedMap = capture === "landing" ? crossing.targetMap : crossing.sourceMap;
        if (frame.activeMap !== expectedMap) fail(`${frame.file} active map is ${frame.activeMap}, expected ${expectedMap}`);
        if (frame.fade !== null || frame.scene !== null) fail(`${frame.file} is obscured by a fade or scene`);
        if (frame.player.facing !== crossing.facing) fail(`${frame.file} player faces away from the handoff`);
        const pixels = frame.viewport.width * frame.viewport.height;
        if (frame.nonBlackPixels * 2 < pixels) {
          fail(`${frame.file} is majority black (${frame.nonBlackPixels}/${pixels} non-black pixels)`);
        }
        for (const [name, band] of [["ground", frame.ground], ["upper", frame.upper]] as const) {
          if (!band.visibleMaps.includes(crossing.sourceMap) || !band.visibleMaps.includes(crossing.targetMap)) {
            fail(`${frame.file} ${name} does not expose both crossing maps`);
          }
          if (band.pending !== 0) fail(`${frame.file} ${name} still has ${band.pending} pending chunks`);
          if (band.resident + band.pooled !== band.created) {
            fail(`${frame.file} ${name} pool accounting is inconsistent`);
          }
        }
        if (index > 0) {
          const previous = frames[index - 1]!;
          const dx = frame.player.worldPixel[0] - previous.player.worldPixel[0];
          const dy = frame.player.worldPixel[1] - previous.player.worldPixel[1];
          if (dx !== crossing.worldDelta[0] || dy !== crossing.worldDelta[1]) {
            fail(`${frame.file} player world delta is ${dx},${dy}, expected ${crossing.worldDelta.join(",")}`);
          }
          const cameraDx = Math.abs(frame.camera[0] - previous.camera[0]);
          const cameraDy = Math.abs(frame.camera[1] - previous.camera[1]);
          if (cameraDx > 2 || cameraDy > 2) {
            fail(`${frame.file} camera jumped ${cameraDx},${cameraDy} pixels`);
          }
        }
      }
    }
  }

  if (manifest.contactSheets.length !== WORLD_SEAM_VIEWPORTS.length) {
    fail(`expected ${WORLD_SEAM_VIEWPORTS.length} contact sheets`);
  }
  for (const [index, sheet] of manifest.contactSheets.entries()) {
    const viewport = WORLD_SEAM_VIEWPORTS[index]!;
    if (
      sheet.viewport.width !== viewport.width || sheet.viewport.height !== viewport.height ||
      sheet.file !== worldSeamContactSheetFile(viewport) ||
      sheet.columns !== WORLD_SEAM_PHASES.length ||
      sheet.width !== viewport.width * WORLD_SEAM_PHASES.length ||
      sheet.height !== viewport.height * WORLD_SEAM_CROSSINGS.length
    ) fail(`contact sheet ${index} does not match its viewport plan`);
    if (sheet.rows.length !== WORLD_SEAM_CROSSINGS.length) fail(`${sheet.file} has incomplete rows`);
  }
}

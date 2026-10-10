// Deterministic weather particle placement.
//
// Every particle position is a pure function of (weather slug, the tick the
// weather entered, the current 60 Hz reference tick, the particle index, and
// the viewport size). No wall clock and no per-frame mutable state participates,
// so the same tape renders the same pixels under rewind, save/load, and every
// host rate. Positions use fixed-point (×256) integer arithmetic and are
// taken modulo the viewport span every tick, so the field is seamless at
// every tick boundary without an age wrap (a wrap would only be invisible if
// it were a common multiple of every profile's motion periods).

// Texture path literals: the PocketJS bundler bakes an image only when its
// path string is scanned from bundle source, so these stay literal constants.
export const WEATHER_RAINDROP_TEXTURE = "assets/weather/raindrop.png";
export const WEATHER_SNOWFLAKE_TEXTURE = "assets/weather/snowflake.png";
export const WEATHER_WIND_TEXTURE = "assets/weather/wind-streak.png";
export const WEATHER_FOG_TEXTURE = "assets/weather/fog-veil.png";

export type WeatherParticleKind = "rain" | "snow" | "wind" | "fog";

export interface WeatherProfile {
  kind: WeatherParticleKind;
  texture: string;
  /** Active node count. */
  count: number;
  /** Fixed-point (×256) velocity per reference tick. */
  vx: number;
  vy: number;
  /** Base opacity 0..1. */
  opacity: number;
  /** Node size in px. */
  width: number;
  height: number;
}

/**
 * Pocket Tuxemon presentation policy (upstream has no weather visuals):
 * rain and thunderstorm fall as streaks, snow as slow drifting flakes, wind
 * as fast horizontal streaks, and fog/mist/cloudy as slow drifting veils.
 * sunny/hot/freezing render nothing.
 */
export const WEATHER_PROFILES: Readonly<Record<string, WeatherProfile>> = Object.freeze({
  rain: { kind: "rain", texture: WEATHER_RAINDROP_TEXTURE, count: 72, vx: -384, vy: 2_560, opacity: 0.7, width: 2, height: 16 },
  thunderstorm: { kind: "rain", texture: WEATHER_RAINDROP_TEXTURE, count: 90, vx: -640, vy: 3_200, opacity: 0.75, width: 2, height: 16 },
  snow: { kind: "snow", texture: WEATHER_SNOWFLAKE_TEXTURE, count: 40, vx: 0, vy: 384, opacity: 0.9, width: 4, height: 4 },
  windy: { kind: "wind", texture: WEATHER_WIND_TEXTURE, count: 26, vx: 2_816, vy: 128, opacity: 0.4, width: 16, height: 2 },
  foggy: { kind: "fog", texture: WEATHER_FOG_TEXTURE, count: 8, vx: 96, vy: 0, opacity: 0.85, width: 96, height: 96 },
  misty: { kind: "fog", texture: WEATHER_FOG_TEXTURE, count: 7, vx: 64, vy: 0, opacity: 0.6, width: 96, height: 96 },
  cloudy: { kind: "fog", texture: WEATHER_FOG_TEXTURE, count: 6, vx: 48, vy: 0, opacity: 0.45, width: 96, height: 96 },
});

/** Largest pool any profile needs; the overlay allocates once. */
export const MAX_WEATHER_PARTICLES = Math.max(
  ...Object.values(WEATHER_PROFILES).map((profile) => profile.count),
);

/** FNV-1a, so a weather slug seeds its particle field deterministically. */
export function weatherSlugHash(slug: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < slug.length; index++) {
    hash ^= slug.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix2(value: number): number {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (h15(hash)), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}

function h15(hash: number): number {
  return hash >>> 15;
}

export interface ParticlePlacement {
  /** Integer px, already wrapped into the viewport. */
  x: number;
  y: number;
  /** Per-node opacity 0..1 after caller scaling and per-node variation. */
  opacity: number;
}

/**
 * Place particle `index` for the given profile, writing into a caller-owned
 * `out` object. `ageTicks` is the weather age in reference ticks, derived
 * with `weatherAgeTicks`. This is the hot-path variant: the overlay reuses
 * one scratch placement for every particle every frame, so the render loop
 * allocates nothing per frame. `weatherParticle` wraps it for callers that
 * want a fresh object.
 */
export function weatherParticleInto(
  profile: WeatherProfile,
  slugHashValue: number,
  index: number,
  ageTicks: number,
  viewportWidth: number,
  viewportHeight: number,
  opacityScale: number,
  out: ParticlePlacement,
): void {
  const seedX = mix2(Math.imul(index * 2 + 1, slugHashValue ^ 0x9e3779b9));
  const seedY = mix2(Math.imul(index * 2 + 2, slugHashValue ^ 0x517cc1b7));
  // Diagonal travel room so streaks entering from an edge stay seamless.
  const spanX = Math.max(1, viewportWidth + profile.height);
  const spanY = Math.max(1, viewportHeight + profile.height);
  let xFp = (seedX + profile.vx * ageTicks) % (spanX << 8);
  let yFp = (seedY + profile.vy * ageTicks) % (spanY << 8);
  if (profile.kind === "snow") {
    // Integer triangular sway: ±2 px around the fall line, no trig on the
    // QuickJS hot path.
    const phase = (ageTicks + (seedX & 0x3ff)) & 0x3ff;
    const triangle = phase < 512 ? phase : 1024 - phase;
    xFp = (xFp + (triangle - 256) * 2) % (spanX << 8);
  }
  if (xFp < 0) xFp += spanX << 8;
  if (yFp < 0) yFp += spanY << 8;
  // Clamp to the frame minus the node size so a streak or veil never paints
  // past the world frame into the letterbox.
  const maxX = Math.max(0, viewportWidth - profile.width);
  const maxY = Math.max(0, viewportHeight - profile.height);
  out.x = Math.min(maxX, xFp >> 8);
  out.y = Math.min(maxY, yFp >> 8);
  // Fog veils get per-node opacity variation for an organic overlap.
  const variation = profile.kind === "fog" ? 0.6 + 0.4 * ((seedX % 1000) / 1000) : 1;
  out.opacity = Math.round(profile.opacity * opacityScale * variation * 255) / 255;
}

/**
 * Place particle `index` for the given profile. Allocates a fresh object;
 * the per-frame overlay path uses `weatherParticleInto` with a reused
 * scratch instead. `ageTicks` is the weather age in reference ticks, derived
 * with `weatherAgeTicks`.
 */
export function weatherParticle(
  profile: WeatherProfile,
  slugHashValue: number,
  index: number,
  ageTicks: number,
  viewportWidth: number,
  viewportHeight: number,
  opacityScale: number,
): ParticlePlacement {
  const out: ParticlePlacement = { x: 0, y: 0, opacity: 0 };
  weatherParticleInto(
    profile,
    slugHashValue,
    index,
    ageTicks,
    viewportWidth,
    viewportHeight,
    opacityScale,
    out,
  );
  return out;
}

/** Weather age in reference ticks. The age is intentionally not wrapped:
 *  positions are reduced modulo the viewport span on every tick, which keeps
 *  the field seamless at every boundary, and the products stay exact doubles
 *  for any realistic session (a 100-day 60 Hz session keeps v*age under
 *  2^43). Wrapping the age here would reset the field mid-cycle unless the
 *  wrap happened to be a common multiple of every profile's motion periods. */
export function weatherAgeTicks(refTick: number, enteredAtTick: number): number {
  return refTick - enteredAtTick;
}

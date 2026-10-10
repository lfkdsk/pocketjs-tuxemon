import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  weatherEnvelopeAt,
  weatherEnvelopeInto,
  type WeatherEnvelope,
} from "../battle/extension.ts";
import { timeWeatherAt } from "../battle/time-weather.ts";
import {
  MAX_WEATHER_PARTICLES,
  WEATHER_PROFILES,
  weatherAgeTicks,
  weatherParticle,
  weatherParticleInto,
  weatherSlugHash,
  type ParticlePlacement,
} from "../battle/weather-visuals.ts";
import { INDOOR_MAPS } from "../ui/weather-maps.ts";
import { weatherOverlaySuspended } from "../ui/weather-overlay-policy.ts";

const VIEWPORT = { width: 480, height: 272 };

function place(slug: string, index: number, age: number, dim = 1) {
  return weatherParticle(
    WEATHER_PROFILES[slug]!,
    weatherSlugHash(slug),
    index,
    age,
    VIEWPORT.width,
    VIEWPORT.height,
    dim,
  );
}

describe("weather particle placement", () => {
  test("is deterministic for the same inputs", () => {
    const first = place("rain", 3, 120);
    const second = place("rain", 3, 120);
    expect(second).toEqual(first);
  });

  test("different slugs seed different fields", () => {
    const rain = place("rain", 0, 0);
    const snow = place("snow", 0, 0);
    expect(snow).not.toEqual(rain);
  });

  test("positions stay inside the viewport", () => {
    for (const slug of Object.keys(WEATHER_PROFILES)) {
      for (let index = 0; index < WEATHER_PROFILES[slug]!.count; index++) {
        for (const age of [0, 1, 999, 65_535, 1_000_000]) {
          const p = place(slug, index, age);
          expect(p.x, `${slug}[${index}]@${age}`).toBeGreaterThanOrEqual(0);
          expect(p.x, `${slug}[${index}]@${age}`).toBeLessThan(VIEWPORT.width);
          expect(p.y, `${slug}[${index}]@${age}`).toBeGreaterThanOrEqual(0);
          expect(p.y, `${slug}[${index}]@${age}`).toBeLessThan(VIEWPORT.height);
          expect(p.opacity, `${slug}[${index}]@${age}`).toBeGreaterThan(0);
          expect(p.opacity, `${slug}[${index}]@${age}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("rain falls over time", () => {
    const profile = WEATHER_PROFILES.rain!;
    const p0 = weatherParticle(profile, weatherSlugHash("rain"), 5, 0, VIEWPORT.width, VIEWPORT.height, 1);
    const p1 = weatherParticle(profile, weatherSlugHash("rain"), 5, 10, VIEWPORT.width, VIEWPORT.height, 1);
    // vy is positive and large; modulo wrap aside, the field advances.
    expect(p1.y).not.toBe(p0.y);
  });

  test("caller opacity scale is applied to particle alpha", () => {
    const full = place("rain", 0, 0, 1);
    const half = place("rain", 0, 0, 0.5);
    expect(half.opacity).toBeLessThan(full.opacity);
  });

  test("fog gets per-node opacity variation", () => {
    const opacities = new Set<number>();
    const profile = WEATHER_PROFILES.foggy!;
    for (let index = 0; index < profile.count; index++) {
      opacities.add(place("foggy", index, 0).opacity);
    }
    expect(opacities.size).toBeGreaterThan(1);
  });
});

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/**
 * Centered modulo: a particle recycling from one viewport edge to the other
 * reads as the small true single-tick motion instead of a full-span jump.
 */
function centeredMod(delta: number, span: number): number {
  const wrapped = ((delta % span) + span) % span;
  return wrapped > span / 2 ? wrapped - span : wrapped;
}

const BOUNDARY_VIEWPORTS = [
  { name: "480x272", width: 480, height: 272 },
  { name: "960x544", width: 960, height: 544 },
] as const;

describe("weather age continuity", () => {
  for (const viewport of BOUNDARY_VIEWPORTS) {
    for (const [slug, profile] of Object.entries(WEATHER_PROFILES)) {
      const hash = weatherSlugHash(slug);
      const spanX = viewport.width + profile.height;
      const spanY = viewport.height + profile.height;
      const place = (index: number, age: number) =>
        weatherParticle(profile, hash, index, age, viewport.width, viewport.height, 1);

      test(`${slug} crosses the 65,536-tick boundary with an ordinary single-tick displacement at ${viewport.name}`, () => {
        // The position field is periodic with the LCM of the two axis periods
        // (and the 1024-tick snow sway), so one window covers every phase a
        // particle can have and the largest ordinary single-tick displacement
        // is known. The old age wrap reset the field mid-cycle and made the
        // boundary tick look like 65,535 ticks of motion at once.
        const periodX = (spanX << 8) / gcd(Math.abs(profile.vx), spanX << 8);
        const periodY = (spanY << 8) / gcd(Math.abs(profile.vy), spanY << 8);
        const fieldPeriod = lcm(lcm(periodX, periodY), profile.kind === "snow" ? 1024 : 1);
        const maxOrdinaryX = new Array<number>(profile.count).fill(0);
        const maxOrdinaryY = new Array<number>(profile.count).fill(0);
        for (let index = 0; index < profile.count; index++) {
          for (let age = 0; age < fieldPeriod; age++) {
            const p0 = place(index, age);
            const p1 = place(index, age + 1);
            const dx = Math.abs(centeredMod(p1.x - p0.x, spanX));
            const dy = Math.abs(centeredMod(p1.y - p0.y, spanY));
            if (dx > maxOrdinaryX[index]!) maxOrdinaryX[index] = dx;
            if (dy > maxOrdinaryY[index]!) maxOrdinaryY[index] = dy;
          }
        }
        for (let index = 0; index < profile.count; index++) {
          const before = place(index, weatherAgeTicks(65_535, 0));
          const after = place(index, weatherAgeTicks(65_536, 0));
          const dx = Math.abs(centeredMod(after.x - before.x, spanX));
          const dy = Math.abs(centeredMod(after.y - before.y, spanY));
          expect(dx, `${slug}[${index}] boundary dx`).toBeLessThanOrEqual(maxOrdinaryX[index]!);
          expect(dy, `${slug}[${index}] boundary dy`).toBeLessThanOrEqual(maxOrdinaryY[index]!);
        }
      });
    }
  }

  test("weatherAgeTicks never alters placement (no artificial wrap)", () => {
    // The age is a raw tick difference: positions are taken modulo the
    // viewport span every tick, so the field is seamless at every boundary
    // and no wrap constant can drift out of sync with the motion periods.
    for (const [slug, profile] of Object.entries(WEATHER_PROFILES)) {
      const hash = weatherSlugHash(slug);
      const enteredAt = 1_000;
      for (const refTick of [
        enteredAt,
        enteredAt + 65_535,
        enteredAt + 65_536,
        enteredAt + 65_537,
        enteredAt + 131_072,
        enteredAt + 1_000_000,
      ]) {
        const age = weatherAgeTicks(refTick, enteredAt);
        const raw = refTick - enteredAt;
        for (let index = 0; index < profile.count; index++) {
          const viaAge = weatherParticle(profile, hash, index, age, VIEWPORT.width, VIEWPORT.height, 1);
          const viaRaw = weatherParticle(profile, hash, index, raw, VIEWPORT.width, VIEWPORT.height, 1);
          expect(viaAge, `${slug}[${index}]@${refTick}`).toEqual(viaRaw);
        }
      }
    }
  });
});

describe("weather profile table", () => {
  test("covers the imported slugs with a presentation policy", () => {
    for (const slug of ["cloudy", "foggy", "freezing", "hot", "misty", "rain", "snow", "sunny", "thunderstorm", "windy"]) {
      if (slug === "sunny" || slug === "hot" || slug === "freezing") {
        expect(WEATHER_PROFILES[slug], slug).toBeUndefined();
      } else {
        expect(WEATHER_PROFILES[slug], slug).toBeDefined();
      }
    }
  });

  test("pool size covers every profile", () => {
    for (const profile of Object.values(WEATHER_PROFILES)) {
      expect(profile.count).toBeLessThanOrEqual(MAX_WEATHER_PARTICLES);
    }
  });
});

describe("indoor map list", () => {
  test("contains known interiors and excludes outdoor towns", () => {
    expect(INDOOR_MAPS).toContain("bedroom_test");
    expect(INDOOR_MAPS.length).toBeGreaterThan(100);
    // Paper Town is an outdoor route map.
    expect(INDOOR_MAPS).not.toContain("spyder_paper_town");
  });

  test("is sorted", () => {
    const sorted = [...INDOOR_MAPS].sort();
    expect([...INDOOR_MAPS]).toEqual(sorted);
  });
});

describe("weather overlay menu suspension", () => {
  const menu = (open: boolean) => ({ isOpen: () => open });

  test("hides for either sibling menu and resumes only when both are closed", () => {
    expect(weatherOverlaySuspended(null, null)).toBeFalse();
    expect(weatherOverlaySuspended(menu(true), menu(false))).toBeTrue();
    expect(weatherOverlaySuspended(menu(false), menu(true))).toBeTrue();
    expect(weatherOverlaySuspended(menu(true), menu(true))).toBeTrue();
    expect(weatherOverlaySuspended(menu(false), menu(false))).toBeFalse();
    expect(weatherOverlaySuspended(menu(false), menu(false), menu(true))).toBeTrue();
    expect(weatherOverlaySuspended(menu(false), menu(false), menu(false))).toBeFalse();
  });
});

describe("weather envelope reader", () => {
  test("reads slug and ticks from the packed runtime wire", () => {
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "rain"),
    );
    const wire = packTuxemonExtensionState(state);
    const envelope = weatherEnvelopeAt(wire);
    expect(envelope).not.toBeNull();
    expect(envelope!.slug).toBe("rain");
    expect(envelope!.refTick).toBe(0);
    expect(envelope!.enteredAtTick).toBe(0);
    expect(envelope!.minuteOfDay).toBe(540);
  });

  test("caches by wire identity", () => {
    const state = initialTuxemonExtensionState();
    const wire = packTuxemonExtensionState(state);
    expect(weatherEnvelopeAt(wire)).toBe(weatherEnvelopeAt(wire));
  });

  test("returns null for non-runtime states", () => {
    expect(weatherEnvelopeAt(null)).toBeNull();
    expect(weatherEnvelopeAt("not-a-wire")).toBeNull();
    expect(weatherEnvelopeAt({})).toBeNull();
  });
});

describe("zero-alloc particle placement", () => {
  test("weatherParticleInto matches weatherParticle for every profile and tick", () => {
    const scratch: ParticlePlacement = { x: 0, y: 0, opacity: 0 };
    for (const [slug, profile] of Object.entries(WEATHER_PROFILES)) {
      const hash = weatherSlugHash(slug);
      for (const viewport of [VIEWPORT, { width: 960, height: 544 }]) {
        for (const age of [0, 1, 999, 65_535, 65_536, 1_000_000]) {
          for (let index = 0; index < profile.count; index++) {
            for (const dim of [0.45, 1]) {
              const fresh = weatherParticle(
                profile, hash, index, age, viewport.width, viewport.height, dim,
              );
              weatherParticleInto(
                profile, hash, index, age, viewport.width, viewport.height, dim, scratch,
              );
              expect(scratch, `${slug}[${index}]@${age} dim=${dim}`).toEqual(fresh);
            }
          }
        }
      }
    }
  });

  test("weatherParticleInto reuses the same out object", () => {
    const profile = WEATHER_PROFILES.rain!;
    const scratch: ParticlePlacement = { x: 0, y: 0, opacity: 0 };
    weatherParticleInto(profile, weatherSlugHash("rain"), 0, 10, 480, 272, 1, scratch);
    const first = scratch;
    weatherParticleInto(profile, weatherSlugHash("rain"), 0, 11, 480, 272, 1, scratch);
    expect(scratch).toBe(first);
  });
});

describe("zero-alloc envelope reader", () => {
  const PROFILE_SLUGS = Object.freeze(Object.keys(WEATHER_PROFILES));
  const scratch: WeatherEnvelope = { slug: "", enteredAtTick: 0, refTick: 0, minuteOfDay: 0 };

  function readInto(wire: unknown): boolean {
    return weatherEnvelopeInto(wire as never, scratch, PROFILE_SLUGS);
  }

  test("matches weatherEnvelopeAt for every profile slug", () => {
    for (const slug of [...PROFILE_SLUGS, "sunny", "hot", "freezing", "downpour"]) {
      const state = initialTuxemonExtensionState(
        timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, slug),
      );
      const wire = packTuxemonExtensionState(state);
      const expected = weatherEnvelopeAt(wire);
      const ok = readInto(wire);
      expect(ok).toBe(true);
      // Profile slugs are interned to the same reference; slugs without a
      // profile map to "" so the overlay hides without a fresh string.
      expect(scratch.slug).toBe(PROFILE_SLUGS.includes(slug) ? expected!.slug : "");
      expect(scratch.refTick).toBe(expected!.refTick);
      expect(scratch.enteredAtTick).toBe(expected!.enteredAtTick);
      expect(scratch.minuteOfDay).toBe(expected!.minuteOfDay);
    }
  });

  test("returns the interned profile slug (same reference, no fresh string)", () => {
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "rain"),
    );
    const wire = packTuxemonExtensionState(state);
    expect(readInto(wire)).toBe(true);
    expect(scratch.slug).toBe("rain");
    expect(PROFILE_SLUGS).toContain(scratch.slug);
  });

  test("matches after the clock has advanced (wire changes every tick)", () => {
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "snow"),
    );
    for (let tick = 0; tick < 5; tick++) {
      const advanced = { ...state, clock: { ...state.clock, refTick: tick } };
      const wire = packTuxemonExtensionState(advanced);
      const expected = weatherEnvelopeAt(wire);
      expect(expected).not.toBeNull();
      expect(readInto(wire)).toBe(true);
      expect(scratch).toEqual(expected!);
    }
  });

  test("returns false for non-runtime states", () => {
    expect(readInto(null)).toBe(false);
    expect(readInto("not-a-wire")).toBe(false);
    expect(readInto({})).toBe(false);
  });

  test("returns false for malformed wires", () => {
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "rain"),
    );
    const wire = packTuxemonExtensionState(state) as string;
    const prefix = "pocket-tuxemon/ext-runtime/v2:";
    const fields = wire.slice(prefix.length).split("\n");
    expect(fields.length).toBe(10);
    // Truncated: only 3 fields.
    expect(readInto(prefix + fields.slice(0, 3).join("\n"))).toBe(false);
    // A non-numeric refTick (field 1).
    const badRefTick = fields.slice();
    badRefTick[1] = "NOPE";
    expect(readInto(prefix + badRefTick.join("\n"))).toBe(false);
    // An eleventh field.
    expect(readInto(`${wire}\n123`)).toBe(false);
    // A leading-zero number (the reader rejects it like the regex does).
    const leadingZero = fields.slice();
    leadingZero[1] = "00";
    expect(readInto(prefix + leadingZero.join("\n"))).toBe(false);
  });

  test("maps an unknown or unquoted slug to the empty slug (no profile)", () => {
    // The overlay only needs to know whether the current weather has a
    // profile; an unrecognised slug and a malformed slug field both mean
    // "no overlay", so the hot-path reader interns known slugs and reports
    // "" for everything else instead of allocating a parse result.
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "rain"),
    );
    const wire = packTuxemonExtensionState(state) as string;
    const prefix = "pocket-tuxemon/ext-runtime/v2:";
    const fields = wire.slice(prefix.length).split("\n");
    const unquoted = fields.slice();
    unquoted[6] = "rain";
    expect(readInto(prefix + unquoted.join("\n"))).toBe(true);
    expect(scratch.slug).toBe("");
  });

  test("reuses the same out object across calls", () => {
    const state = initialTuxemonExtensionState(
      timeWeatherAt({ year: 2024, month: 6, day: 15, hour: 9, minute: 0 }, 3_600, "rain"),
    );
    const wire = packTuxemonExtensionState(state);
    expect(readInto(wire)).toBe(true);
    const first = scratch;
    expect(readInto(wire)).toBe(true);
    expect(scratch).toBe(first);
  });
});

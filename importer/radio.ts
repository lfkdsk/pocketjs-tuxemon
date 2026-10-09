// Build-time reader for Tuxemon's authored radio catalog. The importer keeps
// the source order because equal-distance tuner matches prefer the first
// station in radio_data.yaml.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RadioScalar = string | number | boolean | null;

export interface RadioBroadcastSource {
  conditions: {
    mapSlugs: string[];
    variables: Record<string, RadioScalar>;
  };
  dialogueKeys: string[];
  setVariables?: Record<string, RadioScalar>;
}

export interface RadioStationSource {
  slug: string;
  frequency?: number;
  defaultDialogueKeys: string[];
  conditionalBroadcasts: RadioBroadcastSource[];
}

export interface RadioSourceCatalog {
  stationOrder: string[];
  stations: Record<string, RadioStationSource>;
  mapStations: Record<string, string[]>;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, at: string, fallback: readonly string[] = []): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${at} must be an array of non-empty strings`);
  }
  return [...value];
}

function scalarRecord(value: unknown, at: string): Record<string, RadioScalar> {
  if (value === undefined) return {};
  const source = record(value, at);
  const output: Record<string, RadioScalar> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (entry !== null && typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`${at}.${key} must be a scalar`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error(`${at}.${key} must be finite`);
    }
    output[key] = entry as RadioScalar;
  }
  return output;
}

function broadcast(value: unknown, at: string, fallback: readonly string[]): RadioBroadcastSource {
  const row = record(value, at);
  const rawConditions = row.conditions === undefined ? {} : record(row.conditions, `${at}.conditions`);
  const rawMaps = rawConditions.map_slugs;
  const mapSlugs = typeof rawMaps === "string"
    ? [rawMaps]
    : stringList(rawMaps, `${at}.conditions.map_slugs`);
  const output: RadioBroadcastSource = {
    conditions: {
      mapSlugs,
      variables: scalarRecord(rawConditions.variables, `${at}.conditions.variables`),
    },
    dialogueKeys: stringList(row.dialogue, `${at}.dialogue`, fallback),
  };
  if (row.set_variables !== undefined) {
    output.setVariables = scalarRecord(row.set_variables, `${at}.set_variables`);
  }
  return output;
}

/** Read and validate the two mod-root YAML files used by NuPhoneRadioTuner. */
export function loadRadioSource(tuxemonSource: string): RadioSourceCatalog {
  const radioPath = join(tuxemonSource, "mods/radio_data.yaml");
  const mapsPath = join(tuxemonSource, "mods/radio_map_lists.yaml");
  const rawStations = record(Bun.YAML.parse(readFileSync(radioPath, "utf8")), "radio_data.yaml");
  const rawMaps = record(Bun.YAML.parse(readFileSync(mapsPath, "utf8")), "radio_map_lists.yaml");

  const stations: Record<string, RadioStationSource> = {};
  for (const [slug, raw] of Object.entries(rawStations)) {
    const row = record(raw, `radio_data.yaml.${slug}`);
    const rawDefault = row.default === undefined ? {} : record(row.default, `radio_data.yaml.${slug}.default`);
    const defaultDialogueKeys = stringList(
      rawDefault.dialogue,
      `radio_data.yaml.${slug}.default.dialogue`,
      ["radio_static_msgid"],
    );
    const rawConditional = row.conditional_broadcasts ?? [];
    if (!Array.isArray(rawConditional)) {
      throw new Error(`radio_data.yaml.${slug}.conditional_broadcasts must be an array`);
    }
    const frequency = row.frequency;
    if (frequency !== undefined && (typeof frequency !== "number" || !Number.isFinite(frequency))) {
      throw new Error(`radio_data.yaml.${slug}.frequency must be finite`);
    }
    stations[slug] = {
      slug,
      ...(frequency === undefined ? {} : { frequency }),
      defaultDialogueKeys,
      conditionalBroadcasts: rawConditional.map((entry, index) => broadcast(
        entry,
        `radio_data.yaml.${slug}.conditional_broadcasts[${index}]`,
        defaultDialogueKeys,
      )),
    };
  }

  const mapStations: Record<string, string[]> = {};
  for (const [map, raw] of Object.entries(rawMaps)) {
    const slugs = stringList(raw, `radio_map_lists.yaml.${map}`);
    for (const slug of slugs) {
      if (stations[slug] === undefined) {
        throw new Error(`radio_map_lists.yaml.${map} references unknown station '${slug}'`);
      }
    }
    mapStations[map] = slugs;
  }

  return {
    stationOrder: Object.keys(rawStations),
    stations,
    mapStations,
  };
}

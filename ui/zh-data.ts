// All zh_CN JSON data that would otherwise bloat non-zh bundles. The PSP
// build swaps this module for an English-only stub (tools/psp.ts swaps it
// with tools/psp-stubs/zh-data.ts during the compile), so the PSP JS bundle
// carries no zh_CN JSON. Web and desktop keep the full data — the language
// switcher needs both.
import rawProjectZh from "../dist/project-shell.zh_CN.json";
import shellZhJson from "../dist/battle-runtime-shell.zh_CN.json";
import namesZh from "../data/battle-names.zh_CN.json";
import mapDescriptionsZh from "../dist/map-descriptions.zh_CN.json";
import monthNamesZh from "../data/month-names.zh_CN.json";
import type { ZhData } from "./zh-data-types.ts";

export const zhData: ZhData = {
  project: rawProjectZh as unknown as ZhData["project"],
  battleShell: shellZhJson as unknown as ZhData["battleShell"],
  names: namesZh as unknown as ZhData["names"],
  mapDescriptions: mapDescriptionsZh as unknown as ZhData["mapDescriptions"],
  monthNames: monthNamesZh as unknown as ZhData["monthNames"],
};

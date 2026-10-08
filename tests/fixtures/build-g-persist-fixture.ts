// Build the four constructed presentation-transfer maps through the same
// buildProject/convertActions path as the complete game import. The parent
// test supplies an isolated TUXEMON_SRC with the small source fixtures and
// copied upstream art needed by the actions.

import { buildProject, G6_IMPORT_OPTIONS } from "../../importer/project.ts";

const featureMaps = {
  animation: "persist_animation",
  camera: "persist_camera",
  balloon: "persist_balloon",
  backdrop: "persist_backdrop",
} as const;

const builds = Object.fromEntries(Object.entries(featureMaps).map(([feature, source]) => {
  const { project, report } = buildProject([source, "persist_target"], G6_IMPORT_OPTIONS);
  return [feature, { project, coverage: report.coverage }];
}));

console.log(JSON.stringify(builds));

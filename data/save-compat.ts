import type { MapContentVersion } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";

/** Reviewed load-only content identities from published Pocket Tuxemon builds.
 * New saves are always stamped with the current build identity. */
export const TUXEMON_COMPATIBLE_SAVE_CONTENT = Object.freeze([
  {
    manifest: "e097077e01674a27d654bf647ea1a533ffa46108dd9b0873e4e18da7b759988a",
    schema: "138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022",
  },
  {
    manifest: "8dbaf5c7a2aafb9ee45079c12e309131179b0c77f313c14bc2c76fe251a3ded3",
    schema: "138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022",
  },
  {
    manifest: "4b08ab85260a93f78cd6582fb2e2d6ea5744101b37519a8a4f78d6bc0b231b36",
    schema: "138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022",
  },
  {
    manifest: "6322d4d6af2331cd68011422320424f4357d6e546e3d6f83e7e7ef47ae7c4551",
    schema: "5eecc57a1acad4721139225b1bed1e35ae581706c29e611909d58b2c90efb41b",
  },
  {
    manifest: "ca696ff59ec6fbf0c18ccb860f491a2b6fbc0db0c58e152115fc81e1f6b23ba0",
    schema: "138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022",
  },
  {
    manifest: "ec6bf29b5866de336888a1ca29bbd86982c85a149f2a819d1a5d1a575c86206c",
    schema: "5eecc57a1acad4721139225b1bed1e35ae581706c29e611909d58b2c90efb41b",
  },
  {
    manifest: "b9c5428e521e851a93bcb7b8f9b4efa01b584871189adbfc3b7820e6472be555",
    schema: "5eecc57a1acad4721139225b1bed1e35ae581706c29e611909d58b2c90efb41b",
  },
  {
    manifest: "552659986a19c396943aea355fa8099908f97daeca99ad9b1374dbf2ceb08991",
    schema: "70564328ea0fd8a8028ac6f360f82dda0973a068ad54f4a705fb3a3cd5531905",
  },
  {
    manifest: "31247f754c7bbd2a8a38d9f627deb2fa82a5edfc74556a0c9a7616d80b9ba119",
    schema: "c5d8a3f0ed118bfd8d99f2a0b4dda7479918506c3728d09097f1ef662788af2c",
  },
] as const satisfies readonly MapContentVersion[]);

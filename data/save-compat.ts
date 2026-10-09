import type { MapContentVersion } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";

/** Reviewed load-only content identities from published Pocket Tuxemon builds.
 * New saves are always stamped with the current build identity. */
export const TUXEMON_COMPATIBLE_SAVE_CONTENT = Object.freeze([
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

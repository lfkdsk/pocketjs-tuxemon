// Cheap, no-write guard for every maintained golden checkpoint. It runs the
// same tape loading, identity checks and pure-reducer capture path used by the
// four screenshot generators, but never boots the renderer or writes PNGs.

import { verifyGoldenSync } from "./golden-sync.ts";

const started = performance.now();
const captures = verifyGoldenSync();
for (const { checkpoint, timelineFrame } of captures) {
  console.log(`${checkpoint.suite}/${checkpoint.name}: mask f${checkpoint.maskFrame} -> `
    + `reducer f${timelineFrame} ${checkpoint.map}@${checkpoint.position.join(",")}`);
}
console.log(`GOLDEN SYNC PASS checkpoints=${captures.length} elapsedMs=${(performance.now() - started).toFixed(1)}`);

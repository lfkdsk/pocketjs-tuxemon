// Build Pocket Tuxemon's static web site and keep the audio credits readable
// beside the downloadable game. The same file also travels inside the pak.

import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await run([process.execPath, join(root, "gen-assets.ts")]);
await run([
  process.execPath,
  join(root, "vendor", "pocket-rpgkit", "tools", "web.ts"),
  "--project-root=.",
  "pocket-tuxemon",
]);
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(root, "dist", "web", "pocket-tuxemon", "AUDIO-ATTRIBUTIONS.md"),
);

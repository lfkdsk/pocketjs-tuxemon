// Browser-side helper for deterministic Chrome verifiers. Production rAF is
// already gated by the player; tools that freeze rAF and call step() directly
// must wait for the same demand blocker and retry the exact held input.

export const WEB_CHUNK_AWARE_STEP_SOURCE = `
globalThis.__pocketTestStep = async () => {
  const player = globalThis.__pocketPlayer;
  if (!player) return false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 20; attempt++) {
    const deadline = performance.now() + 30000;
    while (player.pakChunks?.blocking && performance.now() < deadline) await sleep(1);
    if (player.pakChunks?.blocking) throw new Error("Chrome verifier timed out waiting for a pak chunk");
    // Legacy/single-pak players returned undefined; only an explicit false
    // means this frame met a newly-created demand blocker.
    if (player.step() !== false) return true;
    if (!player.pakChunks?.blocking && !player.frameBlocked) {
      throw new Error("Chrome verifier step stopped without a pak blocker");
    }
    // Raw bytes can become resident one microtask before GameView's compiled
    // preparation publishes ready. Retrying here consumes no host/core frame.
    if (!player.pakChunks?.blocking) await sleep(0);
  }
  throw new Error("Chrome verifier could not retry a blocked input frame");
};`;

export const WEB_CHUNK_AWARE_STEP_EXPRESSION =
  `globalThis.__pocketTestStep ? globalThis.__pocketTestStep() : globalThis.__pocketPlayer?.step()`;

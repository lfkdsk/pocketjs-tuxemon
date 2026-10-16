// Optional browser bridge installed by Pocket RPG Kit's chunked Web player.
// Desktop, PSP, sim and legacy single-pak pages have no such global and keep
// their existing synchronous paths.

import type { GameViewMapLoadFailure } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";

export interface BrowserPakStats {
  startupBytes: number;
  resident: string[];
  pending: string[];
  queued: string[];
  blocking: string[];
  failures: Record<string, string>;
  compressedBytes: number;
}

export interface BrowserPakChunks {
  ready(key: string): boolean;
  prepare(key: string): Promise<void>;
  prefetch(key: string): Promise<void>;
  /** Hold the current host/core frame while GameView retries a map acquire. */
  setFrameBlocked?(blocked: boolean): void;
  stats(): BrowserPakStats;
}

export interface BrowserPwaControls {
  showMapLoadFailure(failure: GameViewMapLoadFailure): void;
}

export function browserPakChunks(): BrowserPakChunks | null {
  const value = (globalThis as typeof globalThis & {
    __pocketPak?: BrowserPakChunks;
  }).__pocketPak;
  return value && typeof value.ready === "function" &&
      typeof value.prepare === "function" && typeof value.prefetch === "function"
    ? value
    : null;
}

/** Resolve the optional page-level recovery UI once during browser mount.
 * Leaving this undefined preserves GameView's fatal behavior on native hosts
 * and on legacy pages that do not install the PWA controller. */
export function browserPwaMapLoadErrorHandler():
  ((failure: GameViewMapLoadFailure) => void) | undefined {
  const value = (globalThis as typeof globalThis & {
    __pocketPwa?: Partial<BrowserPwaControls>;
  }).__pocketPwa;
  return value && typeof value.showMapLoadFailure === "function"
    ? (failure) => value.showMapLoadFailure!(failure)
    : undefined;
}

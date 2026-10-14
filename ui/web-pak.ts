// Optional browser bridge installed by Pocket RPG Kit's chunked Web player.
// Desktop, PSP, sim and legacy single-pak pages have no such global and keep
// their existing synchronous paths.

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
  stats(): BrowserPakStats;
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

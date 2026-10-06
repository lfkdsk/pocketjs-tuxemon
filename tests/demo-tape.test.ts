// The web demo's chapter tapes live in one pak entry. Building the options
// must not read the pak; the first chapter selection decodes the tape once,
// and every chapter windows that one decoded tape.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildZhDemoData, encodeTape, type DemoDataBuild } from "../importer/demo-data.ts";
import { createDemoOptions, decodeDemoTape } from "../ui/demo-tape.ts";
import {
  DEMO_CHAPTER_INDEX,
  DEMO_CHAPTER_INDEX_ZH,
  DEMO_SNAPSHOTS_ENTRY,
  DEMO_SNAPSHOTS_ENTRY_ZH,
  DEMO_TAPE_ENTRY,
  DEMO_TAPE_ENTRY_ZH,
} from "../ui/demo-index.ts";
import { loadTape, ROOT } from "../tools/bake-chapters.ts";
import { zhMainlineMasks } from "../tools/transcribe-zh-tape.ts";
import { sha256 } from "../tools/zh-tape.ts";
import { chapterTape, chapterTapeFrames } from "../vendor/pocket-rpgkit/src/ui/demo/runtime.ts";

/** Raw-format tape (see decodeTape): frame i holds i & 0xffff. */
function rawTape(
  frames: number,
  worldTraversal: "legacy-transfer" | "seamless-v1" = "legacy-transfer",
): Uint8Array {
  const bytes = new Uint8Array(8 + frames * 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x54;
  bytes[1] = worldTraversal === "seamless-v1" ? 2 : 1;
  bytes[2] = 2;
  if (worldTraversal === "seamless-v1") bytes[3] = 1 << 5;
  view.setUint32(4, frames, true);
  for (let i = 0; i < frames; i++) view.setUint16(8 + i * 2, i & 0xffff, true);
  return bytes;
}

describe("demo chapter tapes", () => {
  const total = Math.max(...DEMO_CHAPTER_INDEX.map((entry) => entry.frame + entry.suffixFrames));
  const authoredTraversal = ((DEMO_CHAPTER_INDEX[0] as { worldTraversal?: "legacy-transfer" | "seamless-v1" })
    .worldTraversal ?? "legacy-transfer");

  test("one shared provider, read once, windowed without copies", () => {
    expect(DEMO_CHAPTER_INDEX.length as number).toBe(20);
    expect((DEMO_CHAPTER_INDEX.at(-1) as { id: string } | undefined)?.id).toBe("kernel-defeated");
    const reads: string[] = [];
    const options = createDemoOptions((entry) => {
      reads.push(entry);
      if (entry !== DEMO_TAPE_ENTRY) throw new Error(`unexpected read ${entry}`);
      return rawTape(total, authoredTraversal);
    }, authoredTraversal);
    expect(reads).toEqual([]);
    const providers = new Set(options.chapters.map((chapter) => chapter.tape));
    expect(providers.size).toBe(1);
    // The autoplay page lists chapters from the declared window.
    for (const [index, chapter] of options.chapters.entries()) {
      expect(chapterTapeFrames(chapter)).toBe(DEMO_CHAPTER_INDEX[index]!.suffixFrames);
    }
    expect(reads).toEqual([]);

    const tapes = options.chapters.map((chapter) => chapterTape(chapter) as Uint16Array);
    expect(reads).toEqual([DEMO_TAPE_ENTRY]);
    const buffer = tapes[0]!.buffer;
    for (const [index, tape] of tapes.entries()) {
      const entry = DEMO_CHAPTER_INDEX[index]!;
      expect(tape.buffer).toBe(buffer);
      expect(tape.length).toBe(entry.suffixFrames);
      expect(tape[0]).toBe(entry.frame & 0xffff);
    }
    options.chapters.forEach((chapter) => chapterTape(chapter));
    expect(reads).toEqual([DEMO_TAPE_ENTRY]);
  });

  test("chapter snapshots decode without browser TextDecoder globals", () => {
    const authored = JSON.parse(readFileSync("data/chapters.json", "utf8")) as {
      chapters: { id: string; snapshot: string }[];
    };
    const first = authored.chapters[0]!;
    const bytes = Buffer.from(JSON.stringify({
      worldTraversal: authoredTraversal,
      snapshots: { [first.id]: first.snapshot },
    }));
    const options = createDemoOptions((entry) => {
      if (entry !== DEMO_SNAPSHOTS_ENTRY) throw new Error(`unexpected read ${entry}`);
      return bytes;
    }, authoredTraversal);
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = globals.TextDecoder;
    try {
      globals.TextDecoder = undefined;
      expect((options.chapters[0]!.snapshot as { map: string }).map).toBe("spyder_bedroom");
    } finally {
      globals.TextDecoder = original;
    }
  });

  test("binary traversal identity is explicit and old v1 tapes stay legacy", () => {
    expect(decodeDemoTape(rawTape(3)).worldTraversal).toBe("legacy-transfer");

    const nibble = decodeDemoTape(encodeTape([0, 0x10, 0x2000], "seamless-v1"));
    expect(nibble.worldTraversal).toBe("seamless-v1");
    expect([...nibble.masks]).toEqual([0, 0x10, 0x2000]);

    const rawMasks = Array.from({ length: 17 }, (_, value) => value);
    const raw = decodeDemoTape(encodeTape(rawMasks, "seamless-v1"));
    expect(raw.worldTraversal).toBe("seamless-v1");
    expect([...raw.masks]).toEqual(rawMasks);
  });

  test("the game adapter rejects a binary from another traversal timeline", () => {
    const other = authoredTraversal === "seamless-v1" ? "legacy-transfer" : "seamless-v1";
    const options = createDemoOptions((entry) => {
      if (entry !== DEMO_TAPE_ENTRY) throw new Error(`unexpected read ${entry}`);
      return encodeTape([0], other);
    }, authoredTraversal);
    expect(() => chapterTape(options.chapters[0]!)).toThrow(/worldTraversal .* != expected/);
  });
});

describe("Chinese demo resource selection", () => {
  const { combined } = loadTape();
  const zhMasks = zhMainlineMasks(ROOT);
  const zh = buildZhDemoData(ROOT, { masks: combined, worldTraversal: "seamless-v1" } as unknown as DemoDataBuild);
  expect(zh.data).not.toBeNull();
  const enChapters = JSON.parse(readFileSync("data/chapters.json", "utf8")) as {
    chapters: { id: string; snapshot: string }[];
  };
  // The English demo tape is the canonical tape with the en-demo insertions,
  // so the English index windows a tape of its own (longer) length.
  const enTotal = Math.max(...DEMO_CHAPTER_INDEX.map((entry) => entry.frame + entry.suffixFrames));
  const entries: Record<string, Uint8Array> = {
    [DEMO_TAPE_ENTRY]: encodeTape(new Array<number>(enTotal).fill(0), "seamless-v1"),
    [DEMO_TAPE_ENTRY_ZH]: zh.data!.tapeBytes,
    [DEMO_SNAPSHOTS_ENTRY]: Buffer.from(JSON.stringify({
      worldTraversal: "seamless-v1",
      snapshots: Object.fromEntries(enChapters.chapters.map((c) => [c.id, c.snapshot])),
    })),
    [DEMO_SNAPSHOTS_ENTRY_ZH]: Buffer.from(zh.data!.snapshotsJson),
  };
  function fakeRead(): { read: (entry: string) => Uint8Array; reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      read: (entry: string) => {
        reads.push(entry);
        const bytes = entries[entry];
        if (!bytes) throw new Error(`unexpected read ${entry}`);
        return bytes;
      },
    };
  }

  test("a Chinese boot reads the Chinese tape and saves and lists Chinese titles", () => {
    const { read, reads } = fakeRead();
    const options = createDemoOptions(read, "seamless-v1", "zh_CN");
    expect(options.demoResources).toEqual({
      tapeEntry: DEMO_TAPE_ENTRY_ZH,
      snapshotsEntry: DEMO_SNAPSHOTS_ENTRY_ZH,
    });
    expect(options.chapters.map((c) => c.title)).toEqual(DEMO_CHAPTER_INDEX_ZH.map((c) => c.title));
    expect(options.chapters[0]!.title).toMatch(/[一-鿿]/);
    // The tape provider decodes the Chinese entry to the transcribed tape.
    const tape = chapterTape(options.chapters[0]!) as Uint16Array;
    expect(reads).toEqual([DEMO_TAPE_ENTRY_ZH]);
    expect(tape.length).toBe(zhMasks.length);
    expect(sha256(JSON.stringify([...tape]))).toBe(sha256(JSON.stringify([...zhMasks])));
    // The snapshot getter reads the Chinese snapshots entry.
    reads.length = 0;
    expect((options.chapters[0]!.snapshot as { map: string }).map).toBe("spyder_bedroom");
    expect(reads).toEqual([DEMO_SNAPSHOTS_ENTRY_ZH]);
  });

  test("an English boot reads the English tape and saves", () => {
    const { read, reads } = fakeRead();
    const options = createDemoOptions(read, "seamless-v1", "en_US");
    expect(options.demoResources).toEqual({
      tapeEntry: DEMO_TAPE_ENTRY,
      snapshotsEntry: DEMO_SNAPSHOTS_ENTRY,
    });
    expect(options.chapters.map((c) => c.title)).toEqual(DEMO_CHAPTER_INDEX.map((c) => c.title));
    const tape = chapterTape(options.chapters[0]!) as Uint16Array;
    expect(reads).toEqual([DEMO_TAPE_ENTRY]);
    expect(tape.length).toBe(enTotal);
  });
});

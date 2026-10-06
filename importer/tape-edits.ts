// Applying serialized tape edits to a source tape.
//
// The transcriber records edits as frame/source/target triples
// (tools/zh-tape.ts) and the importer applies the committed Chinese tape's
// edits when it packs the demo pak (importer/demo-data.ts). Both go through
// this one loop, so a non-empty edit file cannot pass the transcriber's
// tests while the production pak silently ships the unedited tape.

/** A frame of the source tape rewritten to another mask. */
export interface TapeEdit {
  /** Index into the tape (the mask folded to produce state.frame + 1). */
  frame: number;
  source: number;
  target: number;
}

/** Apply the edits to the source tape, in order. An edit whose source mask
 *  no longer matches — a stale transcription, or a shuffled order where one
 *  edit's source is another edit's target — is an error, not a silent
 *  misapply. */
export function applyTapeEdits(source: readonly number[], edits: readonly TapeEdit[]): number[] {
  const out = [...source];
  for (const edit of edits) {
    if (out[edit.frame] !== edit.source) {
      throw new Error(`tape edit at frame ${edit.frame}: source mask ${out[edit.frame]} != recorded ${edit.source}`);
    }
    out[edit.frame] = edit.target;
  }
  return out;
}

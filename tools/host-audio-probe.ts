// Shared native-host audio probe used by the desktop QuickJS and PSP/PPSSPP
// gates. It wraps the mounted PocketJS audio namespace after app evaluation;
// no counters enter reducer state or production release bundles.

export const AUDIO_PROBE_GLOBAL = "__pocketTuxemonAudioProbe";
export const BATTLE_TRACK = "music_battle_loop";
export const VICTORY_TRACK = "music_win_battle_boss";
export const DEFEAT_TRACK = "music_gameover";

export interface HostAudioPhase {
  writes: number;
  acceptedFrames: number;
  nonZeroSamples: number;
  peak: number;
  plays: number;
  creditEvents: number;
  creditedFrames: number;
  underruns: number;
}

export interface HostAudioProbeReport {
  native: boolean;
  sequence: (string | null)[];
  mapBeforeBattle: string | null;
  restored: string | null;
  finalScene: string | null;
  writes: number;
  acceptedFrames: number;
  nonZeroSamples: number;
  peak: number;
  plays: number;
  creditEvents: number;
  creditedFrames: number;
  underruns: number;
  phases: Record<string, HostAudioPhase>;
}

/** ES2020 source evaluated inside a mounted PocketJS guest. The native
 * methods remain the point of truth: accepted frames are their return value,
 * and credit/underrun events are observed without removing them from the
 * player's poll stream. */
export function hostAudioProbeSource(): string {
  const globalName = JSON.stringify(AUDIO_PROBE_GLOBAL);
  const battle = JSON.stringify(BATTLE_TRACK);
  const victory = JSON.stringify(VICTORY_TRACK);
  return `;(()=>{
const native=globalThis.audio;
const phase=()=>({writes:0,acceptedFrames:0,nonZeroSamples:0,peak:0,plays:0,creditEvents:0,creditedFrames:0,underruns:0});
const p={native:!!native,sequence:[],mapBeforeBattle:null,restored:null,finalScene:null,writes:0,acceptedFrames:0,nonZeroSamples:0,peak:0,plays:0,creditEvents:0,creditedFrames:0,underruns:0,phases:{},current:null,streams:{},seenVictory:false};
const bucket=()=>{const id=p.current??"__none__";return p.phases[id]??(p.phases[id]=phase());};
p.observe=()=>{const s=globalThis.__rpgSessionState;const id=s?.interp?.audio?.bgm?.id??null;if(id!==p.current){if(id===${battle}&&p.current!==null)p.mapBeforeBattle=p.current;if(id===${victory})p.seenVictory=true;p.sequence.push(id);p.current=id;}p.finalScene=s?.scene?.kind??null;if(p.seenVictory&&p.mapBeforeBattle!==null&&p.finalScene===null&&id===p.mapBeforeBattle)p.restored=id;};
p.report=()=>({native:p.native,sequence:p.sequence,mapBeforeBattle:p.mapBeforeBattle,restored:p.restored,finalScene:p.finalScene,writes:p.writes,acceptedFrames:p.acceptedFrames,nonZeroSamples:p.nonZeroSamples,peak:p.peak,plays:p.plays,creditEvents:p.creditEvents,creditedFrames:p.creditedFrames,underruns:p.underruns,phases:p.phases});
if(native){
 const create=native.createStream;native.createStream=function(rate,channels){const handle=create(rate,channels);if(handle>=0)p.streams[handle]={channels,free:16384};return handle;};
 const write=native.writePcm;native.writePcm=function(handle,pcm){p.observe();const accepted=write(handle,pcm);const b=bucket();p.writes++;b.writes++;p.acceptedFrames+=accepted;b.acceptedFrames+=accepted;const stream=p.streams[handle];if(stream)stream.free=Math.max(0,stream.free-accepted);const samples=new Int16Array(pcm);const n=Math.min(samples.length,accepted*(stream?.channels??1));for(let i=0;i<n;i++){const a=Math.abs(samples[i]);if(a!==0){p.nonZeroSamples++;b.nonZeroSamples++;}if(a>p.peak)p.peak=a;if(a>b.peak)b.peak=a;}return accepted;};
 // The audio driver can start a newly selected track inside frame(), before
 // the frame wrapper below observes the reducer state. Refresh here so the
 // write/play belongs to the track being started instead of the previous phase.
 const play=native.play;native.play=function(handle){p.observe();p.plays++;bucket().plays++;return play(handle);};
 const poll=native.poll;native.poll=function(){const line=poll();if(typeof line==="string"){try{const event=JSON.parse(line);const b=bucket();if(event.t==="underrun"){p.underruns++;b.underruns++;}else if(event.t==="credit"&&typeof event.free==="number"){p.creditEvents++;b.creditEvents++;const stream=p.streams[event.h];if(stream){const credited=Math.max(0,event.free-stream.free);p.creditedFrames+=credited;b.creditedFrames+=credited;stream.free=event.free;}}}catch{}}return line;};
}
const frame=globalThis.frame;if(typeof frame==="function")globalThis.frame=function(){const out=frame.apply(this,arguments);p.observe();return out;};
globalThis[${globalName}]=p;p.observe();
})();`;
}

export function validateBattleAudioReport(
  value: unknown,
  options: { allowUnthrottledUnderruns?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["audio probe report is not an object"];
  }
  const report = value as Partial<HostAudioProbeReport>;
  if (report.native !== true) errors.push("native audio namespace was not mounted");
  if (typeof report.mapBeforeBattle !== "string" || report.mapBeforeBattle.length === 0) {
    errors.push("map BGM before battle was not observed");
  }
  if (report.restored !== report.mapBeforeBattle) {
    errors.push(`map BGM was not restored (${String(report.mapBeforeBattle)} -> ${String(report.restored)})`);
  }
  if (report.finalScene !== null) errors.push(`terminal scene is ${String(report.finalScene)}, expected null`);
  if (!options.allowUnthrottledUnderruns && report.underruns !== 0) {
    errors.push(`native host reported ${String(report.underruns)} underrun(s)`);
  }
  for (const field of ["creditEvents", "creditedFrames"] as const) {
    if (!(typeof report[field] === "number" && report[field] > 0)) {
      errors.push(`native device clock ${field} is not positive (${String(report[field])})`);
    }
  }
  for (const id of [BATTLE_TRACK, VICTORY_TRACK]) {
    const phase = report.phases?.[id];
    if (!phase) {
      errors.push(`${id} phase was not observed`);
      continue;
    }
    // Credit events are asynchronous: a short result cue can be replaced by
    // the restored map mix before its credit reaches poll(). Require device-
    // clock progress globally, while binding PCM writes/non-zero samples to
    // each battle phase itself.
    for (const field of ["writes", "acceptedFrames", "nonZeroSamples", "peak", "plays"] as const) {
      if (!(typeof phase[field] === "number" && phase[field] > 0)) {
        errors.push(`${id} ${field} is not positive (${String(phase[field])})`);
      }
    }
    if (!options.allowUnthrottledUnderruns && phase.underruns !== 0) {
      errors.push(`${id} reported ${String(phase.underruns)} underrun(s)`);
    }
  }
  const sequence = report.sequence ?? [];
  const battleIndex = sequence.indexOf(BATTLE_TRACK);
  const victoryIndex = sequence.indexOf(VICTORY_TRACK);
  const restoredIndex = typeof report.restored === "string"
    ? sequence.lastIndexOf(report.restored)
    : -1;
  if (!(battleIndex >= 0 && victoryIndex > battleIndex && restoredIndex > victoryIndex)) {
    errors.push(`BGM sequence is incomplete or out of order: ${JSON.stringify(sequence)}`);
  }
  return errors;
}

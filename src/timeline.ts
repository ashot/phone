// One model of a finished (or live) call: aligned transcript lines, notes, and the result.
// The text transcript, `phone ls`, and the HTML page all render from this.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { callDir, readEvents, type Meta, type PhoneEvent } from "./store";
import { spoken, spokenTurns, human } from "./text";

export type Line = { who: "them" | "agent"; text: string; at: number | null; interrupted?: boolean; late?: boolean };
export type Note = { kind: string; text: string; at: number | null; qid?: string };
export type CallRecord = {
  id: string;
  mode: Meta["mode"];
  number: string;
  from: string;
  created: number;
  state: Meta["state"];
  status: string; // one short human label: "talked 1m55s", "no answer", "live", ...
  connected: boolean;
  ended_reason?: string;
  duration?: number;
  goal: string;
  result?: Record<string, any>;
  lines: Line[];
  notes: Note[];
  recording?: string; // file name inside the call directory
};

export const transcriptPath = (id: string) => join(callDir(id), "transcript.json");
export const recordingPath = (id: string) => join(callDir(id), "recording.mp3");

const NOTE_TYPES: Record<string, (e: PhoneEvent) => string> = {
  question: (e) => e.text,
  question_timeout: () => "No reply in time; the agent carried on.",
  answer: (e) => e.text,
  steer: (e) => e.text,
  say: (e) => e.text,
  keys: (e) => `${e.by === "you" ? "You" : "The agent"} pressed ${e.digits}`,
  hangup: (e) => (e.now ? "You cut the line." : "You asked the agent to wrap up."),
  error: (e) => e.message,
};

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function statusLabel(meta: Meta, ended?: PhoneEvent): string {
  if (!["ended", "failed", "ending"].includes(meta.state)) {
    return { starting: "starting", dialing: "dialing", ringing: "ringing", listening: "listening", "in-progress": "live" }[meta.state as string] ?? meta.state;
  }
  if (!meta.answered_at) {
    const reason = meta.ended_reason ?? "";
    if (/busy/.test(reason)) return "busy";
    if (/nobody answered/.test(reason)) return "no answer";
    if (/no call arrived/.test(reason)) return "no call came";
    return "failed";
  }
  return `talked ${human(ended?.duration ?? 0)}`;
}

// ElevenLabs' final transcript has turn start times on the recording's clock (within about a
// second), catches words said right before a hangup, and marks interruptions. Our live events
// time a line when its transcription finished, which is late for the other party's lines.
function linesFromElevenLabs(transcript: any[], events: PhoneEvent[], answeredAt: number): Line[] {
  const entries = spokenTurns(transcript);
  // Calibrate: agent lines appear in both, so the median gap between the clocks is the offset.
  const key = (s: string) => spoken(s).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  const ours = new Map(events.filter((e) => e.type === "agent" && !e.late).map((e) => [key(e.text), (e.t - answeredAt) / 1000]));
  const gaps = entries.filter((t) => t.role === "agent" && ours.has(key(t.message))).map((t) => ours.get(key(t.message))! - t.time_in_call_secs).sort((a, b) => a - b);
  const offset = gaps.length ? Math.max(-2, Math.min(2, gaps[Math.floor(gaps.length / 2)])) : 0;
  return entries.map((t) => ({
    who: t.role === "user" ? "them" : "agent",
    text: t.role === "agent" ? spoken(t.message) : t.message.trim(),
    at: Math.max(0, t.time_in_call_secs + offset),
    interrupted: !!t.interrupted || undefined,
  }));
}

function linesFromEvents(events: PhoneEvent[], answeredAt: number): Line[] {
  const lines: Line[] = [];
  for (const e of events) {
    if (e.type === "agent_cut" && lines.at(-1)?.who === "agent") {
      Object.assign(lines.at(-1)!, { text: e.text, interrupted: true });
      continue;
    }
    if (e.type !== "them" && e.type !== "agent") continue;
    const heard = (e.t - answeredAt) / 1000;
    // A "them" line lands when they finish talking: back off by a speaking-rate estimate.
    const at = e.late ? null : Math.max(lines.at(-1)?.at ?? 0, e.type === "them" ? heard - words(e.text) / 2.6 : heard);
    lines.push({ who: e.type, text: e.text, at, late: e.late || undefined });
  }
  return lines;
}

export function buildRecord(meta: Meta): CallRecord {
  const events = readEvents(meta.id);
  const ended = events.find((e) => e.type === "ended");
  const result = events.findLast((e) => e.type === "result");
  const answeredAt = meta.answered_at ?? meta.created;
  const cached = existsSync(transcriptPath(meta.id)) ? JSON.parse(readFileSync(transcriptPath(meta.id), "utf8")) : null;
  const rel = (e: PhoneEvent) => (meta.answered_at && e.t >= meta.answered_at ? (e.t - meta.answered_at) / 1000 : null);
  return {
    id: meta.id,
    mode: meta.mode,
    number: meta.number,
    from: meta.from,
    created: meta.created,
    state: meta.state,
    status: statusLabel(meta, ended),
    connected: !!meta.answered_at,
    ended_reason: meta.ended_reason,
    duration: ended?.duration,
    goal: meta.goal,
    result: result ? { ...result, seq: undefined, t: undefined, type: undefined } : undefined,
    lines: cached ? linesFromElevenLabs(cached, events, answeredAt) : linesFromEvents(events, answeredAt),
    notes: events.filter((e) => NOTE_TYPES[e.type]).map((e) => ({ kind: e.type, text: NOTE_TYPES[e.type](e), at: rel(e), qid: e.qid })),
    recording: existsSync(recordingPath(meta.id)) ? "recording.mp3" : undefined,
  };
}

export function saveTranscript(id: string, transcript: any[]) {
  writeFileSync(transcriptPath(id), JSON.stringify(transcript));
}

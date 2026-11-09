// On-disk state for calls. The daemon that owns a call is the only writer of its
// events and meta; every CLI command is a reader (plus the control socket).
import { homedir } from "os";
import { join } from "path";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";

export const HOME = process.env.PHONE_HOME ?? join(homedir(), ".phone");
export const CALLS = join(HOME, "calls");

export type CallState = "starting" | "dialing" | "ringing" | "listening" | "in-progress" | "ending" | "ended" | "failed";

export type Meta = {
  id: string;
  mode: "outbound" | "inbound";
  number: string; // the other party (outbound) or our number (inbound)
  from: string;
  goal: string;
  created: number;
  state: CallState;
  pid?: number;
  control?: string;
  twilio_sid?: string;
  conversation_id?: string;
  answered_at?: number;
  ended_at?: number;
  ended_reason?: string;
  options: Record<string, any>;
};

export type PhoneEvent = { seq: number; t: number; type: string; [k: string]: any };

export const callDir = (id: string) => join(CALLS, id);
const metaPath = (id: string) => join(callDir(id), "meta.json");
const eventsPath = (id: string) => join(callDir(id), "events.jsonl");
const cursorPath = (id: string) => join(callDir(id), "cursor");

export function newCallId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz"; // letters only, so ids never look like keypad digits
  let id = "";
  for (let i = 0; i < 4; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return existsSync(callDir(id)) ? newCallId() : id;
}

export function createCall(meta: Meta) {
  mkdirSync(callDir(meta.id), { recursive: true });
  writeMeta(meta);
}

export function readMeta(id: string): Meta {
  return JSON.parse(readFileSync(metaPath(id), "utf8"));
}

export function writeMeta(meta: Meta) {
  writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function updateMeta(id: string, patch: Partial<Meta>): Meta {
  const meta = { ...readMeta(id), ...patch };
  writeMeta(meta);
  return meta;
}

export function readEvents(id: string): PhoneEvent[] {
  if (!existsSync(eventsPath(id))) return [];
  return readFileSync(eventsPath(id), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function eventWriter(id: string) {
  let seq = readEvents(id).reduce((m, e) => Math.max(m, e.seq), 0);
  return (type: string, data: Record<string, any> = {}): PhoneEvent => {
    const event = { seq: ++seq, t: Date.now(), type, ...data };
    appendFileSync(eventsPath(id), JSON.stringify(event) + "\n");
    return event;
  };
}

export function readCursor(id: string): number {
  return existsSync(cursorPath(id)) ? Number(readFileSync(cursorPath(id), "utf8")) || 0 : 0;
}

export function writeCursor(id: string, seq: number) {
  writeFileSync(cursorPath(id), String(seq));
}

export function listCalls(): Meta[] {
  if (!existsSync(CALLS)) return [];
  return readdirSync(CALLS)
    .filter((id) => existsSync(metaPath(id)))
    .map(readMeta)
    .sort((a, b) => b.created - a.created);
}

export function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

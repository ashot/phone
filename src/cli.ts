#!/usr/bin/env bun
// phone: place and control real phone calls run by an AI voice agent.
import { spawn } from "child_process";
import { openSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import guide from "../GUIDE.md" with { type: "text" };
import { loadConfig, readConfigFile, saveConfig, requireConfig, normalizeNumber, PhoneError, DEFAULTS, CONFIG_PATH, type Config } from "./config";
import { elevenlabs, twilio, agentSpec, creditStatus, AGENT_NAME } from "./providers";
import { callDir, createCall, isAlive, listCalls, newCallId, readCursor, readEvents, readMeta, writeCursor, type Meta, type PhoneEvent } from "./store";
import { renderEvent, renderResult } from "./render";
import { human, clock } from "./text";
import { buildRecord, recordingPath, type CallRecord } from "./timeline";
import { backfill } from "./artifacts";
import { writePages } from "./page";
import { runDaemon } from "./daemon";

const HELP = `phone: place real phone calls handled by an AI voice agent, and follow or steer them live.

QUICK START
  phone call 718-555-1234 --goal - <<'EOF'
  <a complete brief: who you act for, the goal, every fact the agent may need, limits, what "done" means>
  EOF
  phone wait        # run again until it prints CALL ENDED; answer QUESTIONs as they appear

COMMANDS                                         ([id] defaults to the latest call)
  call <number> --goal <text|->  Dial and hand the call to the voice agent. Streams the live transcript
                                 for up to --timeout seconds (default 100), then returns; the call goes on.
  wait [id]                      Print what happened since your last look. Returns when the call ends, when
                                 the agent asks you a QUESTION, or after --timeout seconds (default 100).
  answer [id] "<text>"           Answer the agent's pending QUESTION. It stalls politely until you do.
  steer [id] "<text>"            Give the agent a new instruction mid-call. Silent: never read aloud.
  say [id] "<text>"              Have the agent say something to them on its next turn.
  keys [id] <digits>             Press touch-tone keys yourself (0-9 * #, w = half-second pause).
  hangup [id] [--now]            Agent says goodbye and hangs up (forced after 20s); --now cuts the line.
  transcript [id] [--json]       The whole call: RESULT (outcome, goal achieved, summary), then every line with
                                 times on the recording's clock, your questions/steers inline, recording path.
  ls                             Call history: date, number, status and length, goal achieved, brief.
  status [id]                    One call's state and its latest lines.
  rm <id> [<id> ...]             Delete calls from the local history.
  view [id] [--no-open]          For humans: open the call log, or one call, as a page with the summary, the
                                 recording, and a transcript you can click to jump through the audio.
  listen <our-number> --goal ... Answer the next incoming call to one of our numbers with the voice agent.
  numbers                        Our phone numbers (for --from and listen).
  guide                          How to write a brief that gets results. Read it before your first call.
  setup | doctor                 Configure credentials and the voice agent | check that everything works.

CALL OPTIONS
  --goal <text> | --goal - | --goal-file <path>   The brief (required). Long and specific beats short.
  --first-message <text>  Line to open with as they pick up (default: let them speak first, then respond;
                          for listen the default greeting is "Hello?").
  --from <number>         Caller ID; must be one of \`phone numbers\` (default from config).
  --voice <name|id>       ElevenLabs voice (default Eric).     --llm <model>  Agent LLM (default ${DEFAULTS.llm}).
  --max-minutes <n>       Hard cap once connected (default 20); the agent is told to wrap up a minute before.
  --ask-timeout <sec>     How long the agent keeps the other party waiting on a QUESTION before it carries on
                          without your answer (default 90). A later answer still reaches it.
  --no-record             Don't record. Calls are recorded by default so \`phone view\` can play them back.
  --detach                Return as soon as it is dialing.       --json  JSONL events instead of text.

RUNNING A CALL WELL
  - Put everything in the brief. Missing facts become QUESTIONs mid-call, or dead ends if you are slow.
  - Loop \`phone wait\` until CALL ENDED. Each run fits in one tool call (~100s).
  - A QUESTION means a real person is waiting: answer fast and concretely with \`phone answer\`.
  - Steer only to correct course or add facts; phrase it as an instruction ("Accept up to $40").
  - Read the RESULT at the end, and check the transcript before telling anyone the goal was met.
  Exit codes for call/wait: 0 call over · 2 still in progress · 3 a QUESTION is waiting for you ·
  1 did not connect (busy, no answer, bad number) or error.`;

const BOOL_FLAGS = new Set(["json", "detach", "now", "no-record", "all", "help", "no-open"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = v;
      else if (BOOL_FLAGS.has(k)) flags[k] = true;
      else {
        if (argv[i + 1] === undefined) throw new PhoneError(`--${k} needs a value.`);
        flags[k] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (s: string) => console.log(s);

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

function isCallId(s?: string) {
  return !!s && /^[a-z]{4}$/.test(s) && existsSync(join(callDir(s), "meta.json"));
}

// The latest live call wins over the latest finished one.
function latestCall(): Meta {
  const calls = listCalls();
  if (!calls.length) throw new PhoneError("There are no calls yet.", "Start one with `phone call <number> --goal ...`.");
  return calls.find((c) => isAlive(c.pid) && !["ended", "failed"].includes(c.state)) ?? calls[0];
}

// Commands take an optional id followed by one argument: "[id] <text>".
function idAndArg(pos: string[], what: string): [Meta, string] {
  const [first, ...rest] = pos;
  if (isCallId(first) && rest.length) return [readMeta(first), rest.join(" ")];
  if (!pos.length) throw new PhoneError(`Missing ${what}.`);
  return [latestCall(), pos.join(" ")];
}

function resolveCall(pos: string[]): Meta {
  if (!pos[0] || pos[0] === "last") return latestCall();
  if (isCallId(pos[0])) return readMeta(pos[0]);
  throw new PhoneError(`No call with id "${pos[0]}".`, "`phone ls` lists calls.");
}

async function control(meta: Meta, action: string, body: Record<string, any> = {}) {
  if (!meta.control || !isAlive(meta.pid) || !existsSync(meta.control)) {
    throw new PhoneError(`Call ${meta.id} is not live (it is ${meta.state}${meta.ended_reason ? `: ${meta.ended_reason}` : ""}).`, `\`phone transcript ${meta.id}\` shows what happened.`);
  }
  const res = await fetch(`http://phone/${action}`, { unix: meta.control, method: "POST", body: JSON.stringify(body) } as any);
  const data: any = await res.json();
  if (!data.ok) throw new PhoneError(data.message);
  out(`${data.message}\nFollow the effect with: phone wait ${meta.id}`);
}

// ---- waiting ---------------------------------------------------------------
type WaitEnd = "ended" | "failed" | "question" | "timeout" | "dead";

async function follow(id: string, flags: Record<string, any>): Promise<never> {
  const timeout = Number(flags.timeout ?? 100);
  const deadline = Date.now() + timeout * 1000;
  let cursor = flags.all ? 0 : readCursor(id);
  let end: WaitEnd | undefined;
  while (!end) {
    const meta = readMeta(id);
    const all = readEvents(id);
    const answered = new Set(all.filter((e) => e.type === "answer").map((e) => e.qid));
    for (const e of all.filter((e) => e.seq > cursor)) {
      out(flags.json ? JSON.stringify(e) : renderEvent(e, meta));
      cursor = e.seq;
      if (e.type === "result") end = "ended";
      else if (e.type === "question" && !answered.has(e.qid)) end ??= "question";
    }
    writeCursor(id, cursor);
    if (!end && !isAlive(meta.pid) && meta.pid) end = all.some((e) => e.type === "result") ? "ended" : "dead";
    if (end === "ended" && !meta.answered_at) end = "failed";
    if (!end && Date.now() > deadline) end = "timeout";
    if (!end) await Bun.sleep(300);
  }
  const meta = readMeta(id);
  const all = readEvents(id);
  const answered = new Set(all.filter((e) => e.type === "answer").map((e) => e.qid));
  const pending = all.filter((e) => e.type === "question" && !answered.has(e.qid) && !all.some((t) => t.type === "question_timeout" && t.qid === e.qid));
  const elapsed = human((Date.now() - (meta.answered_at ?? meta.created)) / 1000);
  const footer: Record<WaitEnd, string> = {
    ended: `-- Call ${id} is over. Full record: phone transcript ${id}`,
    failed: `-- Call ${id} did not connect: ${meta.ended_reason}. Nothing was said. Fix the cause above if there is one, then place the call again.`,
    question: `-- The voice agent is waiting on your answer to ${pending.at(-1)?.qid ?? "its question"}: phone answer ${id} "<answer>"\n-- Then continue with: phone wait ${id}`,
    timeout: meta.state === "ending" ? `-- Call ${id} is over; its summary is still being written (usually under a minute). Continue: phone wait ${id}` :
      `-- Call ${id} is still ${describeState(meta)} (${elapsed}${meta.answered_at ? " since pickup" : ""}). Continue: phone wait ${id}` +
      (pending.length ? `\n-- Unanswered question ${pending.map((q) => q.qid).join(", ")}: phone answer ${id} "<answer>"` : "") +
      `\n-- Optional: phone steer ${id} "<instruction>"  |  phone hangup ${id}`,
    dead: `-- The daemon for call ${id} stopped without finishing (state ${meta.state}). Its log: ${join(callDir(id), "daemon.log")}`,
  };
  if (flags.json) out(JSON.stringify({ type: "wait_end", id, end, state: meta.state, next: footer[end] }));
  else out(footer[end]);
  process.exit({ ended: 0, timeout: 2, question: 3, failed: 1, dead: 1 }[end]);
}

function describeState(meta: Meta) {
  return { starting: "starting up", dialing: "dialing", ringing: "ringing", listening: "waiting for an incoming call", "in-progress": "in progress", ending: "wrapping up", ended: "over", failed: "failed" }[meta.state];
}

// ---- starting calls --------------------------------------------------------
async function readGoal(flags: Record<string, any>): Promise<string> {
  let goal = "";
  if (flags["goal-file"]) goal = readFileSync(flags["goal-file"], "utf8");
  else if (flags.goal === "-" || (flags.goal === undefined && !process.stdin.isTTY)) goal = await readStdin();
  else goal = flags.goal ?? "";
  goal = goal.trim();
  if (!goal) {
    throw new PhoneError(
      "The call needs a brief: --goal \"...\", --goal - (read stdin), or --goal-file <path>.",
      "The brief is everything the voice agent knows. Run `phone guide` for what to put in it.",
    );
  }
  return goal;
}

async function resolveVoice(cfg: Config, voice?: string) {
  if (!voice) return undefined;
  if (/^[A-Za-z0-9]{20}$/.test(voice)) return voice;
  const voices = await elevenlabs(cfg).voices();
  const match = voices.find((v) => v.name.toLowerCase().startsWith(voice.toLowerCase()));
  if (!match) throw new PhoneError(`No voice named "${voice}".`, `Available: ${voices.map((v) => v.name.split(" - ")[0]).join(", ")}`);
  return match.voice_id;
}

async function startCall(mode: "outbound" | "inbound", pos: string[], flags: Record<string, any>) {
  const cfg = loadConfig();
  requireConfig(cfg, ["elevenlabs_api_key", "twilio_account_sid", "twilio_auth_token", "agent_id", ...(mode === "outbound" ? (["from"] as const) : [])]);
  if (!pos[0]) throw new PhoneError(mode === "outbound" ? "Which number should I call? `phone call <number> --goal ...`" : "Which of our numbers should answer? `phone listen <number> --goal ...` (see `phone numbers`).");
  const number = normalizeNumber(pos[0]);
  const goal = await readGoal(flags);
  await creditStatus(cfg);
  const meta: Meta = {
    id: newCallId(),
    mode,
    number,
    from: mode === "outbound" ? normalizeNumber(flags.from ?? cfg.from!) : number,
    goal,
    created: Date.now(),
    state: "starting",
    options: {
      first_message: flags["first-message"],
      voice_id: await resolveVoice(cfg, flags.voice),
      llm: flags.llm,
      language: flags.language,
      record: !flags["no-record"],
      max_minutes: Number(flags["max-minutes"] ?? 20),
      ask_timeout: Number(flags["ask-timeout"] ?? 90),
      listen_minutes: Number(flags.for ?? 15),
    },
  };
  createCall(meta);
  const log = openSync(join(callDir(meta.id), "daemon.log"), "a");
  spawn(process.execPath, [import.meta.path, "_daemon", meta.id], { detached: true, stdio: ["ignore", log, log] }).unref();

  const header = mode === "outbound" ? `Calling ${number} from ${meta.from}.` : `Answering the next call to ${number}.`;
  out(`${header} Call id: ${meta.id}`);
  if (goal.length < 300) out(`Note: the brief is short (${goal.length} chars). Facts it lacks will come back to you as QUESTIONs mid-call; see \`phone guide\`.`);
  if (flags.detach) {
    for (let i = 0; i < 120 && readMeta(meta.id).state === "starting"; i++) await Bun.sleep(500);
    const now = readMeta(meta.id);
    out(now.state === "failed" ? readEvents(meta.id).map((e) => renderEvent(e, now)).join("\n") : `Call ${meta.id} is ${describeState(now)}. Follow it with: phone wait ${meta.id}`);
    process.exit(now.state === "failed" ? 1 : 0);
  }
  await follow(meta.id, flags);
}

// ---- reading calls ---------------------------------------------------------
function describeCall(r: CallRecord) {
  const when = new Date(r.created).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const route = r.mode === "outbound" ? `${r.from} -> ${r.number}` : `incoming to ${r.number}`;
  return `Call ${r.id} · ${route} · ${when} · ${r.status}${!r.connected && r.ended_reason ? ` (${r.ended_reason})` : ""}`;
}

// Human view: the call log (no id) or one call, as a local page with audio and a clickable timeline.
async function view(pos: string[], flags: Record<string, any>) {
  const focus = pos[0] ? resolveCall(pos) : undefined;
  const cfg = loadConfig();
  const calls = listCalls();
  await Promise.all(calls.map((m) => backfill(cfg, m).catch(() => {})));
  const path = await writePages(calls.map(buildRecord), focus?.id);
  if (!flags["no-open"]) Bun.spawn(["open", path]);
  out(`${focus ? `Call ${focus.id}` : `Call log (${calls.length} calls)`}: ${path}${flags["no-open"] ? "" : " (opened in your browser)"}`);
  out(`Text version for agents: ${focus ? `phone transcript ${focus.id}` : "phone ls"}`);
}

async function transcript(meta: Meta, flags: Record<string, any>) {
  await backfill(loadConfig(), meta).catch(() => {});
  const r = buildRecord(meta);
  if (flags.json) return out(JSON.stringify(r, null, 2));
  out(describeCall(r));
  out(`Brief: ${r.goal.split("\n")[0].slice(0, 200)}${r.goal.length > 200 ? "..." : ""}`);
  if (r.result && (r.result.outcome || r.result.summary)) out(renderResult({ ...r.result, recording: undefined }));
  if (r.lines.length) {
    out("\nTRANSCRIPT");
    const stamp = (at: number | null) => (at === null ? "[--:--]" : `[${clock(at)}]`);
    const entries = [
      ...r.lines.map((l, i) => ({ at: l.at, order: i, text: `${stamp(l.at)} ${l.who === "them" ? "THEM: " : "AGENT:"} ${l.text}${l.interrupted ? "  (cut off)" : ""}` })),
      ...r.notes.map((n, i) => ({ at: n.at, order: 1000 + i, text: `${stamp(n.at)}   ${NOTE_LABELS[n.kind] ?? n.kind}${n.qid ? ` ${n.qid}` : ""}: ${n.text}` })),
    ].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.order - b.order);
    entries.forEach((e) => out(e.text));
  }
  if (r.connected && r.duration !== undefined) out(`[${clock(r.duration)}] · call ended: ${r.ended_reason}`);
  out("");
  if (r.recording) out(`Recording: ${recordingPath(r.id)}`);
  out(["ended", "failed"].includes(r.state) ? `Page with audio and timeline: phone view ${r.id}` : `-- Call is ${describeState(meta)}. Follow it with: phone wait ${r.id}`);
}

const NOTE_LABELS: Record<string, string> = {
  question: "QUESTION",
  question_timeout: "no reply",
  answer: "YOU answered",
  steer: "YOU steered",
  say: "YOU had it say",
  keys: "keys",
  hangup: "YOU hung up",
  error: "ERROR",
};

function status(meta: Meta) {
  const events = readEvents(meta.id);
  const alive = isAlive(meta.pid);
  out(`Call ${meta.id}: ${describeState(meta)}${meta.ended_reason ? ` (${meta.ended_reason})` : ""}${!alive && !["ended", "failed"].includes(meta.state) ? " [daemon not running]" : ""}`);
  out(`${meta.mode === "outbound" ? `${meta.from} -> ${meta.number}` : `incoming to ${meta.number}`} · started ${new Date(meta.created).toLocaleTimeString()}`);
  const recent = events.filter((e) => ["them", "agent", "question", "answer", "steer", "error", "ended", "result"].includes(e.type)).slice(-6);
  if (recent.length) out("\n" + recent.map((e) => renderEvent(e, meta)).join("\n"));
  out(alive ? `\n-- Follow: phone wait ${meta.id}` : `\n-- Full record: phone transcript ${meta.id}`);
}

function list() {
  const calls = listCalls().slice(0, 30);
  if (!calls.length) return out("No calls yet. Start one with `phone call <number> --goal ...`.");
  for (const r of calls.map(buildRecord)) {
    const when = new Date(r.created).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const who = r.mode === "outbound" ? `-> ${r.number}` : `<- ${r.number}`;
    const verdict = r.result?.goal_achieved && r.result.goal_achieved !== "unknown" ? r.result.goal_achieved : "";
    out(`${r.id}  ${when.padEnd(17)} ${who.padEnd(16)} ${r.status.padEnd(14)} ${verdict.padEnd(8)} ${r.goal.split("\n")[0].slice(0, 56)}`);
  }
  out(`\nDetails: phone transcript <id>  |  history page: phone view`);
}

// Deletes calls from the local history (transcript, recording, events). Live calls are refused.
function remove(ids: string[]) {
  if (!ids.length) throw new PhoneError("Which calls? `phone rm <id> [<id> ...]` (see `phone ls`).");
  for (const id of ids) {
    const meta = resolveCall([id]);
    if (isAlive(meta.pid) && !["ended", "failed"].includes(meta.state)) throw new PhoneError(`Call ${id} is live. End it first with \`phone hangup ${id}\`.`);
  }
  for (const id of ids) rmSync(callDir(id), { recursive: true, force: true });
  out(`Deleted ${ids.length} call${ids.length === 1 ? "" : "s"} from the local history: ${ids.join(", ")}. Run \`phone view\` to refresh an open log page.`);
}

// ---- setup -----------------------------------------------------------------
async function setup(flags: Record<string, any>) {
  const cfg: Config = { ...loadConfig() };
  const map: Record<string, keyof Config> = { "elevenlabs-key": "elevenlabs_api_key", "twilio-sid": "twilio_account_sid", "twilio-token": "twilio_auth_token", from: "from", voice: "voice_id", llm: "llm" };
  for (const [flag, key] of Object.entries(map)) if (flags[flag]) (cfg as any)[key] = flags[flag];
  requireConfig(cfg, ["elevenlabs_api_key", "twilio_account_sid", "twilio_auth_token"]);
  if (cfg.from) cfg.from = normalizeNumber(cfg.from);
  if (flags.voice) cfg.voice_id = await resolveVoice(cfg, flags.voice);

  const el = elevenlabs(cfg);
  const sub = await el.subscription();
  out(`ElevenLabs ok (${sub.tier} plan)`);
  const tw = twilio(cfg);
  const account = await tw.account();
  out(`Twilio ok (${account.friendly_name})`);
  if (cfg.from && !(await tw.findNumber(cfg.from))) throw new PhoneError(`${cfg.from} is not a number in this Twilio account.`, "Pick one from `phone numbers` and pass --from.");

  const spec = agentSpec(cfg);
  const existing = cfg.agent_id ? await el.getAgent(cfg.agent_id).catch(() => null) : null;
  if (existing) {
    await el.updateAgent(cfg.agent_id!, spec);
    out(`Voice agent ${AGENT_NAME} updated (${cfg.agent_id})`);
  } else {
    cfg.agent_id = (await el.createAgent(spec)).agent_id;
    out(`Voice agent ${AGENT_NAME} created (${cfg.agent_id})`);
  }
  saveConfig({ ...readConfigFile(), ...cfg });
  out(`Saved ${CONFIG_PATH}${cfg.from ? `; calls go out from ${cfg.from}` : "; set a caller id with `phone setup --from <number>`"}.`);
}

async function doctor() {
  const cfg = loadConfig();
  let bad = 0;
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      out(`ok    ${label}: ${await fn()}`);
    } catch (e: any) {
      bad++;
      out(`FAIL  ${label}: ${e.message}${e.hint ? `\n      ${e.hint}` : ""}`);
    }
  };
  await check("config", async () => (existsSync(CONFIG_PATH) ? CONFIG_PATH : (() => { throw new PhoneError("no config file", "Run `phone setup`."); })()));
  await check("cloudflared", async () => {
    const p = Bun.spawnSync(["cloudflared", "--version"]);
    if (!p.success) throw new PhoneError("not installed", "brew install cloudflared");
    return String(p.stdout).trim().split("\n")[0];
  });
  await check("ElevenLabs", async () => {
    requireConfig(cfg, ["elevenlabs_api_key"]);
    return creditStatus(cfg);
  });
  await check("voice agent", async () => {
    requireConfig(cfg, ["elevenlabs_api_key", "agent_id"]);
    const a = await elevenlabs(cfg).getAgent(cfg.agent_id!);
    if (a.conversation_config?.asr?.user_input_audio_format !== "ulaw_8000") throw new PhoneError("agent is not configured for phone audio", "Run `phone setup` to repair it.");
    return `${a.name} (${cfg.agent_id}), llm ${a.conversation_config.agent.prompt.llm}`;
  });
  await check("Twilio", async () => {
    requireConfig(cfg, ["twilio_account_sid", "twilio_auth_token"]);
    const a = await twilio(cfg).account();
    return `${a.friendly_name} (${a.status})`;
  });
  await check("caller id", async () => {
    requireConfig(cfg, ["from", "twilio_account_sid", "twilio_auth_token"]);
    const n = await twilio(cfg).findNumber(cfg.from!);
    if (!n) throw new PhoneError(`${cfg.from} is not in the Twilio account`, "`phone numbers`, then `phone setup --from <number>`.");
    return `${cfg.from} (${n.friendly_name})`;
  });
  out(bad ? `\n${bad} problem(s). Fix them, then run \`phone doctor\` again.` : "\nReady to call.");
  process.exit(bad ? 1 : 0);
}

async function numbers() {
  const cfg = requireConfig(loadConfig(), ["twilio_account_sid", "twilio_auth_token"]);
  for (const n of await twilio(cfg).numbers()) out(`${n.phone_number}  ${n.friendly_name}${n.phone_number === cfg.from ? "  (default caller id)" : ""}`);
}

// ---- main ------------------------------------------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return out(HELP);
  if (flags.help) return out(HELP);
  switch (cmd) {
    case "_daemon":
      return runDaemon(pos[0]);
    case "call":
      return startCall("outbound", pos, flags);
    case "listen":
      return startCall("inbound", pos, flags);
    case "wait":
    case "watch":
      return follow(resolveCall(pos).id, flags);
    case "answer": {
      const [meta, text] = idAndArg(pos, 'the answer text: phone answer [id] "<answer>"');
      return control(meta, "answer", { text, qid: flags.q });
    }
    case "steer": {
      const [meta, text] = idAndArg(pos, 'the instruction: phone steer [id] "<instruction>"');
      return control(meta, "steer", { text });
    }
    case "say": {
      const [meta, text] = idAndArg(pos, 'what to say: phone say [id] "<text>"');
      return control(meta, "say", { text });
    }
    case "keys": {
      const [meta, digits] = idAndArg(pos, "the keys to press: phone keys [id] <digits>");
      return control(meta, "keys", { digits: digits.replace(/\s/g, "") });
    }
    case "hangup":
      return control(resolveCall(pos), "hangup", { now: !!flags.now });
    case "transcript":
      return await transcript(resolveCall(pos), flags);
    case "status":
      return status(resolveCall(pos));
    case "view":
      return await view(pos, flags);
    case "rm":
      return remove(pos);
    case "ls":
      return list();
    case "numbers":
      return numbers();
    case "guide":
      return out(guide);
    case "setup":
      return setup(flags);
    case "doctor":
      return doctor();
    default:
      throw new PhoneError(`Unknown command "${cmd}".`, "Run `phone` for the list of commands.");
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  if (e.hint) console.error(`hint: ${e.hint}`);
  if (!(e instanceof PhoneError)) console.error(e.stack);
  process.exit(1);
});

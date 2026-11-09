// One daemon process owns one call: it runs the public tunnel, bridges Twilio media to the
// ElevenLabs voice agent, records every event, and takes commands on a local unix socket.
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { appendFileSync, existsSync, unlinkSync } from "fs";
import { loadConfig, PhoneError, DEFAULTS } from "./config";
import { elevenlabs, twilio } from "./providers";
import { callDir, eventWriter, readEvents, readMeta, updateMeta, type Meta } from "./store";
import { dtmfAudio, VALID_KEYS } from "./audio";
import { voicePrompt } from "./prompt";
import { missedLines, spoken, REQUESTER_PREFIX } from "./text";
import { fetchConversation, fetchRecording } from "./artifacts";

const TWILIO_TERMINAL: Record<string, string> = {
  busy: "the line was busy",
  "no-answer": "nobody answered",
  failed: "the call could not be connected (invalid, blocked, or unreachable number)",
  canceled: "the call was canceled before it connected",
  completed: "the call ended",
};

type Question = { qid: string; text: string; toolCallId?: string; timer?: Timer; answered?: boolean };

export async function runDaemon(id: string) {
  const cfg = loadConfig();
  let meta: Meta = readMeta(id);
  const opts = meta.options;
  const emit = eventWriter(id);
  const el = elevenlabs(cfg);
  const tw = twilio(cfg);
  const token = crypto.randomUUID().replaceAll("-", "");
  const sockPath = join(callDir(id), "control.sock");
  const log = (...args: any[]) => appendFileSync(join(callDir(id), "daemon.log"), `${new Date().toISOString()} ${args.join(" ")}\n`);
  const setMeta = (patch: Partial<Meta>) => (meta = updateMeta(id, patch));

  let tunnel: ChildProcess | undefined;
  let host = "";
  let twilioWs: any;
  let streamSid = "";
  let elWs: WebSocket | undefined;
  let elReady = false;
  let agentEnding = false;
  let ended = false;
  let endReason = "";
  const buffered: string[] = [];
  const questions: Question[] = [];
  const timers: Timer[] = [];

  const toTwilio = (msg: any) => twilioWs?.readyState === 1 && twilioWs.send(JSON.stringify(msg));
  const toAgent = (msg: any) => elWs?.readyState === WebSocket.OPEN && elWs.send(JSON.stringify(msg));
  // steer: silent context the agent applies on its next turn. prompt: makes the agent take a turn now.
  const steerAgent = (text: string) => toAgent({ type: "contextual_update", text: `Update from the person you're calling for: ${text}` });
  const promptAgent = (text: string) => toAgent({ type: "user_message", text: `${REQUESTER_PREFIX} ${text}` });

  const twiml = (params: Record<string, string> = {}) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/media/${token}">${Object.entries(params)
      .map(([k, v]) => `<Parameter name="${k}" value="${v}"/>`)
      .join("")}</Stream></Connect></Response>`;

  function sendKeys(digits: string, by: "agent" | "you") {
    const audio = dtmfAudio(digits);
    toTwilio({ event: "clear", streamSid });
    for (let i = 0; i < audio.length; i += 160) {
      toTwilio({ event: "media", streamSid, media: { payload: audio.subarray(i, i + 160).toString("base64") } });
    }
    emit("keys", { digits, by });
  }

  // ---- ending -------------------------------------------------------------
  async function hangupTwilio() {
    if (meta.twilio_sid) await tw.updateCall(meta.twilio_sid, { Status: "completed" }).catch((e) => log("hangup failed", e.message));
  }

  // Let the agent's last words play out before cutting the line.
  function drainThenHangup(reason: string) {
    endReason ||= reason;
    toTwilio({ event: "mark", streamSid, mark: { name: "final" } });
    timers.push(setTimeout(() => finish(reason), 15000));
  }

  async function finish(reason: string) {
    if (ended) return;
    ended = true;
    endReason ||= reason;
    const now = Date.now();
    const duration = meta.answered_at ? Math.round((now - meta.answered_at) / 1000) : 0;
    emit("ended", { reason: endReason, duration });
    setMeta({ state: "ending", ended_at: now, ended_reason: endReason });
    timers.forEach(clearTimeout);
    questions.forEach((q) => clearTimeout(q.timer));
    await hangupTwilio();
    try { elWs?.close(); } catch {}
    try { twilioWs?.close(); } catch {}
    tunnel?.kill();
    await restoreNumber();
    try { control.stop(true); } catch {}
    if (existsSync(sockPath)) unlinkSync(sockPath);
    await collectResult(duration);
    setMeta({ state: meta.answered_at ? "ended" : "failed" });
    log("done", endReason);
    process.exit(0);
  }

  async function collectResult(duration: number) {
    const result: Record<string, any> = { reason: endReason, duration };
    if (meta.twilio_sid) {
      const call = await tw.getCall(meta.twilio_sid).catch(() => null);
      if (call?.duration) result.billed_seconds = Number(call.duration);
      result.recording = await fetchRecording(cfg, meta, 20);
    }
    if (meta.conversation_id) {
      emit("status", { status: "analyzing", detail: "waiting for the call summary" });
      const convo = await fetchConversation(cfg, meta, 40);
      if (convo) {
        for (const line of missedLines(readEvents(id), convo.transcript ?? [])) emit(line.type, { text: line.text, late: true });
        const a = convo.analysis ?? {};
        const goal = a.evaluation_criteria_results?.goal_achieved;
        result.goal_achieved = goal?.result ?? a.call_successful ?? "unknown";
        result.rationale = goal?.rationale;
        result.outcome = a.data_collection_results?.outcome?.value;
        result.summary = a.transcript_summary;
        result.conversation_id = meta.conversation_id;
      }
    }
    emit("result", result);
  }

  // ---- inbound number wiring ----------------------------------------------
  async function restoreNumber() {
    const r = opts.restore;
    if (!r) return;
    await tw.updateNumber(r.sid, { VoiceUrl: r.voice_url ?? "", VoiceMethod: r.voice_method ?? "POST" }).catch((e) => log("restore failed", e.message));
    opts.restore = undefined;
    setMeta({ options: opts });
  }

  // ---- ElevenLabs side ----------------------------------------------------
  async function connectAgent() {
    const url = await el.signedUrl(cfg.agent_id!);
    elWs = new WebSocket(url);
    elWs.onopen = () => {
      toAgent({
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          agent: {
            prompt: { prompt: voicePrompt(meta.goal, meta.mode), ...(opts.llm ? { llm: opts.llm } : {}) },
            first_message: opts.first_message ?? (meta.mode === "inbound" ? "Hello?" : ""),
            language: opts.language ?? "en",
          },
          tts: { voice_id: opts.voice_id ?? cfg.voice_id ?? DEFAULTS.voice_id },
        },
      });
    };
    elWs.onmessage = (m) => onAgent(JSON.parse(String(m.data)));
    elWs.onerror = (e: any) => log("elevenlabs ws error", e?.message);
    elWs.onclose = (e) => {
      log("elevenlabs closed", e.code, e.reason);
      if (ended) return;
      if (agentEnding || e.code === 1000) drainThenHangup("the voice agent ended the call");
      else {
        emit("error", { message: `Voice agent connection closed unexpectedly (${e.code} ${e.reason})` });
        finish("voice agent disconnected");
      }
    };
  }

  function onAgent(msg: any) {
    switch (msg.type) {
      case "conversation_initiation_metadata": {
        setMeta({ conversation_id: msg.conversation_initiation_metadata_event.conversation_id });
        elReady = true;
        buffered.splice(0).forEach((chunk) => toAgent({ user_audio_chunk: chunk }));
        break;
      }
      case "audio":
        toTwilio({ event: "media", streamSid, media: { payload: msg.audio_event.audio_base_64 } });
        break;
      case "interruption":
        toTwilio({ event: "clear", streamSid });
        break;
      case "ping":
        toAgent({ type: "pong", event_id: msg.ping_event.event_id });
        break;
      case "user_transcript": {
        const text = msg.user_transcription_event.user_transcript?.trim();
        if (text && /\w/.test(text)) emit("them", { text });
        break;
      }
      case "agent_response": {
        const text = spoken(msg.agent_response_event.agent_response);
        if (text) emit("agent", { text });
        break;
      }
      case "agent_response_correction":
        emit("agent_cut", { text: spoken(msg.agent_response_correction_event.corrected_agent_response) });
        break;
      case "client_tool_call":
        onToolCall(msg.client_tool_call);
        break;
      case "agent_tool_response": {
        const name = msg.agent_tool_response?.tool_name;
        if (name === "end_call") agentEnding = true;
        if (name && !["ask_requester", "press_keys"].includes(name)) emit("tool", { name });
        break;
      }
      default:
        if (!["vad_score", "internal_tentative_agent_response", "agent_chat_response_part"].includes(msg.type)) log("agent event", msg.type);
    }
  }

  function toolResult(toolCallId: string, result: string, isError = false) {
    toAgent({ type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError });
  }

  function onToolCall(call: any) {
    const { tool_name, tool_call_id, parameters } = call;
    if (tool_name === "ask_requester") {
      const q: Question = { qid: `q${questions.length + 1}`, text: parameters?.question ?? "", toolCallId: tool_call_id };
      questions.push(q);
      emit("question", { qid: q.qid, text: q.text, timeout: opts.ask_timeout });
      q.timer = setTimeout(() => {
        if (q.answered) return;
        toolResult(q.toolCallId!, "No reply yet. Keep the other person comfortable and carry on with what you can; a late answer will arrive as an update. If they cannot wait, use your best judgement within the brief or offer to call back.");
        q.toolCallId = undefined;
        emit("question_timeout", { qid: q.qid });
      }, opts.ask_timeout * 1000);
      return;
    }
    if (tool_name === "press_keys") {
      const digits = String(parameters?.digits ?? "");
      if (!VALID_KEYS.test(digits)) return toolResult(tool_call_id, `Invalid keys "${digits}". Use 0-9, *, #, and w for a pause.`, true);
      sendKeys(digits, "agent");
      return toolResult(tool_call_id, `Pressed ${digits}.`);
    }
    toolResult(tool_call_id, `Unknown tool ${tool_name}`, true);
  }

  // ---- Twilio side --------------------------------------------------------
  function onTwilio(ws: any, msg: any) {
    switch (msg.event) {
      case "start": {
        twilioWs = ws;
        streamSid = msg.start.streamSid;
        const params = msg.start.customParameters ?? {};
        setMeta({ twilio_sid: msg.start.callSid, state: "in-progress", answered_at: meta.answered_at ?? Date.now() });
        emit("status", { status: "connected", detail: meta.mode === "inbound" ? `call from ${params.from ?? "unknown"}` : "they picked up" });
        const cap = opts.max_minutes * 60000;
        timers.push(setTimeout(() => live() && steerAgent("Time is almost up. Wrap up within the next minute, then end the call."), Math.max(cap - 60000, 0)));
        timers.push(setTimeout(() => finish(`reached the ${opts.max_minutes} minute limit`), cap));
        connectAgent().catch((e) => {
          emit("error", { message: `Could not start the voice agent: ${e.message}`, hint: e.hint });
          finish("voice agent failed to start");
        });
        break;
      }
      case "media":
        if (msg.media.track && msg.media.track !== "inbound") break;
        if (elReady) toAgent({ user_audio_chunk: msg.media.payload });
        else if (buffered.length < 500) buffered.push(msg.media.payload);
        break;
      case "mark":
        if (msg.mark?.name === "final") finish(endReason || "the voice agent ended the call");
        break;
      case "stop":
        finish(agentEnding ? "the voice agent ended the call" : "the other party hung up");
        break;
    }
  }

  async function pollTwilio() {
    let last = "";
    while (!ended) {
      if (meta.twilio_sid) {
        const call = await tw.getCall(meta.twilio_sid).catch(() => null);
        const status = call?.status;
        if (status && status !== last) {
          last = status;
          log("twilio status", status);
          if (status === "ringing") {
            setMeta({ state: "ringing" });
            emit("status", { status: "ringing" });
          }
          if (TWILIO_TERMINAL[status]) {
            if (status !== "completed" || !meta.answered_at) emit("status", { status, detail: TWILIO_TERMINAL[status] });
            return finish(meta.answered_at ? "the other party hung up" : TWILIO_TERMINAL[status]);
          }
        }
      }
      await Bun.sleep(2000);
    }
  }

  // ---- tunnel -------------------------------------------------------------
  async function startTunnel(port: number): Promise<string> {
    // --config /dev/null: a global ~/.cloudflared/config.yml ingress would otherwise override --url.
    tunnel = spawn("cloudflared", ["tunnel", "--config", "/dev/null", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PhoneError("cloudflared did not produce a tunnel URL within 40s.", "Check internet access; run `phone doctor`.")), 40000);
      const onData = (d: Buffer) => {
        const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      tunnel!.stdout!.on("data", onData);
      tunnel!.stderr!.on("data", onData);
      tunnel!.on("error", (e) => reject(new PhoneError(`Could not start cloudflared: ${e.message}`, "Install it with `brew install cloudflared`.")));
      tunnel!.on("exit", (code) => !ended && reject(new PhoneError(`cloudflared exited (${code}) before the tunnel was ready.`)));
    });
    // Quick tunnels take a few seconds to route, and Twilio must reach it on the first try. Probe
    // through Cloudflare's edge by IP and never look the new hostname up: any resolver asked before
    // the record exists (ours, 1.1.1.1, 8.8.8.8, possibly Twilio's) caches NXDOMAIN for minutes.
    // The record exists by the time the route answers.
    const hostname = new URL(url).hostname;
    const [edge] = await Bun.dns.lookup("api.trycloudflare.com", { family: 4 });
    for (let i = 0; i < 90; i++) {
      // Async on purpose: this process serves /health, so a blocking probe would deadlock.
      const probe = Bun.spawn(["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", `${hostname}:443:${edge.address}`, `${url}/health`]);
      if ((await new Response(probe.stdout).text()) === "200") {
        log("tunnel ready", url);
        return url;
      }
      await Bun.sleep(500);
    }
    throw new PhoneError("The cloudflared tunnel never became reachable (45s+).", "Retry the call; if it keeps failing, check `cloudflared` and your network.");
  }

  // ---- control socket -----------------------------------------------------
  const reply = (ok: boolean, message: string) => Response.json({ ok, message }, { status: ok ? 200 : 409 });

  async function handleControl(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname.slice(1);
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    switch (action) {
      case "steer":
        if (!live()) return reply(false, notLive());
        steerAgent(body.text);
        emit("steer", { text: body.text });
        return reply(true, "Instruction delivered; the agent will apply it from its next turn.");
      case "say":
        if (!live()) return reply(false, notLive());
        promptAgent(`Say this to them now, naturally, in your own words: ${body.text}`);
        emit("say", { text: body.text });
        return reply(true, "The agent will say it on its next turn.");
      case "answer": {
        if (!live()) return reply(false, notLive());
        const q = body.qid ? questions.find((x) => x.qid === body.qid) : questions.find((x) => !x.answered);
        if (!q) return reply(false, questions.length ? "No unanswered question. Use `phone steer` to give new information." : "The agent has not asked anything. Use `phone steer` to give it information.");
        q.answered = true;
        clearTimeout(q.timer);
        if (q.toolCallId) toolResult(q.toolCallId, body.text);
        else promptAgent(`The answer to your earlier question ("${q.text}") is: ${body.text}. Act on it now.`);
        emit("answer", { qid: q.qid, text: body.text, late: !q.toolCallId });
        return reply(true, q.toolCallId ? `Answered ${q.qid}; the agent will act on it right away.` : `Answered ${q.qid} late (the agent had moved on); it will bring it up on its next turn.`);
      }
      case "keys":
        if (!live()) return reply(false, notLive());
        if (!VALID_KEYS.test(body.digits ?? "")) return reply(false, `Invalid keys "${body.digits}". Use 0-9, *, #, A-D, and w for a half-second pause.`);
        sendKeys(body.digits, "you");
        return reply(true, `Pressed ${body.digits}.`);
      case "hangup":
        if (ended) return reply(false, "The call already ended.");
        if (body.now || !live()) {
          emit("hangup", { now: true });
          finish("hung up by you");
          return reply(true, "Hanging up now.");
        }
        steerAgent("Wrap up now: say a brief, polite goodbye and end the call.");
        emit("hangup", { now: false });
        timers.push(setTimeout(() => finish("hung up by you"), 20000));
        return reply(true, "The agent is saying goodbye; the line is cut in 20s at the latest.");
      default:
        return reply(false, `Unknown control action ${action}`);
    }
  }

  const notLive = () =>
    ended ? "The call already ended." : "The voice agent is not on the line yet (still dialing or connecting). Try again once `phone wait` shows the call connected.";

  // ---- start --------------------------------------------------------------
  if (existsSync(sockPath)) unlinkSync(sockPath);
  const control = Bun.serve({ unix: sockPath, fetch: handleControl });
  const media = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return new Response("ok");
      if (path === `/twiml/${token}`) {
        const form = await req.formData().catch(() => null);
        return new Response(twiml({ from: String(form?.get("From") ?? "") }), { headers: { "content-type": "text/xml" } });
      }
      if (path === `/media/${token}` && server.upgrade(req)) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message: (ws, data) => onTwilio(ws, JSON.parse(String(data))),
      close: () => {
        if (!ended) finish(agentEnding ? "the voice agent ended the call" : "the other party hung up");
      },
    },
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => finish("the phone daemon was stopped"));

  try {
    setMeta({ pid: process.pid, control: sockPath });
    emit("status", { status: "starting", detail: "opening tunnel" });
    host = new URL(await startTunnel(media.port!)).host;

    if (meta.mode === "outbound") {
      const call = await tw.createCall({
        To: meta.number,
        From: meta.from,
        Twiml: twiml(),
        Timeout: "45",
        ...(opts.record ? { Record: "true" } : {}),
      });
      setMeta({ twilio_sid: call.sid, state: "dialing" });
      emit("status", { status: "dialing", detail: `${meta.from} -> ${meta.number}` });
    } else {
      const number = await tw.findNumber(meta.number);
      if (!number) throw new PhoneError(`${meta.number} is not a number in this Twilio account.`, "Pick one from `phone numbers`.");
      opts.restore = { sid: number.sid, voice_url: number.voice_url, voice_method: number.voice_method };
      setMeta({ options: opts, state: "listening" });
      await tw.updateNumber(number.sid, { VoiceUrl: `https://${host}/twiml/${token}`, VoiceMethod: "POST" });
      emit("status", { status: "listening", detail: `waiting for a call to ${meta.number}` });
      timers.push(setTimeout(() => !meta.answered_at && finish("no call arrived"), opts.listen_minutes * 60000));
    }

    pollTwilio();
  } catch (e: any) {
    emit("error", { message: e.message, hint: e.hint });
    await finish("could not place the call");
  }

  function live() {
    return elReady && !ended;
  }
}

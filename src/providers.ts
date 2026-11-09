// Thin REST clients for ElevenLabs and Twilio, and the voice agent definition.
import { PhoneError, DEFAULTS, type Config } from "./config";

async function request(url: string, init: RequestInit, service: string) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const detail = typeof body === "string" ? body : body?.message ?? body?.detail?.message ?? JSON.stringify(body?.detail ?? body);
    const hint =
      res.status === 401 || res.status === 403
        ? `The ${service} credentials were rejected. Update them with \`phone setup\`.`
        : undefined;
    throw new PhoneError(`${service} ${init.method ?? "GET"} ${new URL(url).pathname} failed (${res.status}): ${String(detail).slice(0, 500)}`, hint);
  }
  return body;
}

export function elevenlabs(cfg: Config) {
  const base = "https://api.elevenlabs.io";
  const headers = { "xi-api-key": cfg.elevenlabs_api_key!, "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) =>
    request(base + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }, "ElevenLabs");
  return {
    call,
    subscription: () => call("/v1/user/subscription"),
    getAgent: (id: string) => call(`/v1/convai/agents/${id}`),
    createAgent: (spec: any) => call("/v1/convai/agents/create", { method: "POST", body: JSON.stringify(spec) }),
    updateAgent: (id: string, spec: any) => call(`/v1/convai/agents/${id}`, { method: "PATCH", body: JSON.stringify(spec) }),
    signedUrl: async (agentId: string) => (await call(`/v1/convai/conversation/get-signed-url?agent_id=${agentId}`)).signed_url as string,
    conversation: (id: string) => call(`/v1/convai/conversations/${id}`),
    voices: async (search?: string) =>
      (await call(`/v2/voices?page_size=100${search ? `&search=${encodeURIComponent(search)}` : ""}`)).voices as any[],
  };
}

// ElevenLabs refuses conversations once the plan's credits are spent and overage billing is off:
// the call connects and the agent socket closes with 3000 "not available". Check before dialing.
export async function creditStatus(cfg: Config) {
  const s = await elevenlabs(cfg).subscription();
  const left = s.character_limit - s.character_count;
  const reset = s.next_character_count_reset_unix * 1000 > Date.now() ? new Date(s.next_character_count_reset_unix * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "the next billing cycle";
  if (left <= 0 && !s.allowed_to_extend_character_limit)
    throw new PhoneError(
      `ElevenLabs ${s.tier} plan is out of credits (${s.character_count.toLocaleString()} of ${s.character_limit.toLocaleString()} used); calls would hang up on pickup.`,
      `Credits reset ${reset}. To call sooner, add credits or turn on Auto Top Up under Billing at https://elevenlabs.io/app/subscription.`,
    );
  return `${s.tier} plan, ${left.toLocaleString()} credits left${s.allowed_to_extend_character_limit ? ", usage-based billing on" : ""}${s.next_character_count_reset_unix * 1000 > Date.now() ? `, resets ${reset}` : ""}`;
}

export function twilio(cfg: Config) {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_account_sid}`;
  const auth = "Basic " + Buffer.from(`${cfg.twilio_account_sid}:${cfg.twilio_auth_token}`).toString("base64");
  const call = (path: string, form?: Record<string, string>) =>
    request(
      base + path,
      form
        ? { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }
        : { headers: { authorization: auth } },
      "Twilio",
    );
  return {
    account: () => call(".json"),
    createCall: (form: Record<string, string>) => call("/Calls.json", form),
    getCall: (sid: string) => call(`/Calls/${sid}.json`),
    updateCall: (sid: string, form: Record<string, string>) => call(`/Calls/${sid}.json`, form),
    findNumber: async (number: string) =>
      (await call(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`)).incoming_phone_numbers?.[0],
    numbers: async () => (await call(`/IncomingPhoneNumbers.json?PageSize=100`)).incoming_phone_numbers as any[],
    updateNumber: (sid: string, form: Record<string, string>) => call(`/IncomingPhoneNumbers/${sid}.json`, form),
    recordings: async (callSid: string) => (await call(`/Calls/${callSid}/Recordings.json`)).recordings as any[],
    recordingAudio: async (recordingSid: string) => {
      const res = await fetch(`${base}/Recordings/${recordingSid}.mp3`, { headers: { authorization: auth } });
      if (!res.ok) throw new PhoneError(`Twilio recording download failed (${res.status})`);
      return res.arrayBuffer();
    },
  };
}

export const AGENT_NAME = "phone-cli";

// Tools the daemon implements itself; ElevenLabs forwards them as client_tool_call events.
const clientTool = (name: string, description: string, properties: Record<string, any>, extra: Record<string, any> = {}) => ({
  type: "client",
  name,
  description,
  expects_response: true,
  response_timeout_secs: 120,
  parameters: { type: "object", properties, required: Object.keys(properties) },
  ...extra,
});

const systemTool = (name: string, description: string) => ({
  type: "system",
  name,
  description,
  params: { system_tool_type: name },
});

export function agentSpec(cfg: Config) {
  return {
    name: AGENT_NAME,
    tags: ["phone-cli"],
    conversation_config: {
      asr: { user_input_audio_format: "ulaw_8000", quality: "high" },
      tts: {
        voice_id: cfg.voice_id ?? DEFAULTS.voice_id,
        model_id: DEFAULTS.tts_model,
        agent_output_audio_format: "ulaw_8000",
      },
      // Phone pacing: people pause to write things down and say "okay" while listening.
      turn: {
        turn_timeout: 20,
        initial_wait_time: 4,
        silence_end_call_timeout: -1,
        turn_eagerness: "patient",
        interruption_ignore_terms: ["okay", "ok", "okay dear", "yeah", "yep", "yes", "uh huh", "mm hmm", "mhm", "right", "sure", "got it", "alright", "all right", "gotcha", "uh", "um"],
        interruption_ignore_term_languages: ["en"],
        merge_with_default_ignore_terms: true,
      },
      agent: {
        first_message: "",
        language: "en",
        prompt: {
          prompt: "You are a phone agent. Your brief is supplied at the start of each call.",
          llm: cfg.llm ?? DEFAULTS.llm,
          tools: [
            clientTool(
              "ask_requester",
              "Ask the person you are calling for about a fact or decision you do not have. Say you will quickly check before calling it. Runs in the background: keep talking, and their answer arrives as this tool's result when they reply.",
              { question: { type: "string", description: "The question, self-contained, including what the other party said or offered." } },
              { pre_tool_speech: "force", execution_mode: "async" },
            ),
            clientTool(
              "press_keys",
              "Send touch-tone keypresses on the call, for automated phone menus and extension entry. Use 'w' for a half-second pause.",
              { digits: { type: "string", description: "Keys to press, e.g. '1', '2w3', '1234#'." } },
            ),
            systemTool("end_call", "End the call once the goal is done or clearly cannot be done, after saying goodbye."),
            systemTool("skip_turn", "Stay silent this turn: use while on hold, while the other party is busy, or when they asked you to wait."),
          ],
        },
      },
      conversation: {
        max_duration_seconds: 3600,
        client_events: [
          "audio",
          "interruption",
          "user_transcript",
          "agent_response",
          "agent_response_correction",
          "client_tool_call",
          "agent_tool_response",
        ],
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          tts: { voice_id: true },
          conversation: { text_only: true },
          agent: { first_message: true, language: true, prompt: { prompt: true, llm: true } },
        },
      },
      evaluation: {
        criteria: [
          {
            id: "goal_achieved",
            name: "goal_achieved",
            type: "prompt",
            conversation_goal_prompt:
              "The agent's system prompt contains a brief describing the goal of this call. Success means that goal was accomplished as the brief intended; failure means it was not, or only partly.",
          },
        ],
      },
      data_collection: {
        outcome: {
          type: "string",
          description:
            "What the call accomplished relative to the goal in the agent's brief, written for the person who requested the call: what was agreed, and every concrete detail they would need (prices, totals, times, dates, names, confirmation or order numbers, addresses, callback numbers), plus anything left unresolved or promised as follow-up. Plain sentences, no preamble.",
        },
      },
    },
  };
}

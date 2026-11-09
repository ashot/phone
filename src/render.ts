// Human- and agent-readable rendering of call events.
import type { Meta, PhoneEvent } from "./store";
import { clock, human } from "./text";

export function renderEvent(e: PhoneEvent, meta: Meta): string {
  // The clock starts at pickup; setup events before it have no time.
  const at = meta.answered_at && e.t >= meta.answered_at ? `[${clock((e.t - meta.answered_at) / 1000)}]` : "[--:--]";
  const pad = " ".repeat(at.length + 1);
  switch (e.type) {
    case "status":
      return `${at} · ${e.status}${e.detail ? `: ${e.detail}` : ""}`;
    case "them":
    case "agent": {
      // late: recovered from the final transcript after hangup, so it has no reliable time.
      const who = e.type === "them" ? "THEM: " : "AGENT:";
      return e.late ? `[--:--] ${who} ${e.text}  (transcribed after the call)` : `${at} ${who} ${e.text}`;
    }
    case "agent_cut":
      return `${at} AGENT (interrupted; they heard only): ${e.text}`;
    case "question":
      return `${at} QUESTION ${e.qid} from the voice agent (the other party is waiting): ${e.text}\n${pad}Reply within ${e.timeout}s: phone answer ${meta.id} "<your answer>"`;
    case "question_timeout":
      return `${at} · no reply to ${e.qid} in time; the agent carried on. A later \`phone answer\` still reaches it.`;
    case "answer":
      return `${at} YOU answered ${e.qid}${e.late ? " (late)" : ""}: ${e.text}`;
    case "steer":
      return `${at} YOU steered: ${e.text}`;
    case "say":
      return `${at} YOU asked the agent to say: ${e.text}`;
    case "keys":
      return `${at} · keys pressed by ${e.by === "you" ? "you" : "the agent"}: ${e.digits}`;
    case "hangup":
      return `${at} YOU hung up${e.now ? " (immediately)" : " (agent is saying goodbye)"}`;
    case "tool":
      return `${at} · agent used ${e.name}`;
    case "error":
      return `${at} ERROR: ${e.message}${e.hint ? `\n${pad}${e.hint}` : ""}`;
    case "ended":
      return `${at} · CALL ENDED: ${e.reason}${e.duration ? ` (talked ${human(e.duration)})` : ""}`;
    case "result":
      return renderResult(e);
    default:
      return `${at} · ${e.type} ${JSON.stringify(e)}`;
  }
}

export function renderResult(r: Record<string, any>): string {
  const lines = ["", "RESULT"];
  if (r.goal_achieved !== undefined) lines.push(`  goal achieved: ${r.goal_achieved}${r.rationale ? ` (${r.rationale})` : ""}`);
  if (r.outcome) lines.push(`  outcome: ${r.outcome}`);
  if (r.summary) lines.push(`  summary: ${r.summary}`);
  if (!r.outcome && !r.summary) lines.push(`  ${r.reason}`);
  if (r.recording) lines.push(`  recording: ${r.recording}`);
  return lines.join("\n");
}

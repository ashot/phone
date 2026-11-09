// Text helpers shared by the daemon, the timeline, and the renderers.

// Prefix of messages we inject as the requester (say, late answers). ElevenLabs records them
// as "user" turns, but the other party never said them.
export const REQUESTER_PREFIX = "[Not spoken by the other party. From the person you are calling for:]";

// eleven_v3 voices take inline delivery tags like [happy] or [slow]; they are not words.
export const spoken = (text?: string) => (text ?? "").replace(/\[[a-z][a-z ]*\]\s*/gi, "").trim();

// Real spoken turns from ElevenLabs' final transcript.
export const spokenTurns = (transcript: any[]) =>
  transcript.filter(
    (t) => (t.role === "user" || t.role === "agent") && t.message?.trim() && /\w/.test(t.message) && !t.message.startsWith(REQUESTER_PREFIX),
  );

// Words spoken right before a hangup are transcribed after the live connection closes. ElevenLabs'
// final record has them: return the trailing lines the live stream missed.
export function missedLines(events: { type: string }[], transcript: any[]) {
  const live = { user: events.filter((e) => e.type === "them").length, agent: events.filter((e) => e.type === "agent").length };
  const seen = { user: 0, agent: 0 };
  const missed: { type: "them" | "agent"; text: string }[] = [];
  for (const t of spokenTurns(transcript)) {
    const role = t.role as "user" | "agent";
    if (++seen[role] <= live[role]) continue;
    missed.push(role === "user" ? { type: "them", text: t.message.trim() } : { type: "agent", text: spoken(t.message) });
  }
  return missed;
}

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const human = (seconds: number) =>
  seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.round(seconds)}s`;

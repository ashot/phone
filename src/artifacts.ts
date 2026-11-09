// After-call artifacts: ElevenLabs' final transcript and analysis, and the Twilio recording.
// The daemon collects them when a call ends; view/transcript backfill older calls.
import { existsSync } from "fs";
import type { Config } from "./config";
import { elevenlabs, twilio } from "./providers";
import type { Meta } from "./store";
import { recordingPath, saveTranscript, transcriptPath } from "./timeline";

// Returns the finished ElevenLabs conversation (and caches its transcript), polling while analysis runs.
export async function fetchConversation(cfg: Config, meta: Meta, attempts = 1) {
  if (!meta.conversation_id) return null;
  for (let i = 0; i < attempts; i++) {
    const convo = await elevenlabs(cfg).conversation(meta.conversation_id).catch(() => null);
    if (convo && ["done", "failed"].includes(convo.status)) {
      saveTranscript(meta.id, convo.transcript ?? []);
      return convo;
    }
    if (i < attempts - 1) await Bun.sleep(3000);
  }
  return null;
}

// Twilio finishes a recording a few seconds after hangup. Returns the local path when saved.
export async function fetchRecording(cfg: Config, meta: Meta, attempts = 1): Promise<string | undefined> {
  if (!meta.twilio_sid || !meta.options.record) return;
  const tw = twilio(cfg);
  for (let i = 0; i < attempts; i++) {
    const rec = (await tw.recordings(meta.twilio_sid).catch(() => []))[0];
    if (rec?.status === "completed") {
      await Bun.write(recordingPath(meta.id), await tw.recordingAudio(rec.sid));
      return recordingPath(meta.id);
    }
    if (i < attempts - 1) await Bun.sleep(1500);
  }
}

// Fills in whatever a finished call is missing locally. Cheap when everything is cached.
export async function backfill(cfg: Config, meta: Meta) {
  if (!["ended", "failed"].includes(meta.state)) return;
  await Promise.all([
    existsSync(transcriptPath(meta.id)) ? null : fetchConversation(cfg, meta),
    existsSync(recordingPath(meta.id)) ? null : fetchRecording(cfg, meta),
  ]);
}

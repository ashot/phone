import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";

export type Config = {
  elevenlabs_api_key?: string;
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  from?: string;
  agent_id?: string;
  voice_id?: string;
  llm?: string;
};

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "phone");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const DEFAULTS = {
  voice_id: "cjVigY5qzO86Huf0OWal", // Eric: smooth, conversational American male
  llm: "gemini-3.5-flash",
  tts_model: "eleven_v3_conversational",
};

const ENV: Record<keyof Config, string> = {
  elevenlabs_api_key: "ELEVENLABS_API_KEY",
  twilio_account_sid: "TWILIO_ACCOUNT_SID",
  twilio_auth_token: "TWILIO_AUTH_TOKEN",
  from: "PHONE_FROM",
  agent_id: "PHONE_AGENT_ID",
  voice_id: "PHONE_VOICE_ID",
  llm: "PHONE_LLM",
};

export function readConfigFile(): Config {
  return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
}

// Environment wins over the file so a single call can be pointed elsewhere.
export function loadConfig(): Config {
  const cfg = readConfigFile();
  for (const [key, env] of Object.entries(ENV)) {
    if (process.env[env]) (cfg as any)[key] = process.env[env];
  }
  return cfg;
}

export function saveConfig(cfg: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  chmodSync(CONFIG_PATH, 0o600);
}

export class PhoneError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
  }
}

export function requireConfig(cfg: Config, keys: (keyof Config)[]): Required<Config> {
  const missing = keys.filter((k) => !cfg[k]);
  if (missing.length) {
    throw new PhoneError(
      `phone is not set up: missing ${missing.join(", ")}.`,
      `Run \`phone setup\` (reads ${missing.map((k) => ENV[k]).join(", ")} from the environment or flags). \`phone doctor\` shows what is configured.`,
    );
  }
  return cfg as Required<Config>;
}

// Accepts "(718) 555-1234", "718.555.1234", "+44 20 ..." and returns E.164.
export function normalizeNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  throw new PhoneError(
    `"${raw}" is not a phone number I can dial.`,
    `Use a 10-digit US number like 718-555-1234 or full international form like +442071234567.`,
  );
}

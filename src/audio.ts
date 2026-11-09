// 8 kHz mu-law helpers for synthesizing touch tones into the Twilio media stream.
const RATE = 8000;

const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477], A: [697, 1633],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477], B: [770, 1633],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477], C: [852, 1633],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477], D: [941, 1633],
};

export const VALID_KEYS = /^[0-9*#ABCDw]+$/;

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Returns mu-law audio for a key sequence: 200 ms tone and 100 ms gap per key, 500 ms per 'w'.
export function dtmfAudio(keys: string): Buffer {
  const samples: number[] = [];
  const silence = (ms: number) => {
    for (let i = 0; i < (RATE * ms) / 1000; i++) samples.push(0);
  };
  for (const key of keys) {
    if (key === "w") {
      silence(500);
      continue;
    }
    const [lo, hi] = DTMF[key];
    for (let i = 0; i < RATE * 0.2; i++) {
      const t = i / RATE;
      samples.push(Math.round(8000 * (Math.sin(2 * Math.PI * lo * t) + Math.sin(2 * Math.PI * hi * t))));
    }
    silence(100);
  }
  return Buffer.from(samples.map(linearToMulaw));
}

import { test, expect } from "bun:test";
import { missedLines } from "../src/text";
import { normalizeNumber } from "../src/config";
import { dtmfAudio } from "../src/audio";

test("missedLines recovers what was said right before a hangup", () => {
  const events = [{ type: "them" }, { type: "agent" }, { type: "status" }, { type: "them" }, { type: "agent" }];
  const transcript = [
    { role: "user", message: "Pizza Place, how can I help?" },
    { role: "agent", message: "One large pepperoni, please." },
    { role: "agent", message: null },
    { role: "user", message: "Address?" },
    { role: "agent", message: "[slow] Four ninety-five Thirteenth Street." },
    { role: "user", message: "[Not spoken by the other party. From the person you are calling for:] Say hi." },
    { role: "user", message: "About 30 minutes. Cash is fine. Bye!" },
  ];
  expect(missedLines(events, transcript)).toEqual([{ type: "them", text: "About 30 minutes. Cash is fine. Bye!" }]);
  expect(missedLines([...events, { type: "them" }], transcript)).toEqual([]);
});

test("normalizeNumber accepts common formats and rejects junk", () => {
  expect(normalizeNumber("(718) 555-0123")).toBe("+17185550123");
  expect(normalizeNumber("1-718-555-0123")).toBe("+17185550123");
  expect(normalizeNumber("+44 20 7123 4567")).toBe("+442071234567");
  expect(() => normalizeNumber("12345")).toThrow("not a phone number");
});

test("dtmfAudio: 300 ms per key, 500 ms per pause, at 8 kHz", () => {
  expect(dtmfAudio("1").length).toBe(2400);
  expect(dtmfAudio("1w2").length).toBe(2400 * 2 + 4000);
});

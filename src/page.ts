// The call log and call pages for humans: one self-contained HTML app over every call's record.
import { join } from "path";
import { HOME, callDir } from "./store";
import type { CallRecord } from "./timeline";

// Writes the log to ~/.phone/index.html and, for a single call, a copy next to its recording
// that opens on that call (file:// links drop #fragments when launched from the shell).
export async function writePages(records: CallRecord[], focus?: string): Promise<string> {
  const template = await Bun.file(join(import.meta.dir, "page.html")).text();
  const html = (base: string, initial?: string) =>
    template.replace("/*__DATA__*/", JSON.stringify({ base, initial: initial ?? null, calls: records }).replaceAll("</", "<\\/"));
  const index = join(HOME, "index.html");
  await Bun.write(index, html(""));
  if (!focus) return index;
  const page = join(callDir(focus), "index.html");
  await Bun.write(page, html("../../", focus));
  return page;
}

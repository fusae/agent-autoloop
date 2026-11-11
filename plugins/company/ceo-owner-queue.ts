import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDay } from "./workday.ts";

// The deferred evidence lives outside the model's writable workspace. Timers carry only its fixed key.
export function deferCEOOwner(directory: string, context: any, now = new Date()) {
  const evidence = { events: context.events ?? [], answers: context.answers ?? [] };
  const key = "ceo-owner-" + createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const folder = join(directory, "ceo-deferred");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, key + ".json");
  if (!existsSync(path)) {
    writeFileSync(path + ".tmp", JSON.stringify(evidence), { mode: 0o600, flush: true });
    renameSync(path + ".tmp", path);
  }
  const tomorrow = new Date(Date.parse(localDay(now) + "T09:05:00+08:00") + 86400_000).toISOString();
  return { later: [{ key, at: tomorrow, about: "CEO额度恢复后处理已保存的本人消息与答复" }] };
}
export function restoreCEOOwner(directory: string, context: any) {
  const events = new Map((context.events ?? []).map((e: any) => [`${e.source}:${e.id}`, e]));
  const answers = new Map((context.answers ?? []).map((a: any) => [a.card, a]));
  for (const timer of context.timers ?? []) {
    if (!/^ceo-owner-[a-f0-9]{64}$/.test(timer.key)) continue;
    const saved = JSON.parse(readFileSync(join(directory, "ceo-deferred", timer.key + ".json"), "utf8"));
    for (const e of saved.events) events.set(`${e.source}:${e.id}`, e);
    for (const a of saved.answers) answers.set(a.card, a);
  }
  return { ...context, events: [...events.values()], answers: [...answers.values()] };
}

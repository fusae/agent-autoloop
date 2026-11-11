import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executePublication, publicationAttempt, savePublicationAttempt, PublicationAbsent } from "./publication.ts";
import type { Company } from "./company.ts";
import type { Operations } from "./operations.ts";

// This path only reads existing attempts. A retry is queued through the ordinary approval and quota gates.
export function recoverPublications(
  directory: string,
  office: Company,
  operations: Operations,
  now = new Date(),
  lookup = executePublication,
) {
  const cycle = Math.floor(now.getTime() / 300_000);
  for (const task of office
    .tasks()
    .filter((t) => t.kind === "publish-content" && t.publication && t.status !== "superseded")) {
    const key = task.publication!;
    if (existsSync(join(directory, "publications", key + "-result.json"))) {
      office.reconcilePublication(key);
      operations.reconcilePublication(key, now);
      continue;
    }
    const attempt = publicationAttempt(directory, key);
    if (!attempt || attempt.manual || attempt.lastCycle === cycle || now.getTime() - Date.parse(attempt.at) < 300_000)
      continue;
    if (attempt.state === "absent") {
      if (task.status === "blocked") operations.retryPublication(key, now);
      continue;
    }
    // Reserve the read before calling an external process so a crash cannot reset the bound.
    const next = { ...attempt, checks: attempt.checks + 1, lastCycle: cycle };
    savePublicationAttempt(directory, next);
    try {
      lookup(directory, key, true);
      office.reconcilePublication(key);
      operations.reconcilePublication(key, now);
    } catch (error) {
      if (error instanceof PublicationAbsent) {
        if (task.status === "blocked") operations.retryPublication(key, now);
        continue;
      }
      savePublicationAttempt(directory, { ...next, manual: next.checks >= 3 });
      if (next.checks >= 3) office.publicationUnknown(key);
    }
  }
}

// One-time compatibility import. Never submits, dispatches, answers cards or changes a frozen draft.
export function importPublicationAttempts(directory: string, office: Company, now = new Date()) {
  let imported = 0;
  for (const task of office
    .tasks()
    .filter(
      (t) => t.kind === "publish-content" && t.publication && ["active", "blocked", "queued"].includes(t.status),
    )) {
    const key = task.publication!;
    if (publicationAttempt(directory, key) || existsSync(join(directory, "publications", key + "-result.json")))
      continue;
    const frozen = JSON.parse(readFileSync(join(directory, "publications", key + ".json"), "utf8"));
    const target = JSON.parse(readFileSync(join(directory, "publishing.json"), "utf8")).projects?.[frozen.business];
    if (!target?.channel) throw Error("旧发布记录缺少可信渠道");
    savePublicationAttempt(directory, {
      key,
      channel: target.channel,
      state: "unknown",
      at: task.reports.at(-1)?.at ?? String(office.history(task.id).at(-1)?.at ?? now.toISOString()),
      checks: 0,
    });
    imported++;
  }
  return imported;
}

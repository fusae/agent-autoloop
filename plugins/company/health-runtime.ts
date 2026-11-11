import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { failureKind, healthId, type HealthRuntime } from "./health.ts";
import { localDay } from "./workday.ts";
import { type Role } from "./company.ts";

import { staffAgentRole } from "./staff-model.ts";

export function healthRuntime(directory: string, now: Date): HealthRuntime {
  const result: HealthRuntime = { rounds: [], employees: {}, roles: {}, cards: [] };
  const started = new Set<number>();
  const read = (file: string, fn: (db: DatabaseSync) => void) => {
    if (!existsSync(file)) return;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON");
      fn(db);
    } finally {
      db.close();
    }
  };
  read(join(directory, "model-runs.db"), (db) => {
    result.usageKnown = true;
    for (const row of db
      .prepare(
        "SELECT id FROM journal j WHERE kind='started' AND NOT EXISTS (SELECT 1 FROM journal x WHERE x.id=j.id||':refunded')",
      )
      .all()) {
      const match = /^(?:model|legacy):(\d+):/.exec(String(row.id));
      if (match) started.add(Number(match[1]));
    }
    const start = new Date(`${localDay(now)}T00:00:00+08:00`).toISOString(),
      end = new Date(Date.parse(start) + 86400_000).toISOString();
    for (const r of db
      .prepare(
        "SELECT role,kind,count(*) n FROM journal j WHERE kind IN ('started','employee-started') AND at>=? AND at<? AND NOT EXISTS (SELECT 1 FROM journal x WHERE x.id=(CASE WHEN j.kind='employee-started' THEN substr(j.id,1,length(j.id)-9) ELSE j.id END)||':refunded') GROUP BY role,kind",
      )
      .all(start, end))
      if (r.kind === "started") result.roles[r.role as Role] = Number(r.n);
      else result.employees[String(r.role)] = Number(r.n);
  });
  read(join(directory, "hub/hub.db"), (db) => {
    // Read projections directly: public views may require credential-derived SQL functions.
    const rows = (collection: string) =>
      db
        .prepare("SELECT data FROM projections WHERE collection=?")
        .all(collection)
        .map((r) => JSON.parse(String(r.data)));
    const events = new Map(rows("events").map((e) => [e.id, e]));
    const links = rows("run_events");
    const cards = rows("cards");
    for (const r of rows("runs")
      .filter((r) => staffAgentRole(r.agent))
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)) {
      if (result.usageKnown && !started.has(r.id) && !r.error && r.state !== "failed") continue;
      const role = staffAgentRole(r.agent)!;
      const event = links
        .filter((l) => l.run_id === r.id)
        .map((l) => events.get(l.event_id))
        .find((e) => e?.type === `company.work.${role}` || e?.type?.startsWith(`company.work.${role}.`));
      const task = event?.subject;
      const assignment = event ? JSON.parse(event.detail).assignment : undefined;
      const notices = cards.filter((c) => c.run_id === r.id).map((c) => [c.kind, c.title, c.text]);
      result.rounds.push({
        id: r.id,
        role,
        task,
        at: r.finished_at ?? r.claimed_at ?? r.created_at,
        state: r.state,
        attempts: r.attempts,
        ...(notices.length ? { progress: healthId(JSON.stringify(notices)) } : {}),
        ...(Number.isSafeInteger(assignment) ? { assignment } : {}),
        ...(r.error ? { failure: failureKind(r.error) } : r.state === "failed" ? { failure: "failed" as const } : {}),
      });
    }
    const deliveries = rows("deliveries");
    result.cards = cards
      .filter((c) => c.title === "发布确认" || /^ceo-evening-\d/.test(c.key))
      .map((c) => ({
        id: c.id,
        key: c.key,
        title: c.title,
        state: c.state,
        at: c.created_at,
        delivered: deliveries.some((d) => d.card_id === c.id && !!d.ref && d.version >= c.version),
      }));
  });
  return result;
}

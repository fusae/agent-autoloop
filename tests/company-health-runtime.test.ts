// Failure modes: monitoring counts quota deferrals/refunds as real rounds, loses task identity across run/event links,
// misses business-specific staff agents, treats office receipt latency as idle, exposes raw errors, or mistakes a queued card for successful delivery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { healthRuntime } from "../plugins/company/health-runtime.ts";
const now = new Date("2026-11-09T02:00:00Z");
for (const business of [false, true])
  test(`runtime preserves exact ledger and task identity (business agent: ${business})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "health-runtime-"));
    mkdirSync(join(dir, "hub"));
    const budget = new DatabaseSync(join(dir, "model-runs.db")),
      hub = new DatabaseSync(join(dir, "hub/hub.db"));
    try {
      budget.exec("CREATE TABLE journal(id TEXT PRIMARY KEY,kind TEXT,at TEXT,role TEXT)");
      const record = (id: string, kind: string, role: string) =>
        budget.prepare("INSERT INTO journal VALUES(?,?,?,?)").run(id, kind, now.toISOString(), role);
      record("model:1:1:1", "started", "growth");
      record("model:1:1:1:employee", "employee-started", "app:growth");
      record("model:2:1:1", "started", "growth");
      record("model:2:1:1:employee", "employee-started", "app:growth");
      record("model:2:1:1:refunded", "refunded", "growth");
      record("model:4:1:1", "started", "ceo");
      hub.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT)");
      const row = (collection: string, key: string, data: object) =>
        hub.prepare("INSERT INTO projections VALUES(?,?,?)").run(collection, key, JSON.stringify(data));
      row("events", "e", {
        id: 5,
        type: business ? "company.work.growth.jinzhao" : "company.work.growth",
        subject: "T1",
        detail: JSON.stringify({ assignment: 2 }),
      });
      row("run_events", "r", { run_id: 1, event_id: 5 });
      for (const id of [1, 2, 3, 4, 5])
        row("runs", String(id), {
          id,
          agent: id === 4 ? "company-ceo" : business ? "company-staff-jinzhao-growth" : "company-growth",
          state: id === 5 ? "failed" : "done",
          attempts: 1,
          finished_at: now.toISOString(),
          error: id === 5 ? "Authentication failed token=PRIVATE-TEST-VALUE" : null,
          last_result: "a".repeat(64),
        });
      row("cards", "chat", { id: 6, run_id: 4, kind: "notice", title: "CEO回复", text: "已答复董事长" });
      row("cards", "7", {
        id: 7,
        key: "ceo-evening-2026-11-09",
        title: "CEO · 日报",
        state: "open",
        created_at: now.toISOString(),
        version: 1,
      });
      row("deliveries", "d", { card_id: 7, ref: "om_test", version: 1 });
      const result = healthRuntime(dir, now);
      assert.equal(result.employees["app:growth"], 1);
      assert.equal(result.roles.growth, 1);
      assert.deepEqual(
        result.rounds.map((r) => r.id),
        [5, 4, 1],
      );
      assert.equal(result.rounds.at(-1)!.task, "T1");
      assert.equal(result.rounds.at(-1)!.assignment, 2);
      assert.equal(result.rounds[0].failure, "auth");
      assert.ok(result.rounds[1].progress);
      assert.equal(result.cards[0].delivered, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TEST-VALUE/);
      assert.equal(hub.prepare("SELECT count(*) n FROM projections").get()!.n, 10);
    } finally {
      budget.close();
      hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

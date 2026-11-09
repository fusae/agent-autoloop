// Failure modes: patrol repeatedly queues CEO runs; model actions bypass publish/rule boundaries; pause fails to stop
// approved work, resume expands activeRoles, retry repeats completed work, and escalation cooldown is lost on restart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Company, type Task } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
import { healthId, type HealthIncident } from "../plugins/company/health.ts";
import { permissions } from "../plugins/company/workday.ts";
const now = new Date("2026-11-09T02:00:00Z");
const decision = (extra = {}) => ({
  briefs: [],
  directives: [],
  approvals: [],
  answers: [],
  escalations: [],
  ...extra,
});
function fixture(fn: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "company-health-"));
  const config = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    dailyPlanning: true,
    health: { enabled: true },
    workday: { enabled: true, after: "09:00" },
    permissions,
    activeRoles: ["growth" as const],
    inspections: false,
    ceoWake: "events" as const,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(config));
  const b = new Businesses(dir),
    c = new Company(config);
  let o = new Operations(dir),
    seq = 0;
  b.save(
    { id: "app", name: "业务", description: "资料", audience: "用户", objective: "写稿", stage: "operating" },
    new Date(+now - 86400_000),
  );
  b.autonomy("app", true, now);
  b.status("app", "active", now);
  o.leadership(true, now);
  o.seedWeeklyGoals(
    [
      {
        business: "app",
        role: "growth",
        week: "2026-11-09",
        direction: "写稿",
        metrics: [{ name: "发帖", target: 7, unit: "篇" }],
      },
    ],
    now,
  );
  const tick = (at = now) => o.plan(`t${++seq}`, b.list(), c.tasks(), at);
  const decide = (extra: any, at = now) =>
    o.plan(`d${++seq}`, b.list(), c.tasks(), at, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "处理异常", executive: decision(extra) }),
      },
    ]);
  const state = () => o.snapshot(b.list(), c.tasks(), now)[0];
  const inject = (incident: Partial<HealthIncident>, task?: Task) => {
    const db = new DatabaseSync(join(dir, "operations.db"));
    const chief = o.executive();
    chief.health ??= { revision: 1, pending: false, checkedAt: now.toISOString(), incidents: [] };
    const issue = {
      id: healthId(incident.kind ?? "failed"),
      kind: "failed",
      business: "app",
      role: "growth" as const,
      title: "员工运行异常",
      impact: "未交付",
      evidence: "运行记录",
      suggestion: "核对",
      severity: 1,
      firstAt: now.toISOString(),
      lastAt: now.toISOString(),
      actions: [],
      ...incident,
    };
    chief.health.incidents.push(issue);
    db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(chief));
    if (task) {
      const p = JSON.parse(String(db.prepare("SELECT body FROM projects WHERE id='app'").get()!.body));
      p.activity.push({ task: task.id, role: "growth", kind: "work", at: now.toISOString() });
      p.plans.push({
        id: "p",
        owner: "growth",
        proposedBy: "growth",
        status: "blocked",
        task: task.id,
        kind: "content",
        dueAt: now.toISOString(),
        title: "工作",
        result: "失败",
      });
      db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
      const tasks = new DatabaseSync(config.database);
      tasks.prepare("INSERT INTO tasks VALUES (?,?)").run(task.id, JSON.stringify(task));
      tasks.close();
    }
    db.close();
    return issue;
  };
  try {
    fn({
      dir,
      b,
      c,
      get o() {
        return o;
      },
      tick,
      decide,
      state,
      inject,
      restart() {
        o.close();
        o = new Operations(dir);
      },
    });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("one new incident queues one CEO review, refreshes readable context, and survives restart without duplicate dispatch", () =>
  fixture(({ tick, o, dir, restart }: any) => {
    const first = tick();
    const kinds = first.events.map((e: any) => JSON.parse(e.detail).kind);
    assert.equal(kinds.filter((k: string) => k === "ceo").length, 1);
    assert.ok(o.executive().health.incidents.some((i: any) => i.kind === "not-started"));
    const context = JSON.parse(readFileSync(join(dir, "workspace/knowledge/ceo.json"), "utf8"));
    assert.ok(context.anomalies[0].impact && context.anomalies[0].evidence);
    restart();
    assert.equal(
      tick(new Date(+now + 15 * 60000)).events?.filter((e: any) => JSON.parse(e.detail).kind === "ceo").length ?? 0,
      0,
    );
  }));
test("CEO pauses and resumes only its own employee, without changing rules or claiming a running task stopped", () =>
  fixture(({ tick, o, decide, state, inject }: any) => {
    tick();
    const i = o.executive().health.incidents.find((i: any) => i.kind === "not-started");
    decide({ responses: [{ anomaly: i.id, action: "pause", reason: "先处理卡点" }] });
    assert.equal(state().staff.find((s: any) => s.role === "growth").enabled, false);
    decide({ responses: [{ anomaly: i.id, action: "resume", reason: "卡点已核对" }] });
    assert.equal(state().staff.find((s: any) => s.role === "growth").enabled, true);
    const forbidden = inject({ kind: "off-duty", role: "engineering" });
    const before = JSON.stringify(state().staff.find((s: any) => s.role === "engineering"));
    decide({ responses: [{ anomaly: forbidden.id, action: "resume", reason: "试图改变在岗名单" }] });
    assert.equal(JSON.stringify(state().staff.find((s: any) => s.role === "engineering")), before);
  }));
test("safe retries use the original blocked task once; publication/code/auth retries and invented actions are refused", () => {
  for (const [kind, reason] of [
    ["staff-growth", "待处理"],
    ["publish-content", "待处理"],
    ["software", "待处理"],
    ["staff-growth", "认证失败"],
  ])
    fixture(({ tick, inject, decide, o }: any) => {
      tick();
      const t: Task = {
        id: "blocked",
        title: "原任务",
        kind,
        goal: "交付",
        acceptance: ["文件"],
        status: "blocked",
        stage: 0,
        assignment: 1,
        reports: [],
        reason,
        approval: null,
      };
      const i = inject({ task: t.id }, t);
      const r = decide({ responses: [{ anomaly: i.id, action: "retry", reason: "已核对修复条件" }] });
      const retries = r.events?.filter((e: any) => e.type === "company.task.retry" && e.subject === t.id) ?? [];
      const allowed = kind === "staff-growth" && reason === "待处理";
      assert.equal(retries.length, allowed ? 1 : 0);
      if (allowed) assert.equal(o.executive().retries[t.id], 1);
    });
  for (const action of ["confirm", "publish", "quota", "change-rules", "write-code", "change-key"])
    assert.throws(() => executiveDecision(decision({ responses: [{ anomaly: "a", action, reason: "越权" }] })));
});
test("pause blocks existing automatic repairs, pending retries and budget-deferred work until resume", () =>
  fixture(({ tick, inject, decide, o, b, c, dir }: any) => {
    tick();
    const t: Task = {
      id: "blocked",
      title: "原任务",
      kind: "staff-growth",
      goal: "交付",
      acceptance: ["文件"],
      status: "blocked",
      stage: 0,
      assignment: 1,
      reports: [],
      reason: "运行失败：超时",
      approval: null,
    };
    const i = inject({ task: t.id }, t);
    const db = new DatabaseSync(join(dir, "operations.db"));
    const chief = o.executive();
    chief.pendingRetries = [{ task: t.id, decision: "previous" }];
    db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(chief));
    db.close();
    const stopped = decide({ responses: [{ anomaly: i.id, action: "pause", reason: "等待故障修复" }] });
    assert.ok(!stopped.events?.some((e: any) => e.type === "company.task.retry" && e.subject === t.id));
    assert.ok(o.pausedTasks(b.list(), c.tasks(), now).has(t.id));
    const retry = decide({ responses: [{ anomaly: i.id, action: "retry", reason: "仍然暂停" }] });
    assert.ok(!retry.events?.some((e: any) => e.type === "company.task.retry" && e.subject === t.id));
    const resumed = decide({ responses: [{ anomaly: i.id, action: "resume", reason: "故障已修复" }] });
    assert.equal(resumed.events.filter((e: any) => e.type === "company.task.retry" && e.subject === t.id).length, 1);
    assert.ok(!o.pausedTasks(b.list(), c.tasks(), now).has(t.id));
  }));
test("escalation carries four concrete fields, stays open, and cannot notify twice within 24 hours after restart", () =>
  fixture(({ tick, o, decide, restart }: any) => {
    tick();
    const id = o.executive().health.incidents[0].id;
    const extra = {
      responses: [
        {
          anomaly: id,
          action: "escalate",
          category: "decision",
          reason: "资料不足以安全决定",
          request: "请指定首要目标。",
        },
      ],
    };
    const r = decide(extra);
    const notices = r.notice.filter((n: any) => n.title === "CEO · 异常上报");
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /发生：[\s\S]*影响：[\s\S]*已尝试：[\s\S]*需要董事长：/);
    assert.equal(o.executive().health.incidents[0].resolvedAt, undefined);
    restart();
    assert.equal(
      decide(extra, new Date(+now + 60000)).notice?.filter((n: any) => n.title === "CEO · 异常上报").length ?? 0,
      0,
    );
  }));
test("a delivered version can be sent back for review only once, without approving or publishing it", () =>
  fixture(({ tick, inject, decide, o, state, dir }: any) => {
    tick();
    const t: Task = {
      id: "delivered",
      title: "原稿",
      kind: "staff-growth",
      goal: "交付",
      acceptance: ["文件"],
      status: "completed",
      stage: 1,
      assignment: 1,
      reports: [],
      reason: "交付待审",
      approval: null,
    };
    const i = inject({ kind: "review-overdue", task: t.id, plan: "p" }, t);
    const db = new DatabaseSync(join(dir, "operations.db"));
    const p = JSON.parse(String(db.prepare("SELECT body FROM projects WHERE id='app'").get()!.body));
    p.plans[0].status = "delivered";
    db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
    db.close();
    const before = o.executive().health.revision;
    const response = { responses: [{ anomaly: i.id, action: "review", reason: "补审当前交付" }] };
    decide(response);
    assert.equal(o.executive().health.revision, before + 1);
    decide(response);
    assert.equal(o.executive().health.revision, before + 1);
    assert.equal(state().plans[0].status, "delivered");
    assert.equal(o.executive().health.incidents.find((v: any) => v.id === i.id).actions.length, 1);
  }));
test("an unavailable CEO is escalated by the program after authentication failure or exhausted repairs, without raw errors", () => {
  for (const error of ["Authentication failed PRIVATE-TEST-VALUE", "timeout PRIVATE-TEST-VALUE"])
    fixture(({ tick, o, dir, restart }: any) => {
      tick();
      mkdirSync(join(dir, "hub"));
      const hub = new DatabaseSync(join(dir, "hub/hub.db"));
      hub.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT)");
      const row = (collection: string, data: object) =>
        hub.prepare("INSERT INTO projections VALUES(?,?,?)").run(collection, "1", JSON.stringify(data));
      row("events", { id: 1, type: "company.work.ceo", subject: "ceo-failed", detail: '{"assignment":3}' });
      row("run_events", { run_id: 1, event_id: 1 });
      row("runs", { id: 1, agent: "company-ceo", state: "failed", attempts: 3, error, finished_at: now.toISOString() });
      hub.close();
      const db = new DatabaseSync(join(dir, "operations.db"));
      const c = o.executive();
      c.repairs = {
        "ceo-failed": { attempts: 2, exhausted: true, assignment: 3, reason: "失败", nextAt: now.toISOString() },
      };
      db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(c));
      db.close();
      const first = tick(new Date(+now + 15 * 60000));
      const notices = first.notice.filter((n: any) => n.title === "CEO · 异常上报");
      assert.equal(notices.length, 1);
      assert.match(notices[0].text, /发生：[\s\S]*影响：[\s\S]*已尝试：[\s\S]*需要董事长：/);
      assert.doesNotMatch(notices[0].text, /PRIVATE-TEST-VALUE/);
      restart();
      assert.equal(
        tick(new Date(+now + 30 * 60000)).notice?.filter((n: any) => n.title === "CEO · 异常上报").length ?? 0,
        0,
      );
    });
});

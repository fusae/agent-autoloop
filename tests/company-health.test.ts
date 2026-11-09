// Failure modes: stale waits and silent employees escape detection; quotas or failed runs are mixed across employees;
// unchanged incidents spend model rounds or spam the chairman; a reminder confirms a publication; false resolution hides faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectHealth,
  healthDue,
  reconcileHealth,
  canNotify,
  healthReport,
  type HealthRuntime,
  type HealthFinding,
} from "../plugins/company/health.ts";
import type { Leadership } from "../plugins/company/executive.ts";
import type { Project } from "../plugins/company/operations.ts";
import type { Task, CompanyConfig } from "../plugins/company/company.ts";
const now = new Date("2026-11-09T02:00:00Z");
const chief = (): Leadership => ({
  enabled: true,
  lastTask: null,
  processed: null,
  fingerprint: null,
  lastReportDay: null,
  briefs: {},
  issues: [],
  questions: [],
  knowledge: [],
  decisions: [],
  runs: [],
  answeredCards: [],
  retries: {},
});
const runtime = (): HealthRuntime => ({ rounds: [], employees: {}, roles: {}, cards: [] });
function fixture() {
  const project = {
    business: "app",
    name: "测试业务",
    createdAt: "2026-11-08T00:00:00Z",
    owner: "growth",
    maxDailyTasks: 12,
    maxActive: 3,
    activity: [],
    plans: [],
    signals: [],
    staff: [
      {
        role: "growth",
        enabled: true,
        name: "运营",
        weeklyGoal: {
          business: "app",
          role: "growth",
          week: "2026-11-09",
          direction: "写稿",
          metrics: [{ name: "发帖", target: 7, unit: "篇" }],
        },
        daily: {
          date: "2026-11-09",
          goal: "写稿",
          focus: "写稿",
          doneWhen: "有稿件",
          mode: "followup",
          reviewAt: "2026-11-10T01:30:00Z",
          issuedAt: "2026-11-09T01:00:00Z",
        },
      },
    ],
  } as unknown as Project & { name: string; createdAt: string };
  return {
    now,
    config: { activeRoles: ["growth"], dailyModelRuns: { ceo: 10, employee: 10 } } as Partial<CompanyConfig>,
    chief: chief(),
    tasks: [] as Task[],
    projects: [project],
    runtime: runtime(),
    publications: [] as any[],
  };
}
const kinds = (f: ReturnType<typeof fixture>) => detectHealth(f).map((v) => v.kind);
test("patrol runs once per fifteen-minute work-hours window, never on weekends", () => {
  assert.ok(healthDue(undefined, now));
  for (const date of ["2026-11-09T00:59:00Z", "2026-11-09T14:00:00Z", "2026-11-08T04:00:00Z"])
    assert.equal(healthDue(undefined, new Date(date)), false);
  const state = reconcileHealth(undefined, [], now);
  assert.equal(healthDue(state, new Date(+now + 899000)), false);
  assert.ok(healthDue(state, new Date(+now + 900000)));
});
test("zero-round threshold uses confirmed unfinished goals and actual starts, excluding paused staff", () => {
  const f = fixture();
  f.now = new Date(+now - 1);
  assert.ok(!kinds(f).includes("not-started"));
  f.now = now;
  assert.ok(kinds(f).includes("not-started"));
  f.runtime.employees["app:growth"] = 1;
  assert.ok(!kinds(f).includes("not-started"));
  f.runtime.employees["app:growth"] = 0;
  f.projects[0].staff[0].enabled = false;
  assert.ok(!kinds(f).includes("not-started"));
  f.projects[0].staff[0].enabled = true;
  f.projects[0].staff[0].weeklyGoal!.metrics[0].target = 0;
  assert.ok(!kinds(f).includes("not-started"));
});
test("missing weekly goals and invalid owner/dependency waits are reported with usable evidence", () => {
  const f = fixture(),
    s = f.projects[0].staff[0];
  delete s.weeklyGoal;
  assert.ok(kinds(f).includes("missing-goal"));
  s.daily!.focus = "等负责人答复";
  assert.ok(kinds(f).includes("invalid-wait"));
  s.daily!.waiting = { kind: "plan", id: "gone" };
  assert.ok(kinds(f).includes("invalid-wait"));
  f.projects[0].plans = [{ id: "gone", status: "working" }] as any;
  assert.ok(!kinds(f).includes("invalid-wait"));
  f.projects[0].plans[0].status = "delivered";
  assert.ok(kinds(f).includes("invalid-wait"));
  for (const i of detectHealth(f)) assert.ok(i.title && i.impact && i.evidence && i.suggestion);
});
test("delayed reviews exclude queued/running reviews and publication failures never suggest reposting", () => {
  const f = fixture();
  f.projects[0].plans = [
    { id: "p", status: "delivered", deliveredAt: new Date(+now - 30 * 60000).toISOString(), task: "t" },
  ] as any;
  assert.ok(kinds(f).includes("review-overdue"));
  f.tasks.push({ id: "ceo", kind: "ceo", status: "queued" } as Task);
  assert.ok(!kinds(f).includes("review-overdue"));
  f.tasks[0].status = "active";
  assert.ok(!kinds(f).includes("review-overdue"));
  f.tasks = [{ id: "t", kind: "publish-content", status: "blocked", reason: "平台回执失败" }] as Task[];
  assert.ok(kinds(f).includes("publish-failed"));
  assert.match(detectHealth(f).find((i) => i.kind === "publish-failed")!.suggestion, /不重发/);
});
test("consecutive failure, auth and timeout are detected per employee and CEO; success breaks the failure streak", () => {
  const f = fixture();
  f.runtime.rounds = [1, 2].map((id) => ({
    id,
    role: "ceo",
    at: now.toISOString(),
    state: "failed",
    attempts: 1,
    failure: "failed",
  }));
  assert.ok(kinds(f).includes("failed"));
  f.runtime.rounds[1].state = "done";
  delete f.runtime.rounds[1].failure;
  assert.ok(!kinds(f).includes("failed"));
  f.projects[0].activity.push({ task: "employee", role: "growth", kind: "work", at: now.toISOString() });
  f.runtime.rounds = [
    { id: 3, role: "growth", task: "employee", at: now.toISOString(), state: "failed", attempts: 1, failure: "auth" },
  ];
  assert.ok(kinds(f).includes("auth"));
  f.runtime.rounds[0].failure = "timeout";
  assert.ok(kinds(f).includes("timeout"));
  f.runtime.rounds[0].failure = "failed";
  f.runtime.rounds[0].attempts = 2;
  assert.ok(kinds(f).includes("failed"));
});
test("three outputless rounds trigger idle; real artifacts or changed plans break the streak", () => {
  const f = fixture();
  f.runtime.rounds = [1, 2, 3].map((id) => ({
    id,
    role: "ceo",
    task: `t${id}`,
    at: now.toISOString(),
    state: "done",
    attempts: 1,
  }));
  assert.ok(kinds(f).includes("idle"));
  f.tasks.push({ id: "t3", reports: [{ at: now.toISOString(), artifacts: ["tasks/result.md"] }] } as Task);
  assert.ok(!kinds(f).includes("idle"));
});
test("80 percent quota is per employee and CEO; pending confirmations and X only allow one reminder", () => {
  const f = fixture();
  f.runtime.employees = { "app:growth": 8, "other:growth": 0 };
  f.runtime.roles.ceo = 8;
  assert.equal(detectHealth(f).filter((i) => i.kind === "quota").length, 2);
  f.runtime.cards = [
    {
      id: 7,
      key: "p",
      title: "发布确认",
      state: "open",
      at: new Date(+now - 4 * 3600_000).toISOString(),
      delivered: true,
    },
  ];
  f.publications = [{ key: "key", publishedAt: new Date(+now - 86400_000).toISOString(), x: { state: "pending" } }];
  const reminders = detectHealth(f).filter((i) => i.reminderOnly);
  assert.equal(reminders.length, 2);
  const state = reconcileHealth(undefined, reminders, now);
  for (const i of state.incidents) {
    i.notifiedAt = now.toISOString();
    assert.equal(canNotify(i, new Date(+now + 2 * 86400_000)), false);
  }
  f.runtime.cards[0].state = "decided";
  f.publications[0].x.state = "published";
  assert.equal(detectHealth(f).filter((i) => i.reminderOnly).length, 0);
});
test("20:45 report requires generation AND successful delivery, not a mere processed flag", () => {
  const f = fixture();
  f.config.reporting = { enabled: true };
  f.now = new Date("2026-11-09T12:45:00Z");
  assert.ok(kinds(f).includes("report-missing"));
  f.chief.eveningReports = [{ date: "2026-11-09", task: "report", processed: true }];
  assert.ok(kinds(f).includes("report-missing"));
  f.runtime.cards = [
    {
      id: 1,
      key: "ceo-evening-2026-11-09",
      title: "CEO · 日报",
      at: f.now.toISOString(),
      state: "open",
      delivered: true,
    },
  ];
  assert.ok(!kinds(f).includes("report-missing"));
});
test("persistent incidents wake once, worsen once, resolve only by inspection, and cooldown survives recurrence", () => {
  const finding: HealthFinding = {
    id: "a",
    kind: "auth",
    title: "认证失败",
    impact: "未开工",
    evidence: "故障记录",
    suggestion: "恢复登录",
    severity: 1,
  };
  let state = reconcileHealth(undefined, [finding], now);
  assert.equal(state.revision, 1);
  assert.equal(state.pending, true);
  state.pending = false;
  state.incidents[0].notifiedAt = now.toISOString();
  state.incidents[0].notifiedSeverity = 1;
  state = reconcileHealth(state, [{ ...finding, evidence: "下一次检查" }], new Date(+now + 900000));
  assert.equal(state.pending, false);
  assert.equal(state.revision, 1);
  assert.equal(canNotify(state.incidents[0], now), false);
  state = reconcileHealth(state, [{ ...finding, severity: 2 }], now);
  assert.equal(state.pending, true);
  assert.equal(canNotify(state.incidents[0], now), true);
  state.incidents[0].notifiedSeverity = 2;
  state = reconcileHealth(state, [], now);
  assert.ok(state.incidents[0].resolvedAt);
  state = reconcileHealth(state, [finding], now);
  assert.equal(canNotify(state.incidents[0], now), false);
  assert.ok(canNotify(state.incidents[0], new Date(+now + 86400_000)));
  state.incidents[0].actions.push({ at: now.toISOString(), action: "retry", result: "已重试，仍在跟进" });
  assert.match(healthReport(state, "2026-11-09"), /今天 CEO 发现并处理的问题[\s\S]*已重试/);
  assert.equal(healthReport(undefined, "2026-11-09"), "");
});

test("Friday combined report is checked after 21:00, never mistaken for a missing 20:30 daily report", () => {
  const f = fixture();
  f.config.reporting = { enabled: true, weekly: true };
  f.now = new Date("2026-11-13T12:45:00Z");
  assert.ok(!kinds(f).includes("report-missing"));
  f.now = new Date("2026-11-13T13:15:00Z");
  assert.ok(kinds(f).includes("report-missing"));
});

test("valid chairman waits are not mistaken for a silent employee, while missing waits still are", () => {
  const f = fixture(),
    s = f.projects[0].staff[0];
  f.chief.questions.push({ id: "decision", state: "open", issues: ["issue"] } as any);
  f.chief.issues.push({ id: "issue", business: "app", state: "owner" } as any);
  s.daily!.waiting = { kind: "owner", id: "decision" };
  assert.ok(!kinds(f).includes("not-started"));
  s.daily!.waiting.id = "missing";
  assert.ok(kinds(f).includes("not-started"));
});

test("retrospectives are real output and weekly employee failures remain visible", () => {
  const f = fixture();
  f.chief.weeklyCycles = [
    {
      week: "2026-11-09",
      date: "2026-11-13",
      staff: [{ business: "app", role: "growth", task: "WEEK-app", through: 0 }],
    },
  ];
  f.runtime.rounds = [
    { id: 4, role: "growth", task: "WEEK-app", at: now.toISOString(), state: "failed", attempts: 2, failure: "failed" },
  ];
  assert.ok(kinds(f).includes("failed"));
  f.runtime.rounds = [1, 2, 3].map((id) => ({
    id,
    role: "ceo",
    task: `t${id}`,
    at: now.toISOString(),
    state: "done",
    attempts: 1,
  }));
  f.tasks = [
    { id: "t3", reports: [{ artifacts: [], retrospective: { review: "真实复盘", notes: "经验", through: 1 } }] },
  ] as any;
  assert.ok(!kinds(f).includes("idle"));
});

test("waiting for topic approval is not employee inactivity and does not suppress the chairman reminder", () => {
  const f = fixture();
  f.config.topics = { startAt: "2026-11-09T01:00:00Z" };
  f.projects[0].topics = [{ id: "t", role: "growth", state: "pending", batch: "b" }] as any;
  f.projects[0].topicBatches = [{ id: "b", topics: ["t"], at: "2026-11-09T01:00:00Z" }];
  f.now = new Date("2026-11-09T05:15:00Z");
  assert.ok(!kinds(f).includes("not-started"));
  assert.ok(kinds(f).includes("topics"));
  f.projects[0].topics![0].state = "approved";
  assert.ok(kinds(f).includes("not-started"));
});

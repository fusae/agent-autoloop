// Failure modes: daily goals are only prose, CEO plans duplicate work, follow-ups never wake,
// waiting staff spin on unchanged data, or invalid cross-role plans partially apply decisions.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Businesses } from "../plugins/company/business.ts";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
const now = new Date("2026-11-06T02:00:00Z");
const action = {
  key: "post",
  title: "完整推广图文",
  kind: "content",
  goal: "运营完成标题正文封面",
  acceptance: ["图文文件可以打开"],
  priority: 1,
  dueDays: 1,
  followUpDays: 3,
  measure: "实际发布后的阅读数据",
};
const daily = (more = {}) => ({
  business: "app",
  role: "growth",
  date: "2026-11-06",
  goal: "持续产出可发布图文并跟进真实效果",
  focus: "完成今天的标题正文和封面",
  doneWhen: "CEO收到完整图文文件",
  mode: "work",
  plan: "post",
  reviewAt: "2026-11-06T09:00:00Z",
  ...more,
});
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "daily-company-"));
  const cfg = {
    name: "test",
    database: join(dir, "company.db"),
    ceoMode: true,
    contentReview: "ceo" as const,
    dailyPlanning: true,
    maxAssignments: 6,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const b = new Businesses(dir),
    c = new Company(cfg),
    o = new Operations(dir);
  let seq = 0;
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] });
  const tick = (at = now, depth = 1) => o.plan("tick-" + ++seq, b.list(), c.tasks(), at, [], depth);
  const decide = (d: any, at = now) =>
    o.plan("decision-" + ++seq, b.list(), c.tasks(), at, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "今日安排", executive: decision(d) }),
      },
    ]);
  try {
    b.save(
      { id: "app", name: "APP", description: "提醒", audience: "用户", objective: "推广", stage: "operating" },
      now,
    );
    b.autonomy("app", true, now);
    b.status("app", "active", now);
    o.leadership(true, now);
    for (const role of ["product", "engineering", "qa", "finance"]) o.configure("app", role, { enabled: false }, now);
    fn({ dir, b, c, o, send, tick, decide });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("daily plan schema keeps role goals and rejects ambiguous schedules", () => {
  assert.equal(executiveDecision(decision({ staffPlans: [daily()] })).staffPlans?.[0].focus, daily().focus);
  for (const patch of [
    { role: "CEO" },
    { date: "2026-02-30" },
    { mode: "unknown" },
    { reviewAt: "tomorrow" },
    { focus: "" },
  ])
    assert.throws(() => executiveDecision(decision({ staffPlans: [daily(patch)] })));
});

test("CEO daily work dispatches once, persists employee goals and leaves standby staff quiet", () =>
  fixture(({ o, b, c, dir, decide, tick, send }) => {
    const receipt = decide({
      briefs: [{ business: "app", objective: "完整图文交接" }],
      directives: [{ business: "app", action }],
      staffPlans: [
        daily(),
        daily({
          role: "support",
          mode: "standby",
          plan: undefined,
          focus: "没有新反馈，待命",
          doneWhen: "有反馈时整理给CEO",
        }),
      ],
    });
    const work = receipt.events?.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    assert.ok(work);
    assert.ok(!receipt.events?.some((e: any) => JSON.parse(e.detail).kind === "check-support"));
    send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    const staff = o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth");
    assert.equal(staff.daily.focus, daily().focus);
    assert.equal(staff.daily.plan, o.snapshot(b.list(), c.tasks(), now)[0].plans[0].id);
    const profile = JSON.parse(readFileSync(join(dir, "workspace/knowledge/operations/app.json"), "utf8"));
    assert.equal(profile.staff.find((s: any) => s.role === "growth").daily.goal, daily().goal);
    const reopened = new Operations(dir);
    assert.equal(
      reopened.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth")?.daily?.date,
      "2026-11-06",
    );
    reopened.close();
    assert.ok(!tick().events?.some((e: any) => JSON.parse(e.detail).kind === "internal-content"));
  }));

test("scheduled follow-up wakes on time once even without new data, then waits for the next CEO arrangement", () =>
  fixture(({ o, b, c, decide, tick, send }) => {
    const receipt = decide({
      briefs: [{ business: "app", objective: "跟进已交接草稿" }],
      staffPlans: [
        daily({
          mode: "followup",
          plan: undefined,
          focus: "核对本人是否已经发布",
          doneWhen: "记录真实链接或仍未发布",
          reviewAt: "2026-11-06T03:00:00Z",
        }),
      ],
    });
    assert.ok(!receipt.events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"));
    const at = new Date("2026-11-06T03:01:00Z");
    const due = tick(at).events?.find((e: any) => JSON.parse(e.detail).kind === "check-growth");
    assert.ok(due);
    assert.match(JSON.parse(due.detail).goal, /核对本人是否已经发布/);
    send("company-inbox", due.type, due.subject, JSON.parse(due.detail));
    send("company-growth", "company.result", due.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "未收到发布记录，无新增效果数据",
      artifacts: [],
      evidence: ["现有交接记录"],
      inspection: { state: "idle", actions: [], reviews: [] },
    });
    tick(new Date("2026-11-06T03:02:00Z"), 4);
    assert.ok(
      !tick(new Date("2026-11-06T03:05:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"),
    );
    const next = decide(
      { staffPlans: [daily({ mode: "followup", plan: undefined, reviewAt: "2026-11-06T05:00:00Z" })] },
      new Date("2026-11-06T03:10:00Z"),
    );
    assert.ok(!next.events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"));
    assert.ok(
      tick(new Date("2026-11-06T05:01:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"),
    );
  }));

test("invalid daily assignments reject the entire decision before creating work", () =>
  fixture(({ o, b, c, decide }) => {
    for (const patch of [
      { plan: "missing" },
      { role: "finance" },
      { date: "2026-11-05" },
      { reviewAt: "2026-11-06T01:00:00Z" },
    ]) {
      const r = decide({
        briefs: [{ business: "app", objective: "不得写入" }],
        directives: [{ business: "app", action }],
        staffPlans: [daily(patch)],
      });
      assert.match(r.notice?.[0].text ?? "", /未执行/);
      assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans.length, 0);
      assert.equal(o.executive().briefs.app, undefined);
    }
  }));

test("today's selected work takes precedence and a closed directive key cannot recreate completed work", () =>
  fixture(({ o, b, c, decide, tick, send }) => {
    const r = decide({
      briefs: [{ business: "app", objective: "完成今天交付" }],
      directives: [
        { business: "app", action: { ...action, key: "old", title: "旧积压", priority: 1 } },
        { business: "app", action: { ...action, key: "today", title: "今日图文", priority: 3 } },
      ],
      staffPlans: [daily({ plan: "today" })],
    });
    const work = r.events.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    assert.equal(JSON.parse(work.detail).title, "APP · 今日图文");
    send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    send("company-growth", "company.result", work.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "图文完成",
      artifacts: ["tasks/post.md"],
      evidence: ["本地图文"],
    });
    tick(now, 4);
    const plan = o.snapshot(b.list(), c.tasks(), now)[0].plans.find((p: any) => p.key === "today");
    decide({
      deliveries: [{ business: "app", plan: plan.id, task: work.subject, verdict: "accept", reason: "图文交接完成" }],
    });
    const historicalBlock = c
      .tasks()
      .map((t: any) => (t.id === work.subject ? { ...t, status: "blocked", reason: "旧版发布阻塞" } : t));
    assert.notEqual(
      o.snapshot(b.list(), historicalBlock, now)[0].staff.find((s: any) => s.role === "growth").workStatus,
      "受阻",
    );
    const invalid = decide({
      directives: [{ business: "app", action: { ...action, key: "today" } }],
      staffPlans: [daily({ plan: "today" })],
    });
    assert.match(invalid.notice?.[0].text ?? "", /已关闭计划/);
    const followup = decide({
      staffPlans: [daily({ mode: "followup", plan: plan.id, focus: "核对这份图文的实际发布" })],
    });
    assert.doesNotMatch(followup.notice?.[0].text ?? "", /未执行/);
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans.filter((p: any) => p.key === "today").length, 1);
  }));

test("an overdue follow-up still wakes after midnight before CEO renews today's arrangement", () =>
  fixture(({ decide, tick }) => {
    decide({
      briefs: [{ business: "app", objective: "跟进发布" }],
      staffPlans: [daily({ mode: "followup", plan: undefined, reviewAt: "2026-11-07T02:00:00Z" })],
    });
    assert.ok(
      !tick(new Date("2026-11-07T01:00:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"),
    );
    assert.ok(
      tick(new Date("2026-11-07T02:01:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"),
    );
  }));

test("a late result cannot complete a newer daily follow-up and paused businesses do not dispatch", () =>
  fixture(({ o, b, c, decide, tick, send }) => {
    decide({
      briefs: [{ business: "app", objective: "维护" }],
      staffPlans: [daily({ mode: "followup", plan: undefined, reviewAt: "2026-11-06T03:00:00Z" })],
    });
    const due = tick(new Date("2026-11-06T03:01:00Z")).events.find(
      (e: any) => JSON.parse(e.detail).kind === "check-growth",
    );
    send("company-inbox", due.type, due.subject, JSON.parse(due.detail));
    decide(
      {
        staffPlans: [
          daily({ mode: "followup", plan: undefined, focus: "核对新的交接条件", reviewAt: "2026-11-06T04:00:00Z" }),
        ],
      },
      new Date("2026-11-06T03:10:00Z"),
    );
    send("company-growth", "company.result", due.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "旧检查结束",
      artifacts: [],
      evidence: ["旧资料"],
      inspection: { state: "idle", actions: [], reviews: [] },
    });
    tick(new Date("2026-11-06T04:01:00Z"), 4);
    assert.equal(
      o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth").daily.checkedAt,
      undefined,
    );
    b.status("app", "paused", now);
    assert.equal(tick(new Date("2026-11-06T04:02:00Z")).events?.length ?? 0, 0);
    b.status("app", "active", now);
    assert.ok(
      tick(new Date("2026-11-06T04:03:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "check-growth"),
    );
  }));

test("missing daily plans reach CEO before generic employee checks and refresh the next working day", () =>
  fixture(({ o, b, c, tick, send }) => {
    const finish = (event: any, date: string) => {
      send("company-inbox", event.type, event.subject, JSON.parse(event.detail));
      send("company-ceo", "company.result", event.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "已安排待命与复查",
        artifacts: [],
        evidence: ["当前无新增反馈"],
        executive: decision({
          briefs: [{ business: "app", objective: "维护业务" }],
          staffPlans: [
            daily({ date, mode: "standby", plan: undefined, reviewAt: date + "T10:00:00Z" }),
            daily({ date, role: "support", mode: "standby", plan: undefined, reviewAt: date + "T10:00:00Z" }),
          ],
        }),
      });
    };
    const first = tick();
    const ceo = first.events?.find((e: any) => JSON.parse(e.detail).kind === "ceo");
    assert.ok(ceo);
    assert.ok(!first.events?.some((e: any) => JSON.parse(e.detail).kind.startsWith("check-")));
    finish(ceo, "2026-11-06");
    tick(now, 4);
    const next = tick(new Date("2026-11-07T01:05:00Z"));
    assert.ok(next.events?.some((e: any) => JSON.parse(e.detail).kind === "ceo"));
    // Yesterday's uncompleted follow-up is already due; renewing the day must not discard it.
    assert.ok(next.events?.some((e: any) => JSON.parse(e.detail).kind.startsWith("check-")));
  }));

// Failure modes: deployment starts staff early; repeated ticks duplicate work; plans bypass approval,
// direction changes skip the chairman; one project consumes both employees' model allowance;
// initialization silently overwrites goals, orphan waits block onboarding, or a corrected week loses the CEO's rollover reference.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Businesses } from "../plugins/company/business.ts";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import { draftStock, permissions, weeklyGoal } from "../plugins/company/workday.ts";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
const now = new Date("2026-11-09T01:05:00Z");
const goal = (business = "app", more = {}) => ({
  business,
  role: "growth" as const,
  week: "2026-11-09",
  direction: "推广APP",
  metrics: [
    { name: "发帖", target: 4, unit: "篇" },
    { name: "涨粉", target: null, unit: "人" },
  ],
  ...more,
});
const action = (key = "write", operation = "write", kind = "content") => ({
  key,
  operation,
  kind,
  title: key,
  goal: "完成本地成果",
  acceptance: ["可打开的成果文件"],
  priority: 1,
  dueDays: 1,
  followUpDays: 3,
  measure: "真实数据",
});
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: any) => void, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "company-workday-"));
  const cfg: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    contentReview: "ceo",
    dailyPlanning: true,
    activeRoles: ["growth"],
    inspections: false,
    ceoWake: "events",
    permissions,
    workday: { enabled: true, after: "09:00", startDate: "2026-11-09" },
    ...extra,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const b = new Businesses(dir),
    c = new Company(cfg);
  let o = new Operations(dir),
    seq = 0;
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, now);
  const tick = (at = now, answers: any[] = [], depth = 1) =>
    o.plan("tick-" + ++seq, b.list(), c.tasks(), at, answers, depth);
  const decide = (d: any, at = now) =>
    o.plan("decision-" + ++seq, b.list(), c.tasks(), at, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "安排", executive: decision(d) }),
      },
    ]);
  const daily = (business = "app", at = now) => ({
    business,
    role: "growth",
    date: at.toISOString().slice(0, 10),
    goal: "推广APP",
    focus: "按周目标安排自己今日工作",
    doneWhen: "完成本地成果",
    mode: "followup",
    reviewAt: new Date(at.getTime() + 3600_000).toISOString(),
  });
  const work = (r: Receipt, kind: string) => r.events?.filter((e) => JSON.parse(e.detail).kind === kind) ?? [];
  const deliver = (e: any, actions: any[]) => {
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    send("company-growth", "company.result", e.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "今日计划",
      artifacts: [],
      evidence: ["周目标与效果资料"],
      inspection: { state: "action", actions, reviews: [] },
    });
  };
  try {
    for (const id of ["app", "other"]) {
      b.save({ id, name: id, description: "提醒", audience: "用户", objective: "推广", stage: "operating" }, now);
      b.autonomy(id, true, now);
      b.status(id, "active", now);
    }
    o.leadership(true, now);
    o.seedWeeklyGoals([goal(), goal("other", { metrics: [{ name: "发帖", target: 2, unit: "篇" }] })], now);
    fn({
      dir,
      cfg,
      b,
      c,
      get o() {
        return o;
      },
      send,
      tick,
      decide,
      daily,
      work,
      deliver,
      restart: () => {
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
test("weekly goal correction requires explicit overwrite and preserves last week's CEO reference", () =>
  fixture((f: any) => {
    const goals = [goal("app", { week: "2026-11-02" }), goal("other", { week: "2026-11-02" })];
    goals[1].metrics[0].target = 2;
    const get = () =>
      f.o
        .snapshot(f.b.list(), f.c.tasks(), now)
        .map((p: any) => p.staff.find((s: any) => s.role === "growth").weeklyGoal);
    const before = get();
    assert.throws(() => f.o.seedWeeklyGoals(goals, now), /已有周目标不能由初始化覆盖/);
    assert.deepEqual(get(), before);
    f.o.seedWeeklyGoals(goals, now, { overwrite: true });
    f.restart();
    assert.deepEqual(get(), goals);
    f.tick();
    const ceo = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/ceo.json"), "utf8"));
    assert.equal(ceo.week, "2026-11-09");
    assert.deepEqual(ceo.missingWeeklyGoals, [
      { business: "app", role: "growth" },
      { business: "other", role: "growth" },
    ]);
    assert.deepEqual(
      ceo.projects.map((p: any) => p.staff.find((s: any) => s.role === "growth").weeklyGoal),
      goals,
    );
    assert.throws(() => f.o.seedWeeklyGoals(goals, now), /已有周目标不能由初始化覆盖/);
  }));
test("workday waits for current CEO arrangement and starts once per employee even after restart", () =>
  fixture(({ dir, decide, daily, tick, work, deliver, restart, o, b, c }: any) => {
    assert.equal(work(tick(new Date("2026-11-08T06:00:00Z")), "workday-growth").length, 0);
    assert.equal(work(tick(new Date("2026-11-09T00:59:00Z")), "workday-growth").length, 0);
    const first = decide({
      briefs: [
        { business: "app", objective: "推广" },
        { business: "other", objective: "推广" },
      ],
      staffPlans: [daily(), daily("other")],
    });
    const shifts = work(first, "workday-growth");
    assert.equal(shifts.length, 2);
    assert.ok(!first.events?.some((e: any) => JSON.parse(e.detail).kind?.startsWith("check-")));
    const firstTask = shifts.find((e: any) => JSON.parse(e.detail).title.startsWith("app"));
    deliver(firstTask, [action("a"), action("b", "review")]);
    const dispatched = work(tick(), "staff-growth");
    assert.equal(dispatched.length, 1);
    const staff = JSON.parse(readFileSync(join(dir, "workspace/knowledge/staff/app/growth.json"), "utf8"));
    assert.equal(staff.weeklyGoal.metrics[0].target, 4);
    assert.equal(staff.workday.actions.length, 2);
    restart();
    assert.equal(work(tick(), "workday-growth").length, 0);
    assert.equal(work(tick(), "staff-growth").length, 0);
    // Only completion of the first work item permits the next independent model round.
    const e = dispatched[0];
    c.process(
      {
        events: [{ id: "work-create", source: "company-inbox", type: e.type, subject: e.subject, detail: e.detail }],
        answers: [],
      },
      now,
    );
    c.process(
      {
        events: [
          {
            id: "work-done",
            source: "company-growth",
            type: "company.result",
            subject: e.subject,
            detail: JSON.stringify({
              assignment: 1,
              verdict: "pass",
              summary: "已完成",
              artifacts: ["tasks/a.md"],
              evidence: ["检查文件"],
            }),
          },
        ],
        answers: [],
      },
      now,
    );
    assert.equal(work(tick(), "staff-growth").length, 1);
  }));

test("onboarding fills the CEO brief and daily structure from confirmed goals, then dispatches once", () =>
  fixture(({ tick, work, o, restart, b, c }: any) => {
    assert.equal(o.executive().briefs.app, undefined);
    assert.equal(work(tick(), "workday-growth").length, 2);
    assert.equal(o.executive().briefs.app, goal().direction);
    const staff = o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth");
    assert.ok(staff.daily.focus && staff.daily.doneWhen && staff.daily.reviewAt);
    restart();
    assert.equal(work(tick(), "workday-growth").length, 0);
  }));

test("a prose-only owner wait is cleared without inventing an answer and work starts naturally", () =>
  fixture(({ decide, daily, work, o, b, c }: any) => {
    const r = decide({
      staffPlans: [
        {
          ...daily(),
          mode: "standby",
          focus: "负责人尚未答复，明日复查",
          doneWhen: "负责人答复到达",
          reviewAt: "2026-11-10T01:30:00Z",
        },
      ],
    });
    assert.equal(work(r, "workday-growth").length, 2);
    const staff = o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth");
    assert.equal(staff.daily.waiting, undefined);
    assert.equal(staff.daily.mode, "followup");
    assert.equal(staff.waitRepairs.length, 1);
    assert.equal(o.executive().questions.length, 0);
  }));

test("a real owner wait holds work until the authenticated answer, then resumes once", () =>
  fixture(({ decide, daily, work, tick, o }: any) => {
    const early = new Date("2026-11-09T00:59:00Z");
    decide(
      { escalations: [{ key: "source", business: "app", issues: [], question: "素材在哪？", context: "资料缺失" }] },
      early,
    );
    const question = o.executive().questions[0];
    decide({ staffPlans: [{ ...daily(), mode: "standby", waiting: { kind: "owner", id: question.id } }] });
    assert.equal(work(tick(), "workday-growth").length, 0);
    const resumed = tick(now, [{ card: 11, about: `ceo:${question.id}`, choice: null, text: "素材已补齐" }]);
    assert.equal(work(resumed, "workday-growth").length, 1);
    assert.equal(o.executive().questions[0].answer, "素材已补齐");
    assert.equal(work(tick(), "workday-growth").length, 0);
  }));
test("permissions auto-approve only safe own work and refuse unsafe CEO directives", () =>
  fixture(({ decide, daily, work, deliver, tick, o, b, c }: any) => {
    const shifts = work(
      decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [daily()] }),
      "workday-growth",
    );
    deliver(shifts[0], [action("write"), action("pay", "spend", "finance"), action("code", "write", "software")]);
    tick();
    const plans = o.snapshot(b.list(), c.tasks(), now)[0].plans;
    assert.equal(plans.find((p: any) => p.key === "write").status, "working");
    assert.equal(plans.find((p: any) => p.key === "pay").status, "proposed");
    assert.equal(plans.find((p: any) => p.key === "code").status, "proposed");
    const r = decide({ directives: [{ business: "app", action: action("evil", "deploy", "software") }] });
    assert.equal(work(r, "internal-software").length, 0);
    assert.ok(!o.snapshot(b.list(), c.tasks(), now)[0].plans.some((p: any) => p.key === "evil"));
  }));
test("weekly direction requires exact chairman confirmation, metrics can change without it", () =>
  fixture(({ decide, tick, o, b, c, dir }: any) => {
    decide({ weeklyGoals: [goal("app", { metrics: [{ name: "发帖", target: 3, unit: "篇" }] })] });
    const target = goal("app", { direction: "新方向" });
    const r = decide({ weeklyGoals: [target] });
    const card = r.ask.find((a: any) => a.about.startsWith("weekly:"));
    assert.ok(card);
    const get = () => o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth").weeklyGoal;
    assert.equal(get().direction, "推广APP");
    assert.equal(get().metrics[0].target, 3);
    tick(now, [{ card: 1, about: card.about + "wrong", choice: 0 }]);
    assert.equal(get().direction, "推广APP");
    tick(now, [{ card: 2, about: card.about, choice: 1 }]);
    assert.equal(get().direction, "推广APP");
    const second = decide({ weeklyGoals: [target] }).ask.find((a: any) => a.about.startsWith("weekly:"));
    tick(now, [{ card: 3, about: second.about, choice: 0 }]);
    assert.equal(get().direction, "新方向");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "workspace/knowledge/staff/app/growth.json"), "utf8")).weeklyGoal.direction,
      "新方向",
    );
  }));
test("employee quota preserves six rounds for the other project, owner messages bypass total and tomorrow resets", () =>
  fixture(({ decide, daily, work, cfg, dir }: any) => {
    const shifts = work(
      decide({
        briefs: [
          { business: "app", objective: "推广" },
          { business: "other", objective: "推广" },
        ],
        staffPlans: [daily(), daily("other")],
      }),
      "workday-growth",
    );
    const budget = new ModelBudget(dir, { ...cfg, dailyModelRuns: { total: 20, ceo: 6, growth: 12, employee: 6 } });
    try {
      for (let i = 0; i < 6; i++) assert.ok(budget.start("growth", `a${i}`, false, now, shifts[0].subject));
      assert.equal(budget.start("growth", "over", false, now, shifts[0].subject), false);
      for (let i = 0; i < 6; i++) assert.ok(budget.start("growth", `b${i}`, false, now, shifts[1].subject));
      for (let i = 0; i < 10; i++) assert.ok(budget.start("ceo", `owner${i}`, true, now));
      assert.equal(budget.snapshot(now).total, 22);
      budget.refund("a0", new Date("2026-11-09T16:00:00Z"));
      budget.refund("a0", now);
      assert.equal(budget.snapshot(now).total, 21);
      assert.equal(budget.snapshot(now).roles.growth, 11);
      assert.equal(budget.snapshot(now).employees["app:growth"], 5);
      assert.equal(budget.snapshot(now).employees["other:growth"], 6);
      assert.equal(budget.available("ceo", now), false);
      assert.ok(budget.available("growth", new Date("2026-11-09T16:00:00Z"), shifts[0].subject));
      assert.equal(budget.available("growth", now, "unknown"), false);
    } finally {
      budget.close();
    }
  }));
test("new defaults stay off and invalid policy cannot grant employee publication", () => {
  assert.throws(() => weeklyGoal(goal("app", { week: "2026-11-10" })));
  assert.throws(() =>
    fixture(() => {}, { permissions: { ...permissions, employee: [...permissions.employee, "publish"] } }),
  );
  fixture(({ tick, work }: any) => assert.equal(work(tick(), "workday-growth").length, 0), {
    workday: undefined,
    permissions: undefined,
  });
});
test("rule upgrade publishes workday protocol idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "workday-rules-"));
  try {
    rmSync(dir, { recursive: true });
    const initial = initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(initial));
    const file = join(dir, "company.json"),
      cfg = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...cfg,
        ceoMode: true,
        dailyPlanning: true,
        permissions,
        workday: { enabled: true, after: "09:00" },
      }),
    );
    ensureBusinessRules(dir);
    const rules = readFileSync(join(dir, "hub/rules.json"), "utf8");
    assert.match(rules, /目标与自主上班 v1/);
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), rules);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("next Monday waits for renewed weekly goals and a post-09:00 CEO arrangement", () =>
  fixture(({ decide, daily, tick, work }: any) => {
    const monday = new Date("2026-11-16T01:05:00Z");
    const d = daily("app", monday);
    assert.equal(
      work(decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [d] }, monday), "workday-growth")
        .length,
      0,
    );
    assert.equal(
      work(decide({ weeklyGoals: [goal("app", { week: "2026-11-16" })] }, monday), "workday-growth").length,
      1,
    );
    assert.equal(work(tick(monday), "workday-growth").length, 0);
  }));

test("stale direction approval cannot replace a newer target or next week's goal", () =>
  fixture(({ decide, tick, o, b, c }: any) => {
    const first = decide({ weeklyGoals: [goal("app", { direction: "旧申请" })] }).ask.find((a: any) =>
      a.about.startsWith("weekly:"),
    );
    decide({ weeklyGoals: [goal("app", { direction: "新申请" })] });
    tick(now, [{ card: 20, about: first.about, choice: 0 }]);
    const get = () => o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth").weeklyGoal;
    assert.equal(get().direction, "推广APP");
    const late = decide({ weeklyGoals: [goal("app", { direction: "下周不适用" })] }).ask.find((a: any) =>
      a.about.startsWith("weekly:"),
    );
    tick(new Date("2026-11-16T01:05:00Z"), [{ card: 21, about: late.about, choice: 0 }]);
    assert.equal(get().direction, "推广APP");
  }));

test("off-duty proposals wait for explicit CEO approval and cannot wake QA by themselves", () =>
  fixture(({ decide, daily, work, deliver, tick, o, b, c }: any) => {
    const shift = work(
      decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [daily()] }),
      "workday-growth",
    )[0];
    deliver(shift, [action("finance", "data", "finance")]);
    const r = tick();
    assert.equal(work(r, "internal-finance").length, 0);
    assert.equal(work(r, "staff-growth").length, 1);
    assert.equal(work(r, "workday-qa").length, 0);
    // An employee's analysis stays with its author; only the CEO can deliberately assign finance.
    const approved = decide({ directives: [{ business: "app", action: action("finance-ceo", "data", "finance") }] });
    assert.equal(work(approved, "internal-finance").length, 1);
    assert.ok(o.snapshot(b.list(), c.tasks(), now)[0].plans.find((p: any) => p.key === "finance-ceo").ceoApproved);
  }));

test("employee daily plan reuses CEO work instead of creating a duplicate", () =>
  fixture(({ decide, daily, work, deliver, tick, o, b, c, dir }: any) => {
    const r = decide({
      briefs: [{ business: "app", objective: "推广" }],
      directives: [{ business: "app", action: action("existing") }],
      staffPlans: [daily()],
    });
    assert.equal(work(r, "internal-content").length, 0);
    deliver(work(r, "workday-growth")[0], [action("existing")]);
    assert.equal(work(tick(), "internal-content").length, 1);
    const plans = o.snapshot(b.list(), c.tasks(), now)[0].plans;
    assert.equal(plans.length, 1);
    const knowledge = JSON.parse(readFileSync(join(dir, "workspace/knowledge/staff/app/growth.json"), "utf8"));
    assert.deepEqual(knowledge.workday.actions, [plans[0].id]);
  }));

test("under-target workday must make drafts or give a reason; today's publishing cap is no excuse for silent idle", () =>
  fixture(
    ({ decide, daily, work, send, c, tick, dir }: any) => {
      const shift = work(
        decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [daily()] }),
        "workday-growth",
      )[0];
      send("company-inbox", shift.type, shift.subject, JSON.parse(shift.detail));
      send("company-growth", "company.result", shift.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "今日不制作",
        artifacts: [],
        evidence: ["发布名额用完"],
        inspection: { state: "idle", actions: [], reviews: [] },
      });
      assert.equal(c.task(shift.subject).status, "blocked");
      assert.match(c.task(shift.subject).reason, /noProductionReason/);
      const knowledge = JSON.parse(readFileSync(join(dir, "workspace/knowledge/staff/app/growth.json"), "utf8"));
      assert.equal(knowledge.draftStock.needsProduction, true);
      send("company-inbox", "company.task.retry", shift.subject, {});
      send("company-growth", "company.result", shift.subject, {
        assignment: 2,
        verdict: "pass",
        summary: "等真实产品截图",
        artifacts: [],
        evidence: ["缺少截图"],
        inspection: { state: "blocked", actions: [], reviews: [], noProductionReason: "没有真实截图，已向CEO报告" },
      });
      assert.equal(c.task(shift.subject).status, "completed");
      tick();
    },
    { workday: { enabled: true, after: "09:00", prepareDrafts: true } },
  ));

test("draft planning refuses three new articles and allows two complete local packages", () =>
  fixture(
    ({ decide, daily, work, deliver, c, send, tick }: any) => {
      const shift = work(
        decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [daily()] }),
        "workday-growth",
      )[0];
      deliver(shift, [action("one"), action("two"), action("three")]);
      assert.equal(c.task(shift.subject).status, "blocked");
      assert.match(c.task(shift.subject).reason, /最多2篇/);
      send("company-inbox", "company.task.retry", shift.subject, {});
      send("company-growth", "company.result", shift.subject, {
        assignment: 2,
        verdict: "pass",
        summary: "制作两篇完整稿",
        artifacts: [],
        evidence: ["周目标未达"],
        inspection: { state: "action", actions: [action("one", "package"), action("two", "package")], reviews: [] },
      });
      assert.equal(c.task(shift.subject).status, "completed");
      assert.equal(work(tick(), "staff-growth").length, 1, "only the first package launches");
    },
    { workday: { enabled: true, after: "09:00", prepareDrafts: true } },
  ));

test("draft stock counts actual publications this week and ready drafts, excluding research and old posts", () => {
  const make = (id: string, status: string, more = {}) =>
    ({ id, kind: "content", owner: "growth", operation: "package", status, ...more }) as any;
  const plans = [
    make("a", "observing", { publicationKey: "a" }),
    make("b", "publishing", { publicationKey: "b" }),
    make("c", "delivered"),
    make("d", "delivered", { operation: "data" }),
    make("e", "observing", { publicationKey: "e" }),
  ];
  const results = [
    { key: "a", publishedAt: "2026-11-09T02:00:00Z" },
    { key: "e", publishedAt: "2026-11-08T02:00:00Z" },
  ] as any;
  const stock = draftStock(plans, goal(), results, new Date("2026-11-09T03:00:00Z"));
  assert.equal(stock.published, 1);
  assert.equal(stock.ready, 2);
  assert.equal(stock.needsProduction, false);
  assert.equal(draftStock(plans.slice(0, 2), goal(), results, now).needsProduction, true);
});

test("weekend shifts wait until Monday and pre-09 arrangements remain in CEO's missing-plan list", () =>
  fixture((f: any) => {
    const early = new Date("2026-11-09T00:55:00Z");
    f.decide({ staffPlans: [f.daily("app", early)] }, early);
    const context = f.o.reviewContext(f.b.list(), f.c.tasks(), now);
    assert.ok(context.missingDailyPlans.some((s: any) => s.business === "app"));
    const same = f.daily("app", early);
    f.decide({ staffPlans: [same] }, now);
    assert.ok(
      !f.o.reviewContext(f.b.list(), f.c.tasks(), now).missingDailyPlans.some((s: any) => s.business === "app"),
    );
    const weekend = new Date("2026-11-14T01:05:00Z");
    const receipt = f.decide({ staffPlans: [f.daily("app", weekend)] }, weekend);
    assert.equal(f.work(receipt, "workday-growth").length, 0);
  }));

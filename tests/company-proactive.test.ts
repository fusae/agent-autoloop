// Failure modes: proactive work runs on weekends or twice after restart, fallback trusts queued work,
// one healthy business hides another's lag, quotas are bypassed, or judgments disappear from notes/reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations, type Project } from "../plugins/company/operations.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import { permissions } from "../plugins/company/workday.ts";
import { proactiveDue, ceoRanSince, weeklyProgress, proactivePrompt } from "../plugins/company/proactive.ts";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
const at = (time: string, date = "2026-11-10") => new Date(`${date}T${time}:00+08:00`);
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: any) => void, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "company-proactive-"));
  const cfg: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    ceoWake: "events",
    dailyPlanning: true,
    activeRoles: ["growth"],
    inspections: false,
    workday: { enabled: true, after: "09:00" },
    permissions,
    reporting: { enabled: true, weekly: true },
    delegation: { source: "测试授权" },
    proactiveCEO: true,
    dailyModelRuns: { ceo: 40 },
    ...extra,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const c = new Company(cfg),
    b = new Businesses(dir);
  let o = new Operations(dir),
    seq = 0;
  const send = (source: string, type: string, subject: string, data: any, now: Date) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, now);
  const tick = (now: Date, depth = 1) => o.plan("tick-" + ++seq, b.list(), c.tasks(), now, [], depth);
  const ceo = (r: Receipt) =>
    r.events?.find((e) => e.type === "company.task.create" && JSON.parse(e.detail!).kind === "ceo");
  const complete = (e: any, now: Date, more = {}) => {
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail), now);
    send(
      "company-ceo",
      "company.result",
      e.subject,
      {
        assignment: 1,
        verdict: "pass",
        summary: "经营判断",
        artifacts: [],
        evidence: ["业务账本"],
        executive: decision(more),
      },
      now,
    );
    assert.equal(c.task(e.subject)?.status, "completed", c.task(e.subject)?.reason ?? "");
    return tick(now, 2);
  };
  try {
    b.save(
      { id: "app", name: "应用", description: "提醒", audience: "用户", objective: "推广", stage: "operating" },
      at("08:00"),
    );
    b.autonomy("app", true);
    b.status("app", "active");
    o.leadership(true);
    o.seedWeeklyGoals(
      [
        {
          business: "app",
          role: "growth",
          week: "2026-11-09",
          direction: "推广",
          metrics: [{ name: "发帖", target: 0, unit: "篇" }],
        },
      ],
      at("08:00"),
    );
    fn({
      dir,
      cfg,
      c,
      b,
      tick,
      ceo,
      complete,
      send,
      get o() {
        return o;
      },
      restart() {
        o.close();
        o = new Operations(dir);
      },
    });
  } finally {
    o.close();
    c.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Beijing workday windows include 10:30/15:30; Monday strategy merges into the first morning round", () => {
  assert.equal(proactiveDue(at("10:29"), []), undefined);
  assert.equal(proactiveDue(at("10:30"), []), "review");
  assert.equal(proactiveDue(at("15:29"), [{ date: "2026-11-10", kind: "review" }]), undefined);
  assert.equal(proactiveDue(at("15:30"), []), "followup");
  assert.equal(proactiveDue(at("20:30"), []), undefined);
  assert.equal(proactiveDue(at("08:59", "2026-11-09"), []), undefined);
  assert.equal(proactiveDue(at("09:00", "2026-11-09"), []), "strategy");
  assert.equal(proactiveDue(at("09:40", "2026-11-09"), [{ date: "2026-11-09", kind: "strategy" }]), undefined);
  for (const date of ["2026-11-14", "2026-11-15"])
    for (const time of ["09:40", "10:30", "15:30"]) assert.equal(proactiveDue(at(time, date), []), undefined);
  assert.equal(proactiveDue(at("10:30"), [], "2026-11-11"), undefined);
  assert.equal(proactiveDue(at("10:30", "2026-11-11"), [{ date: "2026-11-10", kind: "review" }]), "review");
});

test("10:30 review runs once, persists through restart, and supplies real context without changing legacy defaults", () =>
  fixture((f) => {
    const initial = f.ceo(f.tick(at("10:29")));
    assert.equal(JSON.parse(initial.detail).title, "CEO · 经营管理");
    f.complete(initial, at("10:29"));
    const e = f.ceo(f.tick(at("10:30")));
    assert.equal(JSON.parse(e.detail).title, "CEO · 每日经营复盘");
    assert.match(JSON.parse(e.detail).goal, /无需动作/);
    f.restart();
    assert.equal(f.ceo(f.tick(at("10:31"))), undefined);
    f.complete(e, at("10:32"), { report: "无需动作：没有新的数据或阻塞，沿用今日计划。" });
    assert.match(f.o.notes("ceo").text, /每日经营复盘：无需动作/);
    const context = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/ceo.json"), "utf8"));
    assert.ok(context.employeeNotes.some((n: any) => n.business === "app"));
    assert.ok(Array.isArray(context.publications));
    assert.ok(Array.isArray(context.decisionHistory));
    f.restart();
    assert.equal(f.ceo(f.tick(at("11:00"))), undefined);
    assert.equal(f.o.executive().proactiveRounds.length, 1);
  }));

test("a busy CEO defers the same review instead of queuing another management task", () =>
  fixture((f) => {
    const initial = f.ceo(f.tick(at("10:29")));
    f.send("company-inbox", initial.type, initial.subject, JSON.parse(initial.detail), at("10:29"));
    assert.equal(f.ceo(f.tick(at("10:30"))), undefined);
    f.send(
      "company-ceo",
      "company.result",
      initial.subject,
      { assignment: 1, verdict: "pass", summary: "完成", evidence: ["账本"], executive: decision() },
      at("10:35"),
    );
    assert.match(JSON.parse(f.ceo(f.tick(at("10:35"))).detail).title, /每日经营复盘/);
  }));

test("fallback wakes without a post-10:30 model run even if management tasks were completed", () =>
  fixture((f) => {
    f.complete(f.ceo(f.tick(at("10:30"))), at("10:31"), { report: "无需动作：现有计划继续。" });
    const e = f.ceo(f.tick(at("15:30")));
    assert.match(JSON.parse(e.detail).title, /下午进度兜底/);
    f.complete(e, at("15:31"), { report: "无需动作：仍无新增资料。" });
    f.restart();
    assert.equal(f.ceo(f.tick(at("15:32"))), undefined);
  }));

test("fallback skips once without spending quota when a real CEO run exists and all goals are on track", () =>
  fixture((f) => {
    f.complete(f.ceo(f.tick(at("10:30"))), at("10:31"), { report: "无需动作：现有计划继续。" });
    const budget = new ModelBudget(f.dir, f.cfg);
    try {
      budget.start("ceo", "owner-conversation", true, at("11:00"));
      assert.equal(f.ceo(f.tick(at("15:30"))), undefined);
      assert.match(f.o.executive().proactiveRounds.at(-1).conclusion, /已跳过/);
      f.restart();
      assert.equal(f.ceo(f.tick(at("15:31"))), undefined);
      assert.equal(budget.snapshot(at("15:31")).roles.ceo, 1);
    } finally {
      budget.close();
    }
  }));

test("any lagging business wakes fallback despite a recent CEO model run", () =>
  fixture((f) => {
    f.complete(f.ceo(f.tick(at("10:30"))), at("10:31"), { report: "无需动作：等待已派工作。" });
    f.o.seedWeeklyGoals(
      [
        {
          business: "app",
          role: "growth",
          week: "2026-11-09",
          direction: "推广",
          metrics: [{ name: "发帖", target: 5, unit: "篇" }],
        },
      ],
      at("11:00"),
      { overwrite: true },
    );
    const budget = new ModelBudget(f.dir, f.cfg);
    try {
      budget.start("ceo", "review", false, at("10:30"));
      assert.match(JSON.parse(f.ceo(f.tick(at("15:30"))).detail).title, /下午进度兜底/);
    } finally {
      budget.close();
    }
  }));

test("actual CEO activity excludes refunded launches, other roles and earlier/future dates", () =>
  fixture((f) => {
    const budget = new ModelBudget(f.dir, f.cfg),
      since = at("10:30").toISOString();
    try {
      budget.start("ceo", "early", false, at("10:29"));
      budget.start("growth", "employee", false, at("11:00"));
      budget.start("ceo", "failed-before-model", false, at("11:00"));
      budget.refund("failed-before-model", at("11:01"));
      budget.start("ceo", "tomorrow", false, at("11:00", "2026-11-11"));
      assert.equal(ceoRanSince(f.dir, since, at("15:30")), false);
      budget.start("ceo", "actual", false, at("10:30"));
      assert.equal(ceoRanSince(f.dir, since, at("15:30")), true);
    } finally {
      budget.close();
    }
  }));

test("weekly linear progress counts only this week's published receipts, never drafts or another business", () => {
  const project = (business: string, keys: string[], target: number | null) =>
    ({
      business,
      plans: keys.map((publicationKey) => ({ publicationKey, owner: "growth", status: "delivered" })),
      staff: [{ role: "growth", weeklyGoal: { week: "2026-11-09", metrics: [{ name: "发帖", unit: "篇", target }] } }],
    }) as Project;
  const results = ["a", "a", "b", "other"].map((key) => ({
    key,
    publishedAt: at("10:00", "2026-11-09").toISOString(),
    channel: "test",
    url: "",
    remoteId: key,
  }));
  results.push({ ...results[0], key: "old", publishedAt: at("10:00", "2026-11-08").toISOString() });
  const rows = weeklyProgress(
    [
      project("ahead", ["a", "b", "old", "draft"], 5),
      project("behind", ["c"], 5),
      project("paused", [], 0),
      project("observe", [], null),
    ],
    results,
    at("15:30"),
  );
  assert.deepEqual(
    rows.map((r) => [r.business, r.actual, r.expected, r.behind]),
    [
      ["ahead", 2, 2, false],
      ["behind", 0, 2, true],
    ],
  );
  assert.equal(weeklyProgress([project("ahead", ["a", "b"], 5)], results, at("15:30", "2026-11-13"))[0].expected, 5);
  const unknown = project("unknown", [], 10);
  unknown.staff[0].weeklyGoal!.metrics[0].unit = "人";
  const missing = weeklyProgress([unknown], results, at("15:30"))[0];
  assert.equal(missing.actual, null);
  assert.equal(missing.behind, false);
});

test("registered proactive tasks share the CEO 40-run limit without the evening-report exemption", () =>
  fixture((f) => {
    const budget = new ModelBudget(f.dir, f.cfg),
      monday = "2026-11-09";
    f.o.seedWeeklyGoals(
      [
        {
          business: "app",
          role: "growth",
          week: monday,
          direction: "推广",
          metrics: [{ name: "发帖", target: 5, unit: "篇" }],
        },
      ],
      at("08:00", monday),
      { overwrite: true },
    );
    try {
      for (let i = 0; i < 37; i++) assert.equal(budget.start("ceo", `ordinary-${i}`, false, at("08:00", monday)), true);
      for (const [kind, time] of [
        ["strategy", "09:00"],
        ["review", "10:30"],
        ["followup", "15:30"],
      ]) {
        const now = at(time, monday),
          e = f.ceo(f.tick(now));
        assert.equal(e.subject, `CEO-${monday}-${kind}`);
        f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail), now);
        assert.equal(f.c.task(e.subject).status, "active");
        assert.equal(budget.start("ceo", e.subject, false, now, e.subject), true);
        f.send(
          "company-ceo",
          "company.result",
          e.subject,
          {
            assignment: 1,
            verdict: "pass",
            summary: "经营判断",
            evidence: ["账本"],
            executive: decision({ report: "无需动作：已有工作继续。" }),
          },
          now,
        );
        f.tick(now, 2);
      }
      assert.equal(budget.snapshot(at("15:30", monday)).roles.ceo, 40);
      assert.equal(budget.start("ceo", "over-limit", false, at("15:30", monday), `CEO-${monday}-followup`), false);
    } finally {
      budget.close();
    }
  }));

test("quota-exhausted proactive work stays queued today and expires tomorrow without consuming a new day's quota", () =>
  fixture((f) => {
    const budget = new ModelBudget(f.dir, f.cfg);
    try {
      for (let i = 0; i < 40; i++) budget.start("ceo", `ordinary-${i}`, false, at("09:00"));
      const e = f.ceo(f.tick(at("10:30")));
      f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail), at("10:30"));
      assert.equal(f.c.task(e.subject).status, "queued");
      assert.equal(f.c.task(e.subject).assignment, 0);
      const tomorrow = at("10:30", "2026-11-11");
      assert.equal(budget.start("ceo", "late-model", false, tomorrow, e.subject), false);
      f.send("company-inbox", "company.task.resume", e.subject, {}, tomorrow);
      assert.equal(f.c.task(e.subject).status, "blocked");
      assert.match(f.c.task(e.subject).reason, /已跨日/);
      assert.equal(budget.snapshot(tomorrow).roles.ceo ?? 0, 0);
      const next = f.ceo(f.tick(tomorrow));
      assert.equal(next.subject, "CEO-2026-11-11-review");
    } finally {
      budget.close();
    }
  }));

test("Monday strategy is saved in notes and the Monday report's 今日经营判断; no-action results do not spin", () =>
  fixture((f) => {
    const monday = "2026-11-09";
    const e = f.ceo(f.tick(at("09:00", monday)));
    assert.match(JSON.parse(e.detail).title, /本周打法/);
    f.complete(e, at("09:05", monday), {
      report: "上周有效的是具体使用场景，无效的是功能罗列；本周继续场景选题。无需动作：已有任务覆盖本周打法。",
    });
    f.restart();
    assert.equal(f.ceo(f.tick(at("09:40", monday))), undefined);
    const report = f.ceo(f.tick(at("21:00", monday)));
    const receipt = f.complete(report, at("21:01", monday), { report: "今日工作已汇总。" });
    const notice = receipt.notice.find((n: any) => /日报|周报/.test(n.title));
    assert.match(notice.text, /今日经营判断\n本周打法：上周有效/);
    assert.match(f.o.notes("ceo").text, /本周打法：上周有效/);
    assert.equal(f.tick(at("21:02", monday)).notice?.length ?? 0, 0);
  }));

test("proactive conclusion is mandatory and legacy configuration keeps existing behavior", () => {
  fixture((f) => {
    const e = f.ceo(f.tick(at("10:30")));
    f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail), at("10:30"));
    f.send(
      "company-ceo",
      "company.result",
      e.subject,
      { assignment: 1, verdict: "pass", summary: "缺少结论", evidence: ["账本"], executive: decision() },
      at("10:31"),
    );
    assert.notEqual(f.c.task(e.subject).status, "completed");
    assert.match(f.c.task(e.subject).reason, /经营结论/);
  });
  fixture(
    (f) => {
      const e = f.ceo(f.tick(at("10:30")));
      assert.equal(JSON.parse(e.detail).title, "CEO · 经营管理");
      assert.equal(f.o.executive().proactiveRounds, undefined);
    },
    { proactiveCEO: false },
  );
});

test("trusted rules refresh proactive instructions idempotently and preserve the spending channel", () => {
  const root = mkdtempSync(join(tmpdir(), "proactive-rules-"));
  const dir = join(root, "company");
  try {
    initialize(dir, "test");
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), readFileSync(join(dir, "rules.company.json")));
    const file = join(dir, "company.json"),
      cfg = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(cfg, {
      proactiveCEO: true,
      ceoMode: true,
      dailyPlanning: true,
      delegation: { source: "测试授权" },
      reporting: { enabled: true },
      workday: { enabled: true, after: "09:00" },
      permissions,
    });
    writeFileSync(file, JSON.stringify(cfg));
    ensureBusinessRules(dir);
    ensureBusinessRules(dir);
    const rules = JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8"));
    const prompt = rules.rules.find((r: any) => r.name === "公司部门-ceo").prompt;
    assert.equal(prompt.split("CEO主动经营规范 v1").length, 2);
    assert.ok(prompt.includes(proactivePrompt));
    assert.match(prompt, /escalations.category=spend/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("long Monday judgments survive the report's 4000-character transport limit", () =>
  fixture((f) => {
    const monday = "2026-11-09";
    for (const [i, time] of ["09:00", "10:30", "15:30"].entries()) {
      const e = f.ceo(f.tick(at(time, monday)));
      f.complete(e, at(time, monday), {
        report: String(i).repeat(500),
        ...(i === 0
          ? {
              escalations: [
                {
                  business: "app",
                  key: "maintenance",
                  issues: [],
                  question: "问题".repeat(300),
                  context: "资料".repeat(150),
                },
              ],
            }
          : {}),
      });
    }
    const report = f.ceo(f.tick(at("21:00", monday)));
    const receipt = f.complete(report, at("21:01", monday), { report: "日报".repeat(900) });
    const notice = receipt.notice.find((n: any) => /日报|周报/.test(n.title));
    assert.ok(notice.text.length <= 4000);
    assert.match(notice.text, /今日经营判断/);
    for (const i of [0, 1, 2]) assert.ok(notice.text.includes(String(i).repeat(500)));
  }));

test("efficient scheduling batches across restart, consumes its own decisions and skips proactive work without new facts", () =>
  fixture(
    (f) => {
      assert.equal(f.ceo(f.tick(at("10:00"))), undefined);
      assert.equal(f.ceo(f.tick(at("10:04"))), undefined);
      f.restart();
      const first = f.ceo(f.tick(at("10:05")));
      assert.ok(first);
      f.complete(first, at("10:06"));
      assert.equal(f.ceo(f.tick(at("10:10"))), undefined);
      assert.equal(f.ceo(f.tick(at("10:30"))), undefined);
      assert.match(f.o.executive().proactiveRounds[0].conclusion, /没有新信息/);
      assert.equal(f.ceo(f.tick(at("15:30"))), undefined);
      assert.equal(f.o.executive().runs.length, 1);
    },
    { ceoEfficiency: true },
  ));

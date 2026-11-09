// Failure modes: daily close launches employee models, cards suppress the CEO report, restarts duplicate it,
// Monday loses last week's goals, exhausted quotas block registered reports, or defaults change silently.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Businesses } from "../plugins/company/business.ts";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import { dailyReport } from "../plugins/company/reporting.ts";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
const afternoon = new Date("2026-11-08T05:00:00Z");
const close = new Date("2026-11-08T12:30:00Z");
const evening = new Date("2026-11-08T13:00:00Z");
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: any) => void, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "company-reporting-"));
  const cfg: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    activeRoles: ["growth"],
    inspections: false,
    ceoWake: "events",
    reporting: { enabled: true },
    ...extra,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const c = new Company(cfg),
    b = new Businesses(dir);
  let o = new Operations(dir),
    seq = 0;
  const tick = (at = afternoon) => o.plan("tick-" + ++seq, b.list(), c.tasks(), at);
  const send = (source: string, type: string, subject: string, data: any, at = afternoon) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, at);
  const work = (r: Receipt) => r.events?.filter((e) => e.subject.startsWith("REPORT-")) ?? [];
  try {
    b.save(
      { id: "app", name: "APP", description: "提醒", audience: "用户", objective: "推广", stage: "operating" },
      afternoon,
    );
    b.autonomy("app", true, afternoon);
    b.status("app", "active", afternoon);
    o.leadership(true);
    fn({
      dir,
      cfg,
      c,
      b,
      tick,
      send,
      work,
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
test("20:30 records no work without a new model; 21:00 queues exactly one CEO report, even behind queued management", () =>
  fixture((f: any) => {
    f.tick();
    assert.equal(f.work(f.tick(new Date("2026-11-08T12:29:00Z"))).length, 0);
    const closing = f.tick(close);
    assert.equal(closing.events?.length ?? 0, 0);
    const staff = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/staff/app/growth.json"), "utf8"));
    assert.equal(staff.reports[0].summary, "今日无工作");
    const r = f.tick(evening),
      report = f.work(r)[0];
    assert.equal(f.work(r).length, 1);
    assert.equal(JSON.parse(report.detail).title, "CEO · 日报");
    f.restart();
    assert.equal(f.work(f.tick(evening)).length, 0);
    assert.equal(f.work(f.tick(new Date("2026-11-08T15:59:00Z"))).length, 0);
  }));
test("CEO report and a decision card are delivered separately once; Monday uses a weekly report", () =>
  fixture((f: any) => {
    f.tick(close);
    const e = f.work(f.tick(evening))[0];
    f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail), evening);
    const issue = f.o.executive().issues[0];
    f.send(
      "company-ceo",
      "company.result",
      e.subject,
      {
        assignment: 1,
        verdict: "pass",
        summary: "今日汇总",
        evidence: ["员工日报及效果资料"],
        executive: decision({
          report: "各员工今日无工作；发布与效果未知；周目标待补；明日按目标准备；风险是资料缺失。",
          escalations: [{ key: "missing", issues: [issue.id], question: "请补充目标", context: "资料缺失" }],
        }),
      },
      evening,
    );
    const result = f.tick(evening);
    assert.equal(result.notice.filter((n: any) => n.title === "CEO · 日报").length, 1);
    assert.equal(result.ask.length, 1);
    f.restart();
    assert.equal(f.tick(evening).notice?.length ?? 0, 0);
    const monday = f.work(f.tick(new Date("2026-11-09T13:00:00Z")))[0];
    assert.equal(JSON.parse(monday.detail).title, "CEO · 周报");
    assert.match(JSON.parse(monday.detail).goal, /上周目标达成/);
    const inputs = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/reporting.json"), "utf8"));
    assert.equal(inputs.weekly, true);
    assert.equal(inputs.projects[0].staff[0].reports.length, 2);
  }));
test("work results carry four daily fields and later work updates the same day's record", () =>
  fixture((f: any) => {
    const at = afternoon;
    const event = {
      id: "owner",
      source: "company-ceo",
      type: "company.ceo.decision",
      subject: "owner",
      detail: JSON.stringify({
        summary: "安排",
        executive: decision({
          briefs: [{ business: "app", objective: "推广" }],
          directives: [
            {
              business: "app",
              action: {
                key: "draft",
                operation: "write",
                kind: "content",
                title: "写稿",
                goal: "写稿",
                acceptance: ["完整稿件"],
                priority: 1,
                dueDays: 1,
                followUpDays: 3,
                measure: "发布",
              },
            },
          ],
        }),
      }),
    };
    const r = f.o.plan("work", f.b.list(), f.c.tasks(), at, [], 1, [event]);
    const work = r.events.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    f.send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    const fields = { done: "完成写稿", result: "已交一篇", blockers: "无", tomorrow: "核对数据" };
    f.send("company-growth", "company.result", work.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "写稿结束",
      artifacts: ["draft.md"],
      evidence: ["文件完整"],
      dailyReport: fields,
    });
    f.tick();
    const get = () =>
      JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/staff/app/growth.json"), "utf8")).reports;
    assert.deepEqual(get()[0].entries[0].report, fields);
    f.tick(close);
    f.restart();
    f.tick(close);
    assert.equal(get().length, 1);
    assert.equal(get()[0].entries.length, 1);
    assert.throws(() => dailyReport({ ...fields, tomorrow: "" }));
  }));
test("registered daily and weekly reports dispatch beyond exhausted quotas; owner bypass stays counted", () =>
  fixture((f: any) => {
    const cfg = { ...f.cfg, dailyModelRuns: { total: 1, ceo: 1 } };
    const office = new Company(cfg);
    const budget = new ModelBudget(f.dir, cfg);
    try {
      assert.ok(budget.start("ceo", "regular", false, afternoon));
      assert.equal(budget.start("growth", "over-limit", false, afternoon), false);
      assert.equal(budget.available("ceo", evening, "REPORT-2026-11-08"), false, "prefix is not authorization");
      assert.ok(budget.start("ceo", "owner", true, evening));
      for (const at of [evening, new Date("2026-11-09T13:00:00Z")]) {
        budget.start("ceo", "owner-" + at.toISOString(), true, at);
        const report = f.work(f.tick(at))[0];
        const dispatched = office.process(
          { events: [{ ...report, id: 99, source: "company-inbox" }], answers: [] },
          at,
        );
        assert.ok(dispatched.events?.some((e: any) => e.type === "company.work.ceo"));
        assert.ok(budget.start("ceo", "report-" + report.subject, false, at, report.subject));
        assert.ok(budget.start("ceo", "repair-" + report.subject, false, at, report.subject));
        assert.equal(budget.available("ceo", at), false);
        assert.equal(budget.available("ceo", new Date(at.getTime() + 86400_000), report.subject), false);
      }
      assert.equal(budget.snapshot(evening).roles.ceo, 5);
    } finally {
      budget.close();
      office.close();
    }
  }));
test("disabled reporting keeps old scheduling and no extra report data", () =>
  fixture(
    (f: any) => {
      assert.equal(f.work(f.tick(evening)).length, 0);
      assert.equal(f.o.snapshot(f.b.list(), f.c.tasks(), evening)[0].reporting, null);
    },
    { reporting: undefined },
  ));
test("reporting, draft and preview prompts upgrade idempotently and can be disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-reporting-rules-"));
  try {
    rmSync(dir, { recursive: true });
    initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), readFileSync(join(dir, "rules.company.json")));
    const file = join(dir, "company.json"),
      cfg = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(cfg, {
      ceoMode: true,
      reporting: { enabled: true },
      publishApproval: { confirmFirst: 5, preview: true },
      workday: { enabled: true, after: "09:00", prepareDrafts: true },
    });
    writeFileSync(file, JSON.stringify(cfg));
    ensureBusinessRules(dir);
    const first = readFileSync(join(dir, "hub/rules.json"), "utf8");
    assert.match(first, /汇报节奏 v1/);
    assert.match(first, /不受CEO和总额度阻挡/);
    assert.doesNotMatch(first, /最后一次为日报保留/);
    assert.match(first, /inspection.noProductionReason/);
    assert.match(first, /发布预告 v1/);
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), first);
    delete cfg.reporting;
    delete cfg.workday;
    delete cfg.publishApproval;
    writeFileSync(file, JSON.stringify(cfg));
    ensureBusinessRules(dir);
    assert.doesNotMatch(readFileSync(join(dir, "hub/rules.json"), "utf8"), /汇报节奏 v1|提前备稿 v1|发布预告 v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health mode queues the same daily report at 20:30 and appends verified incident history once", () =>
  fixture(
    (f: any) => {
      const start = new Date("2026-11-09T12:30:00Z");
      const r = f.tick(start),
        e = f.work(r)[0];
      assert.ok(e);
      const inputs = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/reporting.json"), "utf8"));
      assert.match(inputs.health, /今天 CEO 发现并处理的问题/);
      f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail), start);
      f.send(
        "company-ceo",
        "company.result",
        e.subject,
        {
          assignment: 1,
          verdict: "pass",
          summary: "汇报完成",
          artifacts: [],
          evidence: ["读取资料"],
          executive: decision({ report: "今日已核对员工工作，目标待补齐。" }),
        },
        start,
      );
      const result = f.tick(new Date(+start + 60000));
      const report = result.notice.find((n: any) => /日报|周报/.test(n.title));
      assert.match(report.text, /今天 CEO 发现并处理的问题/);
      assert.match(report.text, /缺少本周目标/);
      f.restart();
      assert.equal(f.work(f.tick(new Date(+start + 16 * 60000))).length, 0);
    },
    { health: { enabled: true } },
  ));

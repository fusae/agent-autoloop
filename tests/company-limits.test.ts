// Failure modes: inactive staff cause model churn, identical follow-ups run twice, budgets lose retries on restart,
// concurrent model launches exceed a daily cap, owner messages are suppressed, or superseded publishing looks successful.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company, type CompanyConfig } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import { parseRules } from "../protocol/rules.ts";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
const now = new Date("2026-11-07T02:00:00Z");
const empty = { briefs: [], directives: [], approvals: [], answers: [], escalations: [] };
function fixture(patch: Partial<CompanyConfig>, fn: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "company-limits-"));
  const cfg = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 12,
    ceoMode: true,
    dailyPlanning: true,
    ...patch,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const c = new Company(cfg),
    b = new Businesses(dir),
    o = new Operations(dir);
  let seq = 0;
  const send = (source: string, type: string, subject: string, data: any, at = now) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, at);
  const tick = (at = now, events: any[] = [], answers: any[] = []) =>
    o.plan("tick-" + ++seq, b.list(), c.tasks(), at, answers, 1, events);
  const decide = (d: any) =>
    tick(now, [
      {
        id: ++seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "工作安排", executive: { ...empty, ...d } }),
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
    fn({ dir, cfg, c, b, o, send, tick, decide });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const request = { title: "具体修复", kind: "internal-software", goal: "修复已确认的问题", acceptance: ["验证修复"] };
const daily = (more = {}) => ({
  business: "app",
  role: "growth",
  date: "2026-11-07",
  goal: "跟进发布",
  focus: "核对发布记录",
  doneWhen: "记录真实结果",
  mode: "followup",
  reviewAt: "2026-11-09T02:30:00Z",
  ...more,
});
test("active roles only narrow recurring duties; explicit software still reaches inactive departments", () =>
  fixture({ activeRoles: ["growth"] }, ({ tick, dir, send }) => {
    tick();
    const context = JSON.parse(readFileSync(join(dir, "workspace/knowledge/ceo.json"), "utf8"));
    assert.deepEqual(
      context.missingDailyPlans.map((s: any) => s.role),
      ["growth"],
    );
    assert.equal(send("company-inbox", "company.task.create", "fix", request).events[0].type, "company.work.product");
  }));
test("inspections off produces no check tasks, including overdue daily follow-ups", () =>
  fixture({ inspections: false }, ({ decide, tick }) => {
    decide({ briefs: [{ business: "app", objective: "推广" }], staffPlans: [daily()] });
    const r = tick(new Date("2026-11-09T03:00:00Z"));
    assert.ok(!r.events?.some((e: any) => JSON.parse(e.detail).kind?.startsWith("check-")));
  }));
test("events CEO ignores metrics, due follow-ups and half-hour polling, wakes at 09:00 and staff delivery", () =>
  fixture({ activeRoles: ["growth"], inspections: false, ceoWake: "events" }, ({ tick, send, c, b, o }) => {
    const run = tick().events.find((e: any) => JSON.parse(e.detail).kind === "ceo");
    assert.ok(run);
    send("company-inbox", run.type, run.subject, JSON.parse(run.detail));
    send("company-ceo", "company.result", run.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "暂无新工作",
      artifacts: [],
      evidence: ["项目记录"],
      executive: empty,
    });
    tick();
    for (const at of ["2026-11-07T02:40:00Z", "2026-11-08T00:59:00Z"])
      assert.ok(!tick(new Date(at)).events?.some((e: any) => JSON.parse(e.detail).kind === "ceo"));
    assert.equal(o.executive().nextReviewAt, undefined);
    assert.ok(tick(new Date("2026-11-08T01:00:00Z")).events?.some((e: any) => JSON.parse(e.detail).kind === "ceo"));
  }));
test("follow-up work follow-up roundtrip collapses same time with changed wording through normal tick", () =>
  fixture({}, ({ decide, o, b, c, tick }) => {
    decide({ staffPlans: [daily()] });
    const action = {
      key: "next",
      title: "新图文",
      kind: "content",
      goal: "写新图文",
      acceptance: ["有正文"],
      priority: 1,
      dueDays: 1,
      followUpDays: 3,
      measure: "阅读",
    };
    decide({ directives: [{ business: "app", action }], staffPlans: [daily({ mode: "work", plan: "next" })] });
    decide({ staffPlans: [daily({ focus: "再次核对同一发布记录" })] });
    tick();
    const s = o.snapshot(b.list(), c.tasks(), now)[0].staff.find((s: any) => s.role === "growth");
    assert.equal(s.followups?.length ?? 0, 0);
    assert.equal(Date.parse(s.daily.reviewAt), Date.parse(daily().reviewAt));
  }));
test("model ledger counts every launch and repair, survives restart, exempts owner and resets at Beijing midnight", () =>
  fixture({ dailyModelRuns: { total: 2, ceo: 1, growth: 1 } }, ({ dir, cfg }) => {
    let budget = new ModelBudget(dir, cfg);
    assert.equal(budget.start("growth", "run-1", false, now), true);
    assert.equal(budget.start("growth", "run-2", false, now), false);
    assert.equal(budget.start("ceo", "run-3", false, now), true);
    assert.equal(budget.start("product", "repair-1", false, now), false);
    assert.equal(budget.start("ceo", "owner-1", true, now), true);
    budget.close();
    budget = new ModelBudget(dir, cfg);
    assert.equal(budget.snapshot(now).total, 3);
    assert.equal(budget.snapshot(now).roles.ceo, 2);
    assert.equal(budget.start("growth", "tomorrow", false, new Date("2026-11-07T16:00:00Z")), true);
    assert.equal(budget.snapshot(new Date("2026-11-07T16:00:00Z")).total, 1);
    budget.close();
  }));
test("capped handoffs queue without losing reports, resume tomorrow once, fixed publication is free", () =>
  fixture({ dailyModelRuns: { total: 1 } }, ({ dir, cfg, c, send }) => {
    const budget = new ModelBudget(dir, cfg);
    budget.start("product", "already", false, now);
    budget.close();
    assert.ok(!send("company-inbox", "company.task.create", "fix", request).events?.length);
    assert.equal(c.task("fix").status, "queued");
    assert.ok(!send("company-inbox", "company.task.resume", "fix", {}).events?.length);
    const at = new Date("2026-11-07T16:00:00Z");
    assert.equal(send("company-inbox", "company.task.resume", "fix", {}, at).events[0].type, "company.work.product");
    assert.ok(!send("company-inbox", "company.task.resume", "fix", {}, at).events?.length);
    assert.equal(
      send("company-inbox", "company.task.create", "publish", {
        ...request,
        kind: "publish-content",
        publication: "a".repeat(32),
      }).events[0].type,
      "company.work.publish",
    );
  }));
test("supersede is owner-only, requires blocked work, records reason and never invents publication", () =>
  fixture({}, ({ send, c }) => {
    send("company-inbox", "company.task.create", "old", {
      ...request,
      kind: "publish-content",
      publication: "a".repeat(32),
    });
    send("company-growth", "company.result", "old", {
      assignment: 1,
      verdict: "blocked",
      summary: "缺发布渠道",
      artifacts: [],
      evidence: ["配置未启用"],
    });
    send("company-inbox", "company.task.supersede", "old", { reason: "已由新的完整图文交接取代" });
    assert.equal(c.task("old").status, "blocked");
    send("company-owner", "company.task.supersede", "old", { reason: "已由新的完整图文交接取代" });
    assert.equal(c.task("old").status, "superseded");
    assert.equal(c.task("old").reports.length, 1);
    assert.equal(c.task("old").reports[0].publication, undefined);
    assert.match(c.history("old").at(-1).body, /已由新的完整图文交接取代/);
    assert.ok(!send("company-inbox", "company.task.retry", "old", {}).events?.length);
  }));

test("event mode wakes on a new employee blocker, never on its retry or an idle inspection", () =>
  fixture({ inspections: false, ceoWake: "events", contentReview: "ceo" }, ({ decide, tick, send, c }) => {
    const action = {
      key: "post",
      title: "图文",
      kind: "content",
      goal: "交付图文",
      acceptance: ["正文"],
      priority: 1,
      dueDays: 1,
      followUpDays: 3,
      measure: "阅读",
    };
    const r = decide({ briefs: [{ business: "app", objective: "推广" }], directives: [{ business: "app", action }] });
    const work = r.events.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    const ceo = r.events.find((e: any) => JSON.parse(e.detail).kind === "ceo");
    send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    send("company-inbox", ceo.type, ceo.subject, JSON.parse(ceo.detail));
    const finish = (e: any) =>
      send("company-ceo", "company.result", e.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "已处理",
        evidence: ["记录"],
        artifacts: [],
        executive: empty,
      });
    finish(ceo);
    tick();
    send("company-growth", "company.result", work.subject, {
      assignment: 1,
      verdict: "blocked",
      summary: "缺具体素材",
      artifacts: [],
      evidence: ["已有素材"],
    });
    const next = tick().events.find((e: any) => JSON.parse(e.detail).kind === "ceo");
    assert.ok(next);
    send("company-inbox", next.type, next.subject, JSON.parse(next.detail));
    finish(next);
    tick();
    send("company-inbox", "company.task.retry", work.subject, {});
    assert.ok(!tick().events?.some((e: any) => JSON.parse(e.detail).kind === "ceo"));
  }));

test("limit configuration upgrades and restores model rules without changing model, access or workers", () => {
  const root = mkdtempSync(join(tmpdir(), "company-upgrade-")),
    dir = join(root, "company");
  try {
    initialize(dir);
    mkdirSync(join(dir, "hub"));
    const rules = JSON.parse(readFileSync(join(dir, "rules.company.json"), "utf8"));
    rules.agents["company-growth"].model = "chosen-model";
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    const file = join(dir, "company.json"),
      config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...config, dailyModelRuns: { total: 20 } }));
    ensureBusinessRules(dir);
    ensureBusinessRules(dir);
    let updated = JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8"));
    assert.doesNotThrow(() => parseRules(JSON.stringify(updated), now.getTime(), "Asia/Shanghai"));
    assert.equal(updated.agents["company-growth"].use, "company");
    assert.deepEqual(updated.agents["company-growth"].command, [file, "model", "growth", "codex"]);
    assert.equal(updated.agents["company-growth"].model, "chosen-model");
    assert.equal(updated.rules.filter((r: any) => r.name === "公司调度-owner").length, 1);
    assert.ok(
      updated.rules.find((r: any) => r.name === "公司调度-growth").when.types.includes("company.model.deferred"),
    );
    writeFileSync(file, JSON.stringify(config));
    ensureBusinessRules(dir);
    updated = JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8"));
    assert.equal(updated.agents["company-growth"].use, "codex");
    assert.equal(updated.agents["company-growth"].command, undefined);
    updated.agents["company-growth"].use = "command";
    updated.agents["company-growth"].command = ["custom-model"];
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(updated));
    writeFileSync(file, JSON.stringify({ ...config, dailyModelRuns: { total: 20 } }));
    assert.throws(() => ensureBusinessRules(dir), /Codex.*Claude/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("superseding blocked work closes its plan on the normal journaled tick", () =>
  fixture({ inspections: false }, ({ decide, send, tick, o, b, c }) => {
    const action = {
      key: "old",
      title: "旧分支",
      kind: "content",
      goal: "制作旧图文",
      acceptance: ["正文"],
      priority: 1,
      dueDays: 1,
      followUpDays: 3,
      measure: "阅读",
    };
    const receipt = decide({
      briefs: [{ business: "app", objective: "推广" }],
      directives: [{ business: "app", action }],
    });
    const work = receipt.events.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    send("company-growth", "company.result", work.subject, {
      assignment: 1,
      verdict: "blocked",
      summary: "旧分支等待渠道",
      evidence: ["当前配置"],
      artifacts: [],
    });
    tick();
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans[0].status, "blocked");
    send("company-owner", "company.task.supersede", work.subject, { reason: "已由新图文交接取代" });
    tick();
    const plan = o.snapshot(b.list(), c.tasks(), now)[0].plans[0];
    assert.equal(plan.status, "closed");
    assert.match(plan.result, /已由新图文交接取代/);
    assert.equal(plan.deliveredAt, null);
  }));

test("a capped CEO keeps its task but refreshes planning context before tomorrow's resume", () =>
  fixture({ dailyModelRuns: { total: 0 }, ceoWake: "events", inspections: false }, ({ tick, send, c, dir }) => {
    const event = tick().events.find((e: any) => JSON.parse(e.detail).kind === "ceo");
    send("company-inbox", event.type, event.subject, JSON.parse(event.detail));
    assert.equal(c.task(event.subject).status, "queued");
    const next = tick(new Date("2026-11-07T16:05:00Z"));
    assert.ok(!next.events?.some((e: any) => JSON.parse(e.detail).kind === "ceo"));
    const context = JSON.parse(readFileSync(join(dir, "workspace/knowledge/ceo.json"), "utf8"));
    assert.equal(context.planningDate, "2026-11-08");
  }));

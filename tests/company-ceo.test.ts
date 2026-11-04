// Failure modes: employees bypass the CEO, CEO decisions execute twice, owner answers are lost,
// cross-project instructions leak, or a question blocks unrelated employee work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company, type Context } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";
const now = new Date("2026-11-05T02:00:00Z");
const action = {
  key: "guide",
  title: "首次使用说明",
  kind: "content",
  goal: "整理本地说明",
  acceptance: ["有产品依据"],
  priority: 1,
  dueDays: 2,
  followUpDays: 3,
  measure: "首次使用人数",
};
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(
  fn: (
    b: Businesses,
    o: Operations,
    c: Company,
    send: (source: string, type: string, id: string, data: unknown) => any,
  ) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "company-ceo-")),
    b = new Businesses(dir),
    o = new Operations(dir),
    c = new Company({ name: "test", database: join(dir, "company.db"), maxAssignments: 6, ceoMode: true });
  let seq = 0;
  const send = (source: string, type: string, id: string, data: unknown) =>
    c.process({
      events: [{ id: ++seq, source, type, subject: id, detail: JSON.stringify(data) }],
      answers: [],
    } as Context);
  try {
    b.save(
      { id: "app", name: "APP", description: "提醒", audience: "测试", objective: "提升使用", stage: "operating" },
      now,
    );
    b.autonomy("app", true, now);
    b.status("app", "active", now);
    o.leadership(true, now);
    fn(b, o, c, send);
  } finally {
    c.close();
    o.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("CEO starts first, sets objectives, reviews employee proposals, and receives their blockers without owner cards", () =>
  fixture((b, o, c, send) => {
    const first = o.plan("a", b.list(), c.tasks(), now);
    assert.equal(first.events?.length, 1);
    const e = first.events![0];
    assert.equal(JSON.parse(e.detail).kind, "ceo");
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    const report = {
      assignment: 1,
      verdict: "pass",
      summary: "先核对入口",
      artifacts: [],
      evidence: ["产品档案"],
      executive: decision({
        briefs: [{ business: "app", objective: "确认现状和入口问题" }],
        directives: [{ business: "app", action }],
      }),
    };
    const result = send("company-ceo", "company.result", e.subject, report);
    assert.equal(result.ask, undefined);
    assert.equal(c.task(e.subject)?.status, "completed");
    const next = o.plan("b", b.list(), c.tasks(), now);
    assert.ok(next.events?.some((e) => JSON.parse(e.detail).kind === "internal-content"));
    assert.deepEqual(o.plan("b", b.list(), c.tasks(), now), next);
    const check = next.events!.find((e) => JSON.parse(e.detail).kind.startsWith("check-"))!;
    send("company-inbox", check.type, check.subject, JSON.parse(check.detail));
    const role = JSON.parse(check.detail).kind.slice(6);
    const blocked = send(`company-${role}`, "company.result", check.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "不知道数据在哪里",
      artifacts: [],
      evidence: ["未提供数据入口"],
      inspection: {
        state: "blocked",
        actions: [],
        reviews: [],
        questions: [{ key: "data", question: "数据在哪里？", context: "需要真实业务指标" }],
      },
    });
    assert.equal(blocked.ask, undefined);
    assert.equal(blocked.notice, undefined);
    o.plan("c", b.list(), c.tasks(), now);
    assert.ok(o.executive().issues.some((i) => i.task === check.subject && i.state === "open"));
  }));
test("CEO escalates one grouped question; owner free text persists and wakes the CEO instead of silently approving work", () =>
  fixture((b, o, c, send) => {
    const first = o.plan("a", b.list(), c.tasks(), now).events![0];
    send("company-inbox", first.type, first.subject, JSON.parse(first.detail));
    const issues = o.executive().issues;
    send("company-ceo", "company.result", first.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "需要了解业务现状",
      artifacts: [],
      evidence: ["业务档案未记载进展和数据入口"],
      executive: decision({
        escalations: [
          {
            key: "onboarding",
            issues: issues.map((i) => i.id),
            question: "两个 APP 进展到哪一步，数据在哪里？",
            context: "明确运营依据",
          },
        ],
      }),
    });
    const out = o.plan("b", b.list(), c.tasks(), now);
    assert.equal(out.ask?.length, 1);
    assert.deepEqual(o.plan("waiting", b.list(), c.tasks(), now).ask, undefined);
    const answer = { card: 9, choice: null, text: "已上线，数据在本机报表，先推广记住 APP", about: out.ask![0].about };
    const resumed = o.plan("reply", b.list(), c.tasks(), now, [answer]);
    assert.ok(resumed.events?.some((e) => JSON.parse(e.detail).kind === "ceo"));
    assert.equal(o.executive().knowledge.filter((k) => k.source === "owner").length, 1);
    assert.deepEqual(o.plan("reply", b.list(), c.tasks(), now, [answer]), resumed);
    assert.equal(o.executive().questions[0].answer, answer.text);
  }));

test("employee proposals wait for CEO approval and invalid project references cannot partially dispatch", () =>
  fixture((b, o, c, send) => {
    const create = (e: any) => send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    const finish = (id: string, executive: any) =>
      send("company-ceo", "company.result", id, {
        assignment: 1,
        verdict: "pass",
        summary: "管理",
        artifacts: [],
        evidence: ["档案"],
        executive,
      });
    const first = o.plan("initial", b.list(), c.tasks(), now).events![0];
    create(first);
    finish(first.subject, decision({ briefs: [{ business: "app", objective: "完善说明" }] }));
    const checks = o.plan("checks", b.list(), c.tasks(), now).events!;
    const check = checks.find((e) => JSON.parse(e.detail).kind.startsWith("check-"))!;
    create(check);
    const role = JSON.parse(check.detail).kind.slice(6);
    send(`company-${role}`, "company.result", check.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "建议完善说明",
      artifacts: [],
      evidence: ["缺少说明"],
      inspection: { state: "action", actions: [action], reviews: [] },
    });
    const next = o.plan("proposed", b.list(), c.tasks(), now);
    const plan = o.snapshot(b.list(), c.tasks(), now)[0].plans[0];
    assert.equal(plan.status, "proposed");
    assert.ok(!next.events?.some((e) => JSON.parse(e.detail).kind === "internal-content"));
    const ceo = next.events!.find((e) => JSON.parse(e.detail).kind === "ceo")!;
    create(ceo);
    finish(
      ceo.subject,
      decision({
        approvals: [{ business: "app", plan: plan.id, approve: true, reason: "有事实依据" }],
        briefs: [{ business: "missing", objective: "不应写入" }],
      }),
    );
    o.plan("invalid", b.list(), c.tasks(), now);
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans[0].status, "proposed");
    assert.equal(o.executive().briefs.missing, undefined);
    const pending = c
      .tasks()
      .filter((t) => t.kind === "ceo")
      .map((t) => t.id);
    const latest = o.executive().lastTask!;
    if (!pending.includes(latest))
      create({
        type: "company.task.create",
        subject: latest,
        detail: JSON.stringify({ kind: "ceo", title: "CEO", goal: "重审", acceptance: ["核对"] }),
      });
    finish(latest, decision({ approvals: [{ business: "app", plan: plan.id, approve: true, reason: "依据完整" }] }));
    o.plan("approve", b.list(), c.tasks(), now);
    assert.notEqual(o.snapshot(b.list(), c.tasks(), now)[0].plans[0].status, "proposed");
  }));

test("a partial CEO answer does not erase an escalation for the same issue", () =>
  fixture((b, o, c, send) => {
    const e = o.plan("start", b.list(), c.tasks(), now).events![0];
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    const issue = o.executive().issues[0];
    send("company-ceo", "company.result", e.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "已知产品定位，仍缺数据入口",
      artifacts: [],
      evidence: ["产品档案"],
      executive: decision({
        answers: [{ issue: issue.id, answer: "已知产品定位，数据入口仍待补充", evidence: "档案" }],
        escalations: [
          { key: "data", issues: [issue.id], question: "数据入口在哪里？", context: "已核对档案，缺少入口" },
        ],
      }),
    });
    const result = o.plan("consume", b.list(), c.tasks(), now);
    assert.equal(result.ask?.length, 1);
    assert.equal(o.executive().issues[0].state, "owner");
    assert.equal(o.executive().knowledge.length, 1);
  }));

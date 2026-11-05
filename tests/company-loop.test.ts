// Failure modes: a normal owner reply is acknowledged but never resumes the blocked job,
// QA rejection cannot return work, publishing-worker failures stay active, or retries republish.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";
import { failedWork } from "../plugins/company/recovery.ts";

const now = new Date("2026-11-06T01:00:00Z");
function fixture(fn: (x: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "company-loop-"));
  const c = new Company({ name: "test", database: join(dir, "company.db"), maxAssignments: 12, ceoMode: true });
  const o = new Operations(dir),
    b = new Businesses(dir);
  mkdirSync(join(dir, "hub"));
  // This fixture stands in for the authenticated event ledger, never the business projection.
  const hub = new DatabaseSync(join(dir, "hub/hub.db"));
  hub.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,type TEXT,detail TEXT,received_at TEXT)");
  let seq = 0;
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] });
  const tick = (answers: any[] = []) => {
    const receipt = o.plan(`tick-${++seq}`, b.list(), c.tasks(), now, answers);
    // Drain incidental inspection work; target tasks are always completed explicitly by each scenario.
    for (const e of receipt.events ?? [])
      if (JSON.parse(e.detail).kind === "check-growth") {
        consume(e);
        report(e.subject, "pass", { inspection: { state: "idle", actions: [], reviews: [] } });
      }
    return receipt;
  };
  const decide = (d: any) =>
    o.plan(`decision-${++seq}`, b.list(), c.tasks(), now, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({
          summary: "处理工作",
          executive: { briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...d },
        }),
      },
    ]);
  const consume = (event: any) => send("company-inbox", event.type, event.subject, JSON.parse(event.detail));
  const plan = () => o.snapshot(b.list(), c.tasks(), now)[0].plans[0];
  const report = (id: string, verdict = "pass", more = {}) => {
    const t = c.task(id)!;
    const role = t.stage === 0 ? "growth" : "qa";
    mkdirSync(join(dir, "workspace/tasks", id), { recursive: true });
    writeFileSync(join(dir, "workspace/tasks", id, "post.md"), "测试正文");
    return send(`company-${role}`, "company.result", id, {
      assignment: t.assignment,
      verdict,
      summary: verdict === "pass" ? "交付完成" : "需要补充账号信息",
      artifacts: [`tasks/${id}/post.md`],
      evidence: ["隔离测试资料"],
      ...more,
    });
  };
  try {
    b.save(
      { id: "app", name: "测试APP", description: "测试", audience: "测试", objective: "推广", stage: "operating" },
      now,
    );
    b.autonomy("app", true, now);
    b.status("app", "active", now);
    o.leadership(true, now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      o.configure("app", role, { enabled: false }, now);
    const start = decide({
      briefs: [{ business: "app", objective: "推广" }],
      directives: [
        {
          business: "app",
          action: {
            key: "post",
            title: "推广正文",
            kind: "content",
            goal: "发布推广正文",
            acceptance: ["事实准确"],
            priority: 1,
            dueDays: 1,
            followUpDays: 1,
            measure: "新增用户",
          },
        },
      ],
    });
    const work = start.events!.find((e: any) => JSON.parse(e.detail).kind === "internal-content")!;
    consume(work);
    fn({ dir, c, o, b, hub, send, tick, decide, consume, plan, report, work });
  } finally {
    hub.close();
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a verified plain-chat reply updates owner knowledge and resumes the original task exactly once", () =>
  fixture(({ c, o, hub, tick, decide, consume, report, work }) => {
    report(work.subject, "blocked");
    tick();
    const issue = o.executive().issues.find((i: any) => i.task === work.subject);
    decide({
      escalations: [{ key: "account", issues: [issue.id], question: "账号在哪里？", context: "现有资料没有入口" }],
    });
    const q = o.executive().questions.at(-1);
    hub
      .prepare("INSERT INTO events VALUES (?,?,?,?,?)")
      .run(
        101,
        "company-inbox",
        "company.owner.question",
        JSON.stringify({ question: "账号已接入，可以继续", message: "om_confirmed" }),
        now.toISOString(),
      );
    const response = {
      ownerReplies: [{ question: q.id, event: 101 }],
      answers: [{ issue: issue.id, answer: "使用已接入的账号继续原任务", evidence: "负责人消息101" }],
    };
    const resume = decide(response);
    assert.equal(o.executive().questions.find((v: any) => v.id === q.id).state, "answered");
    assert.ok(o.executive().knowledge.some((k: any) => k.source === "owner" && k.answer === "账号已接入，可以继续"));
    const retry = resume.events?.find((e: any) => e.type === "company.task.retry");
    assert.equal(retry?.subject, work.subject);
    consume(retry);
    assert.equal(c.task(work.subject).status, "active");
    assert.ok(!decide(response).events?.some((e: any) => e.type === "company.task.retry"));
    assert.equal(o.executive().knowledge.filter((k: any) => k.source === "owner").length, 1);
    report(work.subject);
    report(work.subject);
    tick();
    assert.equal(c.task(work.subject).status, "completed");
  }));

test("CEO can return a QA-rejected deliverable; the replaced blocker cannot restart the old revision", () =>
  fixture(({ c, o, tick, decide, consume, plan, report, work }) => {
    report(work.subject);
    report(work.subject, "reject", { summary: "正文产品事实错误" });
    tick();
    const issue = o.executive().issues.find((i: any) => i.task === work.subject);
    const returned = decide({
      deliveries: [{ business: "app", plan: plan().id, task: work.subject, verdict: "revise", reason: "修正产品事实" }],
    });
    const revised = returned.events?.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    assert.ok(revised, JSON.stringify(returned));
    assert.notEqual(revised.subject, work.subject);
    assert.equal(o.executive().issues.find((i: any) => i.id === issue.id).state, "answered");
    consume(revised);
    report(revised.subject);
    report(revised.subject);
    tick();
    assert.equal(plan().status, "delivered");
    assert.equal(c.task(work.subject).status, "blocked");
  }));

test("publishing worker terminal failure is reconciled, and QA retry does not invoke publication again", () =>
  fixture(({ dir, c, o, tick, decide, consume, plan, report, send, work }) => {
    report(work.subject);
    report(work.subject);
    tick();
    const approved = decide({
      deliveries: [
        {
          business: "app",
          plan: plan().id,
          task: work.subject,
          verdict: "publish",
          files: [`tasks/${work.subject}/post.md`],
          reason: "正文通过",
        },
      ],
    });
    const pub = approved.events!.find((e: any) => JSON.parse(e.detail).kind === "publish-content")!;
    consume(pub);
    const at = new Date(),
      later = new Date(at.getTime() + 180000);
    const failures = failedWork(
      c,
      [
        {
          id: 900,
          agent: "company-publisher",
          state: "failed",
          createdAt: at.toISOString(),
          finishedAt: at.toISOString(),
          error: "进程退出",
          events: [{ subject: pub.subject }],
        },
      ],
      later,
    );
    assert.equal(failures[0]?.subject, pub.subject);
    consume(failures[0]);
    assert.equal(c.task(pub.subject).status, "blocked");
    consume(tick().events.find((e: any) => e.type === "company.task.retry" && e.subject === pub.subject));
    const proof = {
      key: JSON.parse(pub.detail).publication,
      channel: "测试",
      remoteId: "1",
      url: "https://example.com/1",
      publishedAt: now.toISOString(),
    };
    writeFileSync(join(dir, "publications", proof.key + "-result.json"), JSON.stringify(proof));
    report(pub.subject, "pass", { publication: proof });
    report(pub.subject, "blocked", { summary: "暂时无法读取发布链接" });
    const retry = send("company-inbox", "company.task.retry", pub.subject, {});
    assert.equal(retry.events?.[0].type, "company.work.qa");
    assert.deepEqual(JSON.parse(retry.events[0].detail).previous.publication, proof);
    report(pub.subject, "pass", { publication: proof });
    tick();
    assert.equal(plan().status, "observing");
    assert.ok(
      !o.executive().issues.some((i: any) => i.task === pub.subject && i.state === "open"),
      "verified completion closes the old execution fault",
    );
  }));

for (const invalid of ["missing", "untrusted", "old", "truncated", "duplicate"])
  test(`owner evidence ${invalid} cannot close a question or restart work`, () =>
    fixture(({ o, hub, tick, decide, report, work }) => {
      report(work.subject, "blocked");
      tick();
      const issue = o.executive().issues.find((i: any) => i.task === work.subject);
      decide({ escalations: [{ key: "account", issues: [issue.id], question: "账号在哪里？", context: "缺少账号" }] });
      const q = o.executive().questions.at(-1);
      if (invalid !== "missing")
        hub
          .prepare("INSERT INTO events VALUES (?,?,?,?,?)")
          .run(
            101,
            invalid === "untrusted" ? "company-growth" : "company-inbox",
            "company.owner.question",
            JSON.stringify({ question: "可以继续", message: "om_reply", truncated: invalid === "truncated" }),
            invalid === "old" ? "2026-01-01T00:00:00Z" : now.toISOString(),
          );
      const reply = { question: q.id, event: 101 };
      const result = decide({
        ownerReplies: invalid === "duplicate" ? [reply, reply] : [reply],
        answers: [{ issue: issue.id, answer: "继续", evidence: "消息101" }],
      });
      assert.equal(o.executive().questions.at(-1).state, "open");
      assert.equal(o.executive().knowledge.filter((k: any) => k.source === "owner").length, 0);
      assert.ok(!result.events?.some((e: any) => e.type === "company.task.retry"));
    }));

test("waiting for the owner leaves independent work running and does not resend the same question", () =>
  fixture(({ c, o, tick, decide, consume, report, work }) => {
    report(work.subject, "blocked");
    tick();
    const issue = o.executive().issues.find((i: any) => i.task === work.subject);
    const escalation = { key: "account", issues: [issue.id], question: "请选择发布账号", context: "需要负责人确定" };
    decide({ escalations: [escalation] });
    const next = decide({
      directives: [
        {
          business: "app",
          action: {
            key: "independent",
            title: "另一篇内容",
            kind: "content",
            goal: "完成不需要账号的内容",
            acceptance: ["有正文"],
            priority: 1,
            dueDays: 1,
            followUpDays: 1,
            measure: "新增用户",
          },
        },
      ],
    });
    const independent = next.events?.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    assert.ok(independent);
    consume(independent);
    report(independent.subject);
    report(independent.subject);
    tick();
    assert.equal(c.task(independent.subject).status, "completed");
    assert.equal(c.task(work.subject).status, "blocked");
    assert.equal(decide({ escalations: [escalation] }).ask, undefined);
    assert.equal(o.executive().questions.filter((q: any) => q.state === "open").length, 1);
  }));

test("exhausted employee process repairs remain with CEO instead of bypassing CEO to the owner", () =>
  fixture(({ c, o, b, send, consume, work }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      send("company-inbox", "company.task.failed", work.subject, {
        assignment: c.task(work.subject).assignment,
        reason: "运行失败：进程异常退出",
      });
      const r = o.plan("failure-" + attempt, b.list(), c.tasks(), new Date(now.getTime() + attempt * 6 * 60000));
      if (attempt < 2)
        consume(r.events.find((e: any) => e.type === "company.task.retry" && e.subject === work.subject));
      else {
        assert.equal(r.notice, undefined);
        assert.equal(r.ask, undefined);
        assert.ok(o.executive().issues.some((i: any) => i.task === work.subject && i.state === "open"));
        assert.equal(c.task(work.subject).status, "blocked");
      }
    }
  }));

test("three model inspections cannot starve an already-approved fixed publisher", () =>
  fixture(({ c, o, tick, decide, consume, plan, report, work }) => {
    report(work.subject);
    report(work.subject);
    for (const role of ["product", "engineering", "qa"]) o.configure("app", role, { enabled: true }, now);
    const inspections = tick().events.filter((e: any) => JSON.parse(e.detail).kind?.startsWith("check-"));
    assert.equal(inspections.length, 3);
    for (const e of inspections) consume(e);
    const approved = decide({
      deliveries: [
        {
          business: "app",
          plan: plan().id,
          task: work.subject,
          verdict: "publish",
          files: [`tasks/${work.subject}/post.md`],
          reason: "正文通过",
        },
      ],
    });
    const publish = approved.events?.find((e: any) => JSON.parse(e.detail).kind === "publish-content");
    assert.ok(publish, "fixed publishing must run even while model inspection slots are occupied");
    consume(publish);
    assert.equal(c.task(publish.subject).status, "active");
    assert.equal(tick().events?.filter((e: any) => JSON.parse(e.detail).kind === "publish-content").length ?? 0, 0);
  }));

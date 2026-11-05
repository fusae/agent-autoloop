// Failure modes: drafts enter effect observation before publication, CEO rejection does not
// restart work, stale reviews approve another revision, or missing publishing access stops silently.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";

const now = new Date("2026-11-05T16:00:00Z");
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
const action = {
  key: "post",
  title: "推广内容",
  kind: "content",
  goal: "准备产品推广正文",
  acceptance: ["产品事实准确"],
  priority: 1,
  dueDays: 1,
  followUpDays: 3,
  measure: "发布后的新增用户",
};
function fixture(fn: (x: any) => void, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), "company-delivery-"));
  const c = new Company({ name: "test", database: join(dir, "company.db"), maxAssignments: 6, ceoMode: true });
  const b = new Businesses(dir),
    o = new Operations(dir);
  let seq = 0;
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] });
  const tick = () => o.plan(`tick-${++seq}`, b.list(), c.tasks(), now);
  const decide = (d: any) => {
    for (const review of d.deliveries ?? [])
      if (review.verdict === "publish" && !review.files) review.files = c.task(review.task)?.reports.at(-1)?.artifacts;
    return o.plan(`decision-${++seq}`, b.list(), c.tasks(), now, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "推进推广", executive: decision(d) }),
      },
    ]);
  };
  const plan = () => o.snapshot(b.list(), c.tasks(), now)[0].plans[0];
  const finish = (event: any) => {
    send("company-inbox", event.type, event.subject, JSON.parse(event.detail));
    mkdirSync(join(dir, "workspace/tasks", event.subject), { recursive: true });
    const artifact = `tasks/${event.subject}/post.md`;
    writeFileSync(join(dir, "workspace", artifact), "产品使用说明");
    for (const [index, role] of ["growth", "qa"].entries())
      send(`company-${role}`, "company.result", event.subject, {
        assignment: index + 1,
        verdict: "pass",
        summary: "草稿验收通过",
        artifacts: [artifact],
        evidence: ["核对产品资料"],
      });
  };
  try {
    b.save(
      { id: "app", name: "APP", description: "提醒", audience: "用户", objective: "推广", stage: "operating" },
      now,
    );
    b.autonomy("app", true, now);
    b.status("app", "active", now);
    o.leadership(true, now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      o.configure("app", role, { enabled: false }, now);
    const start = decide({
      briefs: [{ business: "app", objective: "推广" }],
      directives: [{ business: "app", action }],
    });
    const work = start.events?.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    finish(work);
    if (legacy) o.leadership(false, now);
    tick();
    fn({ dir, c, b, o, send, tick, decide, plan, finish, work });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a completed draft waits for CEO review; reject schedules a new revision and stale review cannot approve it", () =>
  fixture(({ c, tick, decide, plan, finish, work }) => {
    assert.equal(plan().status, "delivered");
    assert.equal(plan().followUpAt, null);
    const review = {
      business: "app",
      plan: plan().id,
      task: work.subject,
      verdict: "revise",
      reason: "标题需要具体使用场景",
    };
    const rejected = decide({ deliveries: [review] });
    const revision = rejected.events?.find((e: any) => JSON.parse(e.detail).kind === "internal-content");
    assert.ok(revision);
    assert.notEqual(revision.subject, work.subject);
    assert.match(JSON.parse(revision.detail).goal, /标题需要具体使用场景/);
    assert.equal(plan().status, "working");
    finish(revision);
    tick();
    assert.equal(plan().status, "delivered");
    const stale = decide({ deliveries: [{ ...review, verdict: "publish" }] });
    assert.match(stale.notice?.[0].text, /未执行/);
    assert.equal(plan().status, "delivered");
    assert.equal(c.task(work.subject).status, "completed");
  }));

test("approved content dispatches publishing once; a publishing blocker goes to CEO rather than observation", () =>
  fixture(({ dir, c, o, decide, plan, tick, send, work }) => {
    const review = {
      business: "app",
      plan: plan().id,
      task: work.subject,
      verdict: "publish",
      reason: "内容准确，可以发布",
    };
    const approved = decide({ deliveries: [review] });
    const publish = approved.events?.find((e: any) => JSON.parse(e.detail).kind === "publish-content");
    assert.ok(publish);
    assert.equal(plan().status, "publishing");
    assert.equal(plan().followUpAt, null);
    const dispatched = send("company-inbox", publish.type, publish.subject, JSON.parse(publish.detail));
    assert.equal(dispatched.events[0].type, "company.work.publish");
    const config = join(dir, "company.json"),
      context = join(dir, "publish-context.json");
    writeFileSync(config, JSON.stringify({ database: join(dir, "company.db") }));
    writeFileSync(
      context,
      JSON.stringify({ events: dispatched.events.map((e: any) => ({ ...e, source: "company-office" })) }),
    );
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../plugins/company/publish-run.ts"), config, context],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout.split("```agent-autoloop\n")[1].split("\n```")[0]);
    const report = receipt.events[0];
    assert.match(JSON.parse(report.detail).summary, /发布渠道和账号/);
    send("company-growth", report.type, report.subject, JSON.parse(report.detail));
    tick();
    assert.equal(plan().status, "blocked");
    assert.ok(o.executive().issues.some((i: any) => i.task === publish.subject && i.state === "open"));
    const replay = decide({ deliveries: [review] });
    assert.ok(!replay.events?.some((e: any) => JSON.parse(e.detail).kind === "publish-content"));
    assert.equal(c.tasks().filter((t: any) => t.kind === "publish-content").length, 1);
    const issue = o.executive().issues.find((i: any) => i.task === publish.subject);
    const escalation = {
      key: "publish-access",
      issues: [issue.id],
      question: "推广正文已审核，需要接入发布平台和账号",
      context: "固定发布入口尚未配置",
    };
    assert.equal(decide({ escalations: [escalation] }).ask?.length, 1);
    assert.equal(decide({ escalations: [escalation] }).ask, undefined);
    assert.equal(plan().status, "blocked");
  }));

test("internal-only acceptance closes a deliverable without claiming external effects", () =>
  fixture(({ o, decide, plan, work }) => {
    decide({
      deliveries: [
        {
          business: "app",
          plan: plan().id,
          task: work.subject,
          verdict: "accept",
          reason: "内部参考资料已验收，本项不发布",
        },
      ],
    });
    assert.equal(plan().status, "closed");
    assert.equal(plan().followUpAt, null);
    assert.equal(plan().outcome, null);
    assert.equal(o.executive().nextReviewAt, now.toISOString());
  }));

test("only a platform receipt and independent QA allow effect observation", () =>
  fixture(({ dir, c, decide, plan, tick, send, work }) => {
    const approved = decide({
      deliveries: [{ business: "app", plan: plan().id, task: work.subject, verdict: "publish", reason: "正文通过" }],
    });
    const publish = approved.events.find((e: any) => JSON.parse(e.detail).kind === "publish-content");
    const request = JSON.parse(publish.detail);
    send("company-inbox", publish.type, publish.subject, request);
    const report = {
      assignment: 1,
      verdict: "pass",
      summary: "平台返回发布成功",
      artifacts: ["tasks/proof.json"],
      evidence: ["测试平台的发布记录"],
    };
    send("company-growth", "company.result", publish.subject, report);
    assert.equal(c.task(publish.subject).status, "blocked", "a draft-only pass cannot count as published");
    send("company-inbox", "company.task.retry", publish.subject, {});
    const proof = {
      key: request.publication,
      channel: "测试平台",
      remoteId: "post-1",
      url: "https://example.com/post-1",
      publishedAt: now.toISOString(),
    };
    writeFileSync(join(dir, "publications", request.publication + "-result.json"), JSON.stringify(proof));
    send("company-growth", "company.result", publish.subject, { ...report, assignment: 2, publication: proof });
    tick();
    assert.equal(plan().status, "publishing");
    assert.equal(plan().followUpAt, null);
    send("company-qa", "company.result", publish.subject, { ...report, assignment: 3, publication: proof });
    tick();
    assert.equal(plan().status, "observing");
    assert.ok(plan().followUpAt);
  }));

test("existing draft observations are reclassified through a normal tick without repeating the deliverable", () =>
  fixture(({ o, b, c, plan, tick }) => {
    assert.equal(plan().status, "observing");
    const task = plan().task;
    o.leadership(true, now);
    tick();
    assert.equal(plan().status, "delivered");
    assert.equal(plan().task, task);
    assert.equal(plan().followUpAt, null);
    assert.equal(c.task(task).status, "completed");
  }, true));

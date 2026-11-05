// Failure modes: employees bypass the CEO, CEO decisions execute twice, owner answers are lost,
// cross-project instructions leak, unanswered blockers stop silently, or owner answers cannot resume work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company, type Context } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { failedWork } from "../plugins/company/recovery.ts";
import { parseResult } from "../protocol/validate.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
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

// Owner chat must dispatch real work once, not merely claim success in a notice.
test("CEO conversation decisions enter the existing employee workflow and survive replay", () =>
  fixture((b, o, c, send) => {
    const event = {
      id: "owner-decision-owner-question:" + "a".repeat(64),
      source: "company-ceo",
      type: "company.ceo.decision",
      subject: "owner",
      detail: JSON.stringify({
        summary: "先准备 APP 推广内容",
        executive: decision({
          briefs: [{ business: "app", objective: "推广 APP" }],
          directives: [{ business: "app", action }],
        }),
      }),
    };
    const receipt = o.plan("chat", b.list(), c.tasks(), now, [], 1, [event]);
    const work = receipt.events?.find((e) => JSON.parse(e.detail).kind === "internal-content");
    assert.ok(work, "chat must create an executable employee task immediately");
    assert.doesNotThrow(() => parseResult({ outcome: "done", ...receipt }));
    assert.match(receipt.notice?.find((n) => n.title === "CEO · 工作安排")?.text ?? "", /首次使用说明/);
    assert.equal(o.executive().briefs.app, "推广 APP");
    assert.equal(o.snapshot(b.list(), c.tasks())[0].plans.length, 1);
    assert.deepEqual(o.plan("chat", b.list(), c.tasks(), now, [], 1, [event]), receipt);
    send("company-inbox", work.type, work.subject, JSON.parse(work.detail));
    const replay = o.plan("chat-replay", b.list(), c.tasks(), now, [], 1, [event]);
    assert.equal(
      replay.notice?.some((n) => n.title === "CEO · 工作安排"),
      undefined,
    );
    assert.equal(o.snapshot(b.list(), c.tasks())[0].plans.length, 1);
    assert.equal(c.task(work.subject)?.kind, "internal-content");
    assert.equal(c.task(work.subject)?.stage, 0);
  }));

test("CEO chat rejects unknown projects and external task types atomically; other sources cannot dispatch", () =>
  fixture((b, o, c) => {
    const events = (source: string, executive: unknown, id: number) => [
      {
        id,
        source,
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "测试决定", executive }),
      },
    ];
    const valid = decision({
      briefs: [{ business: "app", objective: "不可误写" }],
      directives: [{ business: "app", action }],
    });
    o.plan("untrusted", b.list(), c.tasks(), now, [], 2, events("company-growth", valid, 1));
    assert.equal(o.executive().briefs.app, undefined);
    for (const [i, d] of [
      decision({ ...valid, directives: [{ business: "missing", action }] }),
      decision({ ...valid, directives: [{ business: "app", action: { ...action, kind: "publish" } }] }),
    ].entries()) {
      const result = o.plan("invalid-" + i, b.list(), c.tasks(), now, [], 1, events("company-ceo", d, i + 2));
      assert.match(result.notice?.[0].text ?? "", /未执行/);
      assert.equal(o.executive().briefs.app, undefined);
      assert.equal(o.snapshot(b.list(), c.tasks())[0].plans.length, 0);
    }
  }));

// New decisions must not stop at 24/day; identical unresolved agendas must not spin forever instead.
test("CEO handles new information beyond the old daily cap, bounds unchanged reviews, and wakes on new facts", () =>
  fixture((b, o, c, send) => {
    for (const role of ["product", "engineering", "qa", "growth", "support", "finance"])
      o.configure("app", role, { enabled: false }, now);
    const finish = (e: any, at: Date, key: string) => {
      send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
      send("company-ceo", "company.result", e.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "已核对，问题仍未解决",
        artifacts: [],
        evidence: ["档案"],
        executive: decision({ briefs: [{ business: "app", objective: "维护现有业务" }] }),
      });
      o.plan("settle-" + key, b.list(), c.tasks(), at, [], 4);
    };
    for (let i = 0; i < 26; i++) {
      const at = new Date(now.getTime() + i * 60000);
      o.signal("app", { title: "新事实" + i, detail: "真实业务输入变化" + i, source: "测试", role: "all" }, at);
      const e = o.plan("new-" + i, b.list(), c.tasks(), at).events?.find((e) => JSON.parse(e.detail).kind === "ceo");
      assert.ok(e, "new facts must still reach CEO after 24 tasks");
      finish(e, at, "new-" + i);
    }
    for (let i = 1; i <= 2; i++) {
      const at = new Date(now.getTime() + (30 + i * 31) * 60000);
      const e = o
        .plan("unchanged-" + i, b.list(), c.tasks(), at)
        .events?.find((e) => JSON.parse(e.detail).kind === "ceo");
      assert.ok(e);
      finish(e, at, "unchanged-" + i);
    }
    const later = new Date(now.getTime() + 125 * 60000);
    const paused = o.plan("unchanged-stop", b.list(), c.tasks(), later);
    assert.equal(paused.events, undefined);
    assert.equal(paused.notice, undefined, "an actionable question replaces the status-only notice");
    assert.ok(o.executive().stalled);
    assert.equal(paused.ask?.length, 1, "unresolved CEO blockers must reach the owner as an answerable question");
    assert.match(paused.ask![0].text, /APP/);
    assert.doesNotThrow(() => parseResult({ outcome: "done", ...paused }));
    assert.deepEqual(o.plan("unchanged-again", b.list(), c.tasks(), new Date(later.getTime() + 60000)), {});
    o.signal("app", { title: "新进展", detail: "补充了所需来源", source: "测试" }, later);
    assert.ok(
      o.plan("wake-again", b.list(), c.tasks(), later).events?.some((e) => JSON.parse(e.detail).kind === "ceo"),
    );
    assert.equal(o.executive().stalled, undefined);
  }));
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

// Recovery is persistent and bounded; unrelated work must not be held by one malformed CEO report.
test("malformed CEO output is repaired automatically with the original error and a bounded retry budget", () =>
  fixture((b, o, c, send) => {
    const first = o.plan("begin", b.list(), c.tasks(), now).events![0];
    send("company-inbox", first.type, first.subject, JSON.parse(first.detail));
    const fail = (assignment: number) =>
      send("company-ceo", "company.result", first.subject, {
        assignment,
        verdict: "pass",
        summary: "无效格式",
        artifacts: [],
        evidence: ["资料"],
        executive: decision({ briefs: [{ business: "app", objective: "x".repeat(301) }] }),
      });
    fail(1);
    let r = o.plan("recover-1", b.list(), c.tasks(), now);
    const retry = r.events?.find((e) => e.type === "company.task.retry");
    assert.ok(retry);
    assert.equal(
      o.plan("no-duplicate", b.list(), c.tasks(), now).events?.filter((e) => e.type === "company.task.retry").length ??
        0,
      0,
    );
    const dispatched = send("company-inbox", retry.type, retry.subject, {});
    assert.match(JSON.parse(dispatched.events[0].detail).repair, /长度|objective/);
    fail(2);
    assert.equal(o.plan("cooldown", b.list(), c.tasks(), now).events?.length ?? 0, 0);
    r = o.plan("recover-2", b.list(), c.tasks(), new Date(now.getTime() + 6 * 60000));
    const second = r.events!.find((e) => e.type === "company.task.retry")!;
    assert.ok(second);
    send("company-inbox", second.type, second.subject, {});
    fail(3);
    r = o.plan("exhausted", b.list(), c.tasks(), new Date(now.getTime() + 12 * 60000));
    assert.equal(r.events?.filter((e) => e.type === "company.task.retry").length ?? 0, 0);
    assert.equal(r.notice?.length, 1);
    assert.equal(o.plan("quiet", b.list(), c.tasks(), new Date(now.getTime() + 13 * 60000)).notice, undefined);
  }));

test("worker failure cannot leave a supervised task active forever or accept stale failures", () =>
  fixture((b, o, c, send) => {
    const e = o.plan("a", b.list(), c.tasks(), now).events![0];
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    send("company-inbox", "company.task.failed", e.subject, { assignment: 0, reason: "运行失败：旧任务" });
    assert.equal(c.task(e.subject)?.status, "active");
    send("company-growth", "company.task.failed", e.subject, { assignment: 1, reason: "运行失败：伪造" });
    assert.equal(c.task(e.subject)?.status, "active");
    send("company-inbox", "company.task.failed", e.subject, { assignment: 1, reason: "运行失败：超时" });
    assert.equal(c.task(e.subject)?.status, "blocked");
    assert.ok(o.plan("reconcile", b.list(), c.tasks(), now).events?.some((e) => e.type === "company.task.retry"));
  }));

test("deep result chains save CEO decisions but defer new work to the next independent tick", () =>
  fixture((b, o, c, send) => {
    const e = o.plan("initial", b.list(), c.tasks(), now).events![0];
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    send("company-ceo", "company.result", e.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "派工",
      artifacts: [],
      evidence: ["档案"],
      executive: decision({
        briefs: [{ business: "app", objective: "完善说明" }],
        directives: [{ business: "app", action }],
      }),
    });
    const update = o.plan("deep", b.list(), c.tasks(), now, [], 4);
    assert.equal(update.events, undefined);
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans[0].status, "planned");
    const next = o.plan("tick", b.list(), c.tasks(), now, [], 0);
    assert.ok(next.events?.some((e) => JSON.parse(e.detail).kind === "internal-content"));
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].plans[0].status, "working");
    assert.equal(o.snapshot(b.list(), c.tasks(), now)[0].owner, "product");
  }));

test("new project evidence wakes an employee with an unresolved question without repeating unchanged checks", () =>
  fixture((b, o, c, send) => {
    for (const role of ["engineering", "qa", "growth", "support", "finance"])
      o.configure("app", role, { enabled: false }, now);
    const e = o.plan("first", b.list(), c.tasks(), now).events![0];
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    send("company-ceo", "company.result", e.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "明确目标",
      artifacts: [],
      evidence: ["档案"],
      executive: decision({ briefs: [{ business: "app", objective: "确认入口" }] }),
    });
    const check = o
      .plan("staff", b.list(), c.tasks(), now)
      .events!.find((e) => JSON.parse(e.detail).kind === "check-product")!;
    send("company-inbox", check.type, check.subject, JSON.parse(check.detail));
    send("company-product", "company.result", check.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "缺测试记录",
      artifacts: [],
      evidence: ["无结果"],
      inspection: {
        state: "blocked",
        actions: [],
        reviews: [],
        questions: [{ key: "record", question: "测试记录在哪里？", context: "资料未提供" }],
      },
    });
    o.plan("record", b.list(), c.tasks(), now, [], 4);
    assert.ok(o.executive().issues.some((i) => i.role === "product" && i.state === "open"));
    assert.ok(
      !o.plan("idle", b.list(), c.tasks(), now).events?.some((e) => JSON.parse(e.detail).kind === "check-product"),
    );
    o.signal("app", { title: "记录已更新", detail: "新增专项测试记录", source: "资料更新", role: "product" }, now);
    assert.ok(
      o.plan("new-record", b.list(), c.tasks(), now).events?.some((e) => JSON.parse(e.detail).kind === "check-product"),
    );
  }));

// A descriptive escalation key caused a real CEO report to be rejected.
test("descriptive escalation keys remain bounded without rejecting the observed key", () => {
  const escalation = {
    key: "active-projects-engineering-verification-evidence",
    issues: ["issue"],
    question: "资料在哪里",
    context: "核验",
  };
  assert.equal(executiveDecision(decision({ escalations: [escalation] })).escalations[0].key, escalation.key);
  assert.throws(() => executiveDecision(decision({ escalations: [{ ...escalation, key: "x".repeat(81) }] })));
});

test("reconciliation ignores live retries, stale assignments and reports still in transit", () =>
  fixture((b, o, c, send) => {
    const e = o.plan("start", b.list(), c.tasks(), now).events![0];
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    const at = Date.parse(String(c.history(e.subject).at(-1)!.at));
    const run = {
      id: 10,
      agent: "company-ceo",
      events: [{ subject: e.subject }],
      state: "done",
      createdAt: new Date(at).toISOString(),
      finishedAt: new Date(at + 1000).toISOString(),
    };
    const later = new Date(at + 180000);
    assert.equal(failedWork(c, [run], later).length, 1);
    assert.equal(failedWork(c, [run], new Date(at + 2000)).length, 0);
    assert.equal(failedWork(c, [{ ...run, state: "queued" }], later).length, 0);
    assert.equal(failedWork(c, [{ ...run, state: "claimed" }], later).length, 0);
    assert.equal(failedWork(c, [{ ...run, createdAt: new Date(at - 5000).toISOString() }], later).length, 0);
    assert.equal(failedWork(c, [run, { ...run, id: 11, state: "queued" }], later).length, 0);
  }));

// Exhausting unchanged retries must not discard new owner information or bypass CEO review.
test("owner answers reopen a blocked task retry allowance once and CEO resumes the existing task", () =>
  fixture((b, o, c, send) => {
    const chat = (id: string, executive: unknown) =>
      o.plan(id, b.list(), c.tasks(), now, [], 0, [
        {
          id,
          source: "company-ceo",
          type: "company.ceo.decision",
          subject: "owner",
          detail: JSON.stringify({ summary: "处理阻塞", executive }),
        },
      ]);
    const first = chat(
      "assign",
      decision({
        briefs: [{ business: "app", objective: "完善内容" }],
        directives: [{ business: "app", action }],
      }),
    ).events!.find((e) => JSON.parse(e.detail).kind === "internal-content")!;
    send("company-inbox", first.type, first.subject, JSON.parse(first.detail));
    const block = (n: number) => {
      send("company-growth", "company.result", first.subject, {
        assignment: n,
        verdict: "blocked",
        summary: "缺少发布渠道入口",
        artifacts: [],
        evidence: ["已有资料无入口"],
      });
      o.plan("collect-" + n, b.list(), c.tasks(), now, [], 4);
      return o.executive().issues.find((i) => i.task === first.subject && i.state === "open")!;
    };
    for (let n = 1; n <= 2; n++) {
      const issue = block(n);
      const r = chat(
        "answer-" + n,
        decision({ answers: [{ issue: issue.id, answer: "核对已有渠道配置", evidence: "资料" }] }),
      );
      const retry = r.events!.find((e) => e.type === "company.task.retry")!;
      assert.ok(retry);
      send("company-inbox", retry.type, retry.subject, {});
    }
    const issue = block(3);
    assert.equal(o.executive().retries[first.subject], 2);
    const q = chat(
      "escalate",
      decision({
        escalations: [
          {
            key: "channel",
            issues: [issue.id],
            question: "请提供发布渠道入口",
            context: "已有配置无法使用",
          },
        ],
      }),
    ).ask![0];
    const answer = { card: 77, choice: null, text: "入口已补充到项目资料", about: q.about };
    const received = o.plan("owner-answer", b.list(), c.tasks(), now, [answer], 4);
    assert.equal(received.events, undefined, "owner input must still be evaluated by CEO");
    assert.equal(o.executive().retries[first.subject], 0);
    const resumed = chat(
      "resume",
      decision({ answers: [{ issue: issue.id, answer: "按新入口继续现有任务", evidence: "负责人补充" }] }),
    );
    assert.equal(
      resumed.events?.filter((e) => e.type === "company.task.retry" && e.subject === first.subject).length,
      1,
    );
    assert.equal(o.executive().retries[first.subject], 1);
    o.plan("owner-replay", b.list(), c.tasks(), now, [answer], 4);
    assert.equal(o.executive().retries[first.subject], 1, "replayed owner answer cannot reset the allowance again");
  }));

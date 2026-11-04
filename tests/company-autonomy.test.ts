// Failure modes: idle checks demand approval, proposals bypass role/QA boundaries, repeated ticks duplicate work,
// completed drafts masquerade as business outcomes, paused projects dispatch, or employees lose responsibility on restart.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company, type Context, type Task } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";

const now = new Date("2026-11-04T02:00:00Z");
const proposal = {
  key: "activation",
  title: "首次提醒使用说明",
  kind: "content",
  goal: "核对首次使用步骤并准备说明草稿",
  acceptance: ["步骤有产品资料依据"],
  priority: 1,
  dueDays: 2,
  followUpDays: 3,
  measure: "首次创建提醒人数",
};
const input = {
  id: "app-a",
  name: "APP A",
  description: "提醒工具",
  audience: "忘事的人",
  objective: "提升激活",
  stage: "operating",
};
const ctx = (id: number, source: string, type: string, subject: string, detail: unknown): Context => ({
  events: [{ id, source, type, subject, detail: JSON.stringify(detail) }],
  answers: [],
});

test("employee checks end quietly; internal deliveries still require independent QA; ordinary work retains approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-company-"));
  const office = new Company({ name: "测试", database: join(dir, "company.db"), maxAssignments: 6 });
  try {
    office.process(
      ctx(1, "company-inbox", "company.task.create", "check", {
        title: "检查",
        goal: "检查职责",
        kind: "check-growth",
        acceptance: ["真实依据"],
      }),
    );
    const report = {
      assignment: 1,
      verdict: "pass",
      summary: "暂无新情况",
      artifacts: [],
      evidence: ["未接入渠道数据"],
      inspection: { state: "idle", actions: [], reviews: [] },
    };
    const output = office.process(ctx(2, "company-growth", "company.result", "check", report));
    assert.equal(office.task("check")?.status, "completed");
    assert.equal(output.ask, undefined);
    office.process(
      ctx(3, "company-inbox", "company.task.create", "draft", {
        title: "草稿",
        goal: "本地内容",
        kind: "internal-content",
        acceptance: ["有事实依据"],
      }),
    );
    const pass = {
      assignment: 1,
      verdict: "pass",
      summary: "草稿完成",
      artifacts: ["tasks/draft/content.md"],
      evidence: ["核对产品资料"],
    };
    office.process(ctx(4, "company-growth", "company.result", "draft", pass));
    assert.equal(office.task("draft")?.status, "active");
    assert.equal(office.task("draft")?.stage, 1);
    const done = office.process(ctx(5, "company-qa", "company.result", "draft", { ...pass, assignment: 2 }));
    assert.equal(office.task("draft")?.status, "completed");
    assert.equal(done.ask, undefined);
    office.process(
      ctx(6, "company-inbox", "company.task.create", "bad", {
        title: "检查",
        goal: "职责",
        kind: "check-support",
        acceptance: ["有依据"],
      }),
    );
    office.process(
      ctx(7, "company-support", "company.result", "bad", {
        ...report,
        inspection: { state: "action", actions: [{ ...proposal, kind: "publish" }], reviews: [] },
      }),
    );
    assert.equal(office.task("bad")?.status, "blocked");
  } finally {
    office.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("responsibilities, plans and follow-ups persist; replay and unchanged inputs do not create busywork", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-plan-"));
  const businesses = new Businesses(dir);
  let ops = new Operations(dir);
  const tasks: Task[] = [];
  try {
    businesses.save(input, now);
    businesses.autonomy("app-a", true, now);
    assert.deepEqual(ops.plan("draft", businesses.list(), tasks, now), {});
    businesses.status("app-a", "active", now);
    ops.configure("app-a", "growth", { duty: "维护获客渠道和激活效果", cadence: "daily", enabled: true }, now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      ops.configure("app-a", role, { enabled: false }, now);
    const first = ops.plan("first", businesses.list(), tasks, now);
    assert.equal(first.events?.length, 1);
    assert.equal(JSON.parse(first.events![0].detail).kind, "check-growth");
    const check = first.events![0].subject;
    tasks.push({
      id: check,
      ...JSON.parse(first.events![0].detail),
      status: "completed",
      stage: 0,
      assignment: 1,
      approval: null,
      reason: "发现激活问题",
      reports: [
        {
          role: "growth",
          assignment: 1,
          verdict: "pass",
          summary: "发现激活问题",
          artifacts: [],
          evidence: ["后台记录"],
          inspection: { state: "action", actions: [proposal], reviews: [] },
        },
      ],
    });
    const second = ops.plan("second", businesses.list(), tasks, now);
    assert.equal(second.events?.length, 1);
    assert.equal(JSON.parse(second.events![0].detail).kind, "internal-content");
    ops.close();
    ops = new Operations(dir);
    assert.deepEqual(ops.plan("second", businesses.list(), tasks, now), second);
    assert.equal(
      ops.snapshot(businesses.list(), tasks, now)[0].staff.find((s) => s.role === "growth")?.duty,
      "维护获客渠道和激活效果",
    );
    assert.deepEqual(ops.plan("waiting", businesses.list(), tasks, new Date("2026-11-05T02:00:00Z")), {});
    const work = second.events![0];
    tasks.push({
      id: work.subject,
      ...JSON.parse(work.detail),
      status: "completed",
      stage: 1,
      assignment: 2,
      approval: null,
      reason: "草稿验收通过",
      reports: [],
    });
    ops.plan("delivered", businesses.list(), tasks, new Date("2026-11-05T03:00:00Z"));
    const plan = ops.snapshot(businesses.list(), tasks, now)[0].plans[0];
    assert.equal(plan.status, "observing");
    assert.equal(plan.outcome, null);
    assert.equal(plan.measure, "首次创建提醒人数");
    businesses.status("app-a", "paused", now);
    assert.deepEqual(ops.plan("paused", businesses.list(), tasks, new Date("2026-11-09T02:00:00Z")), {});
    businesses.status("app-a", "active", now);
    const follow = ops.plan("follow", businesses.list(), tasks, new Date("2026-11-09T02:00:00Z"));
    assert.equal(follow.events?.length, 1);
    const profile = JSON.parse(readFileSync(join(dir, "workspace/knowledge/operations/app-a.json"), "utf8"));
    assert.equal(profile.plans[0].status, "review");
    assert.ok(profile.staff.length === 6);
    assert.deepEqual(businesses.plan("legacy", tasks, now), {});
  } finally {
    ops.close();
    businesses.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle staff skip unchanged data and wake on signals; invalid settings and excess fan-out are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-idle-"));
  const businesses = new Businesses(dir),
    ops = new Operations(dir);
  const tasks: Task[] = [];
  try {
    businesses.save(input, now);
    businesses.autonomy("app-a", true, now);
    businesses.status("app-a", "active", now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      ops.configure("app-a", role, { enabled: false }, now);
    assert.throws(() => ops.configure("app-a", "unknown", { enabled: true }, now));
    const first = ops.plan("a", businesses.list(), tasks, now).events![0];
    tasks.push({
      id: first.subject,
      ...JSON.parse(first.detail),
      status: "completed",
      stage: 0,
      assignment: 1,
      approval: null,
      reason: "无数据",
      reports: [
        {
          role: "growth",
          assignment: 1,
          verdict: "pass",
          summary: "无数据",
          artifacts: [],
          evidence: ["未接入"],
          inspection: { state: "idle", actions: [], reviews: [] },
        },
      ],
    });
    ops.plan("b", businesses.list(), tasks, now);
    assert.deepEqual(ops.plan("c", businesses.list(), tasks, new Date("2026-11-05T02:00:00Z")), {});
    ops.signal(
      "app-a",
      { title: "用户反馈", detail: "首次提醒入口难找", source: "人工整理", role: "growth" },
      new Date("2026-11-05T03:00:00Z"),
    );
    assert.equal(ops.plan("d", businesses.list(), tasks, new Date("2026-11-05T03:15:00Z")).events?.length, 1);
  } finally {
    ops.close();
    businesses.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daily limits and per-project isolation survive later ticks", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-limits-"));
  const businesses = new Businesses(dir),
    ops = new Operations(dir);
  const tasks: Task[] = [];
  const complete = (event: NonNullable<ReturnType<Operations["plan"]>["events"]>[number], decision: any) => {
    const request = JSON.parse(event.detail);
    const role = request.kind.slice(6);
    tasks.push({
      id: event.subject,
      ...request,
      status: "completed",
      stage: 0,
      assignment: 1,
      approval: "DO-NOT-EXPOSE",
      reason: "检查完成",
      reports: [
        {
          role,
          assignment: 1,
          verdict: "pass",
          summary: "检查完成",
          artifacts: [],
          evidence: ["测试资料"],
          inspection: decision,
        },
      ],
    });
  };
  try {
    for (const id of ["app-a", "app-b"]) {
      businesses.save({ ...input, id }, now);
      businesses.autonomy(id, true, now);
      businesses.status(id, "active", now);
      ops.settings(id, { maxDailyTasks: 1, maxActive: 1 }, now);
    }
    const first = ops.plan("first", businesses.list(), tasks, now);
    assert.equal(first.events?.length, 2);
    for (const e of first.events!) complete(e, { state: "action", actions: [proposal], reviews: [] });
    assert.deepEqual(ops.plan("budget", businesses.list(), tasks, now), {});
    const snapshot = ops.snapshot(businesses.list(), tasks, now);
    assert.ok(snapshot.every((p) => p.plans.length === 1 && p.todayTasks === 1));
    assert.notEqual(snapshot[0].plans[0].id, snapshot[1].plans[0].id);
    assert.doesNotMatch(JSON.stringify(snapshot), /DO-NOT-EXPOSE/);
    const tomorrow = new Date("2026-11-05T02:00:00Z");
    businesses.status("app-b", "paused", now);
    const work = ops.plan("next-day", businesses.list(), tasks, tomorrow);
    assert.equal(work.events?.length, 1);
    assert.match(JSON.parse(work.events![0].detail).goal, /app-a.json/);
    assert.deepEqual(ops.plan("again", businesses.list(), tasks, tomorrow), {});
  } finally {
    ops.close();
    businesses.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown outcomes stay under observation and duplicate proposals do not restart completed work", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-outcome-"));
  const businesses = new Businesses(dir),
    ops = new Operations(dir),
    tasks: Task[] = [];
  try {
    businesses.save(input, now);
    businesses.autonomy("app-a", true, now);
    businesses.status("app-a", "active", now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      ops.configure("app-a", role, { enabled: false }, now);
    const first = ops.plan("a", businesses.list(), tasks, now).events![0];
    const check = (event: typeof first, decision: any): Task => ({
      id: event.subject,
      ...JSON.parse(event.detail),
      status: "completed",
      stage: 0,
      assignment: 1,
      approval: null,
      reason: "已检查",
      reports: [
        {
          role: "growth",
          assignment: 1,
          verdict: "pass",
          summary: "已检查",
          artifacts: [],
          evidence: ["测试资料"],
          inspection: decision,
        },
      ],
    });
    tasks.push(check(first, { state: "action", actions: [proposal], reviews: [] }));
    const work = ops.plan("b", businesses.list(), tasks, now).events![0];
    tasks.push({ ...check(work, { state: "idle", actions: [], reviews: [] }), reports: [], stage: 1 });
    ops.plan("c", businesses.list(), tasks, now);
    const due = new Date("2026-11-08T02:00:00Z");
    const follow = ops.plan("d", businesses.list(), tasks, due).events![0];
    const plan = ops.snapshot(businesses.list(), tasks, due)[0].plans[0];
    tasks.push(
      check(follow, {
        state: "action",
        actions: [proposal],
        reviews: [{ key: plan.id, outcome: "unknown", evidence: "尚未发布，无实际数据", nextDays: 5 }],
      }),
    );
    assert.deepEqual(ops.plan("e", businesses.list(), tasks, due), {});
    const state = ops.snapshot(businesses.list(), tasks, due)[0];
    assert.equal(state.plans.length, 1);
    assert.equal(state.plans[0].status, "observing");
    assert.equal(state.plans[0].outcome?.outcome, "unknown");
    assert.equal(state.plans[0].followUpAt, "2026-11-13T02:00:00.000Z");
    assert.equal(state.activity.filter((a) => a.kind === "work").length, 1);
  } finally {
    ops.close();
    businesses.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner resolution resumes a blocked employee check even without a metric change", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-resume-"));
  const b = new Businesses(dir),
    ops = new Operations(dir),
    office = new Company({ name: "测试", database: join(dir, "company.db"), maxAssignments: 6 });
  try {
    b.save(input, now);
    b.autonomy("app-a", true, now);
    b.status("app-a", "active", now);
    for (const role of ["product", "engineering", "qa", "support", "finance"])
      ops.configure("app-a", role, { enabled: false }, now);
    const first = ops.plan("a", b.list(), office.tasks(), now).events![0];
    office.process(ctx(1, "company-inbox", first.type, first.subject, JSON.parse(first.detail)));
    const blocked = office.process(
      ctx(2, "company-growth", "company.result", first.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "需要产品资料",
        artifacts: [],
        evidence: ["说明缺失"],
        inspection: { state: "blocked", actions: [], reviews: [] },
      }),
    );
    assert.equal(blocked.ask?.length, 1);
    assert.deepEqual(ops.plan("waiting", b.list(), office.tasks(), now), {});
    office.process({ events: [], answers: [{ card: 1, choice: 0, about: blocked.ask![0].about }] });
    const resumed = ops.plan("resolved", b.list(), office.tasks(), now);
    assert.equal(resumed.events?.length, 1);
    assert.notEqual(resumed.events![0].subject, first.subject);
  } finally {
    office.close();
    ops.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

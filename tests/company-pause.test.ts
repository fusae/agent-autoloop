// Failure modes: a paused content line writes, publishes, reads the account, sends old cards,
// or reports intentional inactivity as failure; confirmed absence must retry the original task within quota; the same switch must restore normal scheduling.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { pipelineDailyReport, pipelineAlerts } from "../plugins/company/pipeline.ts";
import { pipelineSuppresses } from "../plugins/company/delegation.ts";
import { executePublication, savePublicationAttempt, publicationAttempt } from "../plugins/company/publication.ts";
import { recoverPublications } from "../plugins/company/publication-recovery.ts";
import { readFeedback } from "../plugins/company/verification.ts";

test("pause gates writing, pending confirmations, stale recovery and reports; Binance continues", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-pause-"));
  const cfg = {
    name: "测试",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    pipelineMode: true,
    xiaohongshuPaused: true,
  };
  const set = (paused: boolean) =>
    writeFileSync(join(dir, "company.json"), JSON.stringify({ ...cfg, xiaohongshuPaused: paused }));
  set(true);
  const c = new Company(cfg),
    o = new Operations(dir),
    b = new Businesses(dir);
  try {
    for (const id of ["jinzhao", "rabbitrun"]) {
      b.save({ id, name: id, description: id, audience: "用户", objective: "内容", stage: "operating" });
      b.autonomy(id, true);
      b.status(id, "active");
    }
    const now = new Date("2026-11-16T02:00:00Z");
    const tick = o.plan("pause", b.list(), [], now);
    assert.ok(tick.events?.some((e) => e.summary.startsWith("rabbitrun")));
    assert.ok(!tick.events?.some((e) => e.summary.startsWith("jinzhao")));
    const key = "a".repeat(32);
    mkdirSync(join(dir, "publications"), { recursive: true });
    writeFileSync(
      join(dir, "publications", key + ".json"),
      JSON.stringify({ key, business: "jinzhao", artifacts: [] }),
    );
    savePublicationAttempt(dir, { key, channel: "小红书", state: "unknown", at: "2026-11-14T02:00:00Z", checks: 0 });
    assert.throws(() => executePublication(dir, key), /暂停中（养号）/);
    assert.throws(() => executePublication(dir, key, true), /暂停中（养号）/);
    recoverPublications(
      dir,
      { tasks: () => [{ kind: "publish-content", publication: key, status: "blocked" }] } as any,
      {} as any,
      now,
      () => {
        throw Error("browser must not run");
      },
    );
    assert.equal(publicationAttempt(dir, key)?.checks, 0);
    assert.deepEqual(readFeedback(dir, []), { state: "blocked", reason: "暂停中（养号）" });
    for (const card of [
      { title: "今朝选题", text: "选择" },
      { title: "发布确认", text: `稿件\n发布稿件：${key}` },
      { title: "内容流水线停摆提醒", text: "小红书线" },
      { title: "待维护者处理", text: "登录失效" },
    ])
      assert.equal(pipelineSuppresses(dir, { ...card, kind: "ask" }), true);
    const projects = o.snapshot(b.list(), []);
    const p = projects.find((p) => p.business === "jinzhao")!;
    p.plans.push({
      id: "old",
      title: "旧稿",
      status: "blocked",
      result: "登录失效",
      blockedAt: "2026-11-14T01:00:00Z",
    } as any);
    assert.ok(!pipelineAlerts(dir, projects, [], now).some((a) => a.text.includes("小红书")));
    const report = pipelineDailyReport(dir, "2026-11-16", [], projects, ["小红书登录失效", "币安问题"]);
    assert.match(report, /小红书\n暂停中（养号）/);
    assert.doesNotMatch(report, /登录失效|旧稿|小红书 \d/);
    assert.match(report, /币安问题/);
    set(false);
    const resumed = o.plan("resume", b.list(), [], now);
    assert.ok(resumed.events?.some((e) => e.summary.startsWith("jinzhao")));
    assert.ok(pipelineAlerts(dir, projects, [], now).some((a) => a.text.includes("小红书")));
    assert.equal(pipelineSuppresses(dir, { title: "今朝选题", text: "选择", kind: "ask" }), false);
  } finally {
    c.close();
    o.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed absent publication resumes its existing task once after the daily quota gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-resume-"));
  const cfg = {
    name: "测试",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    pipelineMode: true,
    publishDailyLimit: 1,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const c = new Company(cfg),
    o = new Operations(dir),
    b = new Businesses(dir);
  try {
    const key = "b".repeat(32),
      id = "P-" + createHash("sha256").update(key).digest("hex").slice(0, 32);
    const now = new Date("2026-11-15T05:00:00Z");
    b.save({
      id: "rabbitrun",
      name: "币安",
      description: "内容",
      audience: "用户",
      objective: "内容",
      stage: "operating",
    });
    b.autonomy("rabbitrun", true);
    b.status("rabbitrun", "active");
    c.process({
      events: [
        {
          id: "create",
          source: "company-inbox",
          type: "company.task.create",
          subject: id,
          detail: JSON.stringify({
            title: "原稿",
            goal: "发布原稿",
            kind: "publish-content",
            acceptance: ["平台回执"],
            publication: key,
          }),
        },
      ],
      answers: [],
    });
    c.process({
      events: [
        {
          id: "failed",
          source: "company-inbox",
          type: "company.task.failed",
          subject: id,
          detail: JSON.stringify({ assignment: 1, reason: "未知" }),
        },
      ],
      answers: [],
    });
    const project = o.snapshot(b.list(), c.tasks(), now)[0];
    project.plans = [
      {
        id: "plan",
        title: "原稿",
        kind: "content",
        owner: "growth",
        status: "blocked",
        task: id,
        deliveryTask: "writer",
        publicationKey: key,
        pipelineChecked: key,
        deliveryDecision: "publish",
        result: "未知",
        pipelineDate: "2026-11-15",
        acceptance: ["平台回执"],
      } as any,
    ];
    const db = new DatabaseSync(join(dir, "operations.db"));
    db.prepare("INSERT OR REPLACE INTO projects(id,body) VALUES ('rabbitrun',?)").run(JSON.stringify(project));
    db.close();
    mkdirSync(join(dir, "publications"));
    writeFileSync(
      join(dir, "publications", key + ".json"),
      JSON.stringify({ key, business: "rabbitrun", artifacts: [] }),
    );
    writeFileSync(join(dir, "publishing.json"), JSON.stringify({ projects: { rabbitrun: { channel: "币安" } } }));
    savePublicationAttempt(dir, { key, channel: "币安", state: "absent", at: now.toISOString(), checks: 0 });
    o.retryPublication(key, now);
    const r = o.plan("retry", b.list(), c.tasks(), now);
    assert.equal(r.events?.length, 1);
    assert.equal(r.events[0].type, "company.task.retry");
    assert.equal(r.events[0].subject, id);
    c.process({ events: r.events.map((e) => ({ ...e, source: "company-inbox" })), answers: [] });
    assert.equal(c.task(id)?.assignment, 2);
    assert.equal(o.plan("again", b.list(), c.tasks(), now).events, undefined);
  } finally {
    c.close();
    o.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

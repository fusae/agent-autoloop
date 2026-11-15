// Failure modes: a paused content line writes, publishes, reads the account, sends old cards,
// or reports intentional inactivity as failure; the same switch must restore normal scheduling.
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

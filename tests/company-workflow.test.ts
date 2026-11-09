// Failure modes: individually valid stages do not connect across three businesses, day/week rollover,
// rewrites, failed CEO attempts, publication caps, weekly reports and restarts. All actors and receipts are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";
import { permissions, localDay, weekOf, draftStock } from "../plugins/company/workday.ts";
import { publicationResults } from "../plugins/company/publication-policy.ts";
import { reviewVersion } from "../plugins/company/review-version.ts";
import { registeredReview } from "../plugins/company/weekly.ts";
import { rabbitChannel } from "../plugins/company/rabbitrun.ts";
import { collectFeedback } from "../plugins/company/feedback.ts";
import { parseResult } from "../protocol/validate.ts";

const empty = () => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [] });
test("offline week connects topics, rewrites, shared XHS cap, rabbitrun, notes and Friday reporting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-workflow-"));
  const ids = ["jizhu", "jinzhao", "rabbitrun"];
  let now = new Date("2026-11-09T01:00:00Z"),
    seq = 0,
    card = 100;
  const cfg: CompanyConfig = {
    name: "离线公司",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    contentReview: "ceo",
    publishVerification: "program",
    activeRoles: ["growth"],
    dailyPlanning: true,
    inspections: false,
    ceoWake: "events",
    permissions,
    workday: { enabled: true, after: "09:00", startDate: "2026-11-09", prepareDrafts: true },
    topics: { startAt: "2026-11-09T00:00:00Z" },
    reporting: { enabled: true, weekly: true },
    health: { enabled: true },
    publishDailyLimit: 1,
    publishApproval: { confirmFirst: 5, preview: true },
    publishPolicies: { rabbitrun: { dailyLimit: 1, alwaysConfirm: true } },
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  writeFileSync(
    join(dir, "publishing.json"),
    JSON.stringify({
      projects: Object.fromEntries(
        ids.map((id) => [id, { channel: id === "rabbitrun" ? rabbitChannel : "共用小红书" }]),
      ),
    }),
  );
  writeFileSync(join(dir, "feedback.json"), JSON.stringify({ enabled: true }));
  let c = new Company(cfg),
    o = new Operations(dir);
  const b = new Businesses(dir);
  const notices: { title: string; at: string; key?: string }[] = [];
  const queued: NonNullable<Receipt["events"]> = [];
  const answers: any[] = [];
  let revised = false,
    failedCEO = false;
  const enqueue = (r: Receipt) => {
    parseResult({ outcome: "done", ...r });
    queued.push(...(r.events ?? []));
    for (const n of r.notice ?? []) notices.push({ title: n.title, at: now.toISOString(), key: n.key });
    for (const a of r.ask ?? []) answers.push({ card: ++card, about: a.about, choice: 0, at: now.toISOString() });
  };
  const send = (source: string, type: string, subject: string, data: any) =>
    enqueue(
      c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, now),
    );
  const projectFor = (task: string) =>
    o.snapshot(b.list(), c.tasks(), now).find((p) => p.activity.some((a) => a.task === task));
  const complete = (task: string, data: any, source = "company-growth") => {
    const t = c.task(task)!;
    send(source, "company.result", task, {
      assignment: t.assignment,
      verdict: "pass",
      summary: "离线交付",
      artifacts: [],
      evidence: ["合成测试资料"],
      ...data,
    });
    assert.notEqual(c.task(task)!.status, "blocked", c.task(task)!.reason);
  };
  const execute = (e: NonNullable<Receipt["events"]>[number]) => {
    if (["company.task.create", "company.task.retry"].includes(e.type)) {
      send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
      return;
    }
    if (!e.type.startsWith("company.work.")) return;
    const t = c.task(e.subject)!,
      p = projectFor(t.id);
    if (t.kind === "ceo") {
      if (!failedCEO) {
        failedCEO = true;
        send("company-inbox", "company.task.failed", t.id, {
          assignment: t.assignment,
          reason: "运行失败：离线模拟临时超时",
        });
        return;
      }
      const v = o.reviewContext(b.list(), c.tasks(), now);
      const d: any = empty();
      if (t.id.startsWith("REPORT-")) {
        d.report = "各业务按真实测试回执统计，未知数据保留未知。";
        const r = JSON.parse(readFileSync(join(dir, "workspace/knowledge/reporting.json"), "utf8"));
        complete(
          t.id,
          {
            executive: d,
            ...(r.cycle
              ? { retrospective: { review: "本周复盘", notes: "保留董事长意见及退稿经验", through: r.notes.through } }
              : {}),
          },
          "company-ceo",
        );
        return;
      }
      d.staffPlans = v.missingDailyPlans
        ?.filter(() => now >= new Date(`${localDay(now)}T09:00:00+08:00`))
        .map((s) => ({
          business: s.business,
          role: s.role,
          date: localDay(now),
          goal: "按周目标推进",
          focus: "处理已批准稿件",
          doneWhen: "真实回执",
          mode: "followup",
          reviewAt: new Date(+now + 3600000).toISOString(),
        }));
      d.weeklyGoals = v.missingWeeklyGoals?.map((s) => ({
        business: s.business,
        role: s.role,
        week: weekOf(now),
        direction: "真实体验",
        metrics: [{ name: "发帖", target: s.business === "rabbitrun" ? 7 : 2, unit: "篇" }],
      }));
      d.topicReviews = v.projects.flatMap((p) =>
        (p.topics ?? [])
          .filter((t) => t.state === "screening")
          .map((t) => ({ business: p.business, topic: t.id, approve: true, reason: "依据充分", rank: 1 })),
      );
      d.deliveries = v.projects.flatMap((p) =>
        p.plans
          .filter((a) => a.status === "delivered")
          .map((a) => {
            const revise = p.business === "jizhu" && !revised;
            if (revise) revised = true;
            return {
              business: p.business,
              plan: a.id,
              task: a.task,
              reviewVersion: reviewVersion(c.task(a.task!)!),
              verdict: revise ? "revise" : "publish",
              reason: revise ? "补充真实过程" : "核对通过",
              files: c.task(a.task!)!.reports.at(-1)!.artifacts,
            };
          }),
      );
      complete(t.id, { executive: d }, "company-ceo");
      return;
    }
    const weekly = registeredReview(dir, t.id);
    if (weekly) {
      complete(t.id, {
        inspection: { state: "idle", actions: [], reviews: [] },
        retrospective: { review: "本周成绩与未知项", notes: "保留固定事实与经验", through: weekly.through },
      });
      return;
    }
    assert.ok(p, t.id);
    if (t.kind === "publish-content") {
      const key = t.publication!;
      if (t.stage === 0) {
        const proof = {
          key,
          channel: p.business === "rabbitrun" ? rabbitChannel : "共用小红书",
          remoteId: key,
          url: `https://example.com/${key}`,
          publishedAt: now.toISOString(),
          ...(p.business === "rabbitrun" ? { x: { state: "pending", attempts: 0, at: now.toISOString() } } : {}),
        };
        writeFileSync(join(dir, "publications", `${key}-result.json`), JSON.stringify(proof));
      }
      const proof = JSON.parse(readFileSync(join(dir, "publications", `${key}-result.json`), "utf8"));
      complete(
        t.id,
        { publication: proof, artifacts: [`tasks/${t.id}/proof.json`] },
        t.stage === 0 ? "company-growth" : "company-verifier",
      );
      return;
    }
    if (t.kind.startsWith("workday-") || t.kind.startsWith("check-")) {
      const available = (p.topics ?? []).find((t) => t.state === "approved" && !t.plan);
      const stock = draftStock(
        p.plans,
        p.staff.find((s) => s.role === "growth")?.weeklyGoal,
        publicationResults(dir),
        now,
      );
      let topics: any[] = [],
        actions: any[] = [];
      if (/选题会|补报选题|选题换题/.test(t.title))
        topics = Array.from(
          { length: Math.min(10, Math.max(0, (stock.target ?? 0) - stock.published - stock.ready - stock.making) + 1) },
          (_, i) => ({
            key: `t${seq}_${i}`,
            title: "真实体验",
            angle: "具体过程",
            reason: "工作笔记",
            outline: "问题与验证",
            app: p.business,
            platform: p.business === "rabbitrun" ? "币安与X" : "小红书",
          }),
        );
      else if (t.title.includes("选题池取题") && available)
        actions = [
          {
            key: `write_${available.id}`,
            topic: available.id,
            operation: "write",
            kind: "content",
            title: "图文",
            goal: "写真实过程",
            acceptance: ["内容完整"],
            priority: 1,
            dueDays: 1,
            followUpDays: 3,
            measure: "已发回执",
          },
        ];
      complete(t.id, { inspection: { state: actions.length ? "action" : "idle", actions, reviews: [], topics } });
      return;
    }
    const a = p.plans.find((a) => a.task === t.id)!;
    const path = `tasks/${t.id}/${p.business === "rabbitrun" ? "rabbitrun" : "xiaohongshu"}.json`;
    mkdirSync(join(dir, "workspace/tasks", t.id), { recursive: true });
    writeFileSync(
      join(dir, "workspace", path),
      JSON.stringify({ title: "真实体验", content: `离线测试正文，版本${a.revision ?? 0}。`, images: [] }),
    );
    complete(t.id, { artifacts: [path], topic: a.topic });
  };
  try {
    for (const id of ids) {
      b.save(
        { id, name: id, description: "离线样例", audience: "测试", objective: "真实体验", stage: "operating" },
        now,
      );
      b.autonomy(id, true, now);
      b.status(id, "active", now);
    }
    o.leadership(true, now);
    o.seedWeeklyGoals(
      ids.map((business) => ({
        business,
        role: "growth",
        week: weekOf(now),
        direction: "真实体验",
        metrics: [{ name: "发帖", target: business === "rabbitrun" ? 7 : 2, unit: "篇" }],
      })),
      now,
    );
    for (let step = 0; step <= 7 * 96 + 2; step++) {
      now = new Date(Date.parse("2026-11-09T00:45:00Z") + step * 900000);
      if (step === 210) {
        o.close();
        c.close();
        o = new Operations(dir);
        c = new Company(cfg);
      }
      enqueue(
        o.plan(
          `tick-${++seq}`,
          b.list(),
          c.tasks(),
          now,
          now >= new Date("2026-11-09T02:00:00Z") ? answers.splice(0) : [],
        ),
      );
      for (let n = 0; queued.length; n++) {
        assert.ok(n < 100, "a tick must settle without an event loop");
        execute(queued.shift()!);
      }
      await collectFeedback(dir, o.executive(), now, () => ({ state: "unknown", reason: "离线测试不访问平台" }));
      for (const p of o.snapshot(b.list(), c.tasks(), now)) {
        const stock = draftStock(
          p.plans,
          p.staff.find((s) => s.role === "growth")?.weeklyGoal,
          publicationResults(dir),
          now,
        );
        assert.ok(stock.ready + stock.making <= 2, `${p.business} draft cap`);
        if (now < new Date("2026-11-09T02:00:00Z"))
          assert.ok(!p.plans.length, "no draft before synthetic chairman approval");
      }
    }
    const proofs = publicationResults(dir);
    assert.equal(proofs.filter((p) => p.channel === "共用小红书").length, 4);
    assert.equal(proofs.filter((p) => p.x).length, 7);
    const daily = new Map<string, number>();
    for (const p of proofs) {
      const key = `${p.channel}:${localDay(new Date(p.publishedAt))}`;
      daily.set(key, (daily.get(key) ?? 0) + 1);
    }
    assert.ok([...daily.values()].every((n) => n === 1));
    assert.ok(
      proofs.filter((p) => p.x).every((p) => p.x!.state === "pending"),
      "only chairman's separate X callback may complete it",
    );
    assert.ok(revised && failedCEO);
    assert.equal(notices.filter((n) => n.title === "CEO · 日报+周报").length, 1);
    assert.ok(
      notices
        .filter((n) => n.title === "CEO · 日报+周报")
        .every((n) => Date.parse(n.at) >= Date.parse("2026-11-13T13:00:00Z")),
    );
    assert.equal(o.executive().weeklyCycles?.[0].staff.filter((s) => s.result).length, 3);
    assert.ok(o.notes("jizhu:growth").text.length);
    assert.ok(
      o
        .reviewContext(b.list(), c.tasks(), now)
        .projects.every((p) => p.staff.find((s) => s.role === "growth")?.weeklyGoal?.week === "2026-11-16"),
    );
  } finally {
    o.close();
    c.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

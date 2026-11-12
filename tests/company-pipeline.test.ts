// Failure modes: disabled management still dispatches models, drafts bypass checks/owner approval,
// returns loop forever, legacy rabbitrun drafts disappear, paused projects notify, or reports need model JSON.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { checkRabbitCompliance, recentPipelinePosts, pipelineDailyReport } from "../plugins/company/pipeline.ts";
import { pipelineSuppresses } from "../plugins/company/delegation.ts";
import { permissions } from "../plugins/company/workday.ts";
import { rabbitChannel } from "../plugins/company/rabbitrun.ts";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";
import { parseResult } from "../protocol/validate.ts";

const png = Buffer.from("89504e470d0a1a0a0001", "hex");
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function fixture(fn: (f: ReturnType<typeof create>) => void) {
  const f = create();
  try {
    fn(f);
  } finally {
    f.c.close();
    f.o.close();
    f.b.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
}
function create() {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-"));
  const cfg: CompanyConfig = {
    name: "测试",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    pipelineMode: true,
    ceoMode: true,
    jinzhaoWriting: true,
    contentReview: "ceo",
    publishVerification: "program",
    reporting: { enabled: true, weekly: true },
    workday: { enabled: true, after: "09:00", startDate: "2026-11-13" },
    permissions,
    dailyPlanning: true,
    proactiveCEO: true,
    delegation: { source: "测试", confirmPublish: ["jinzhao", "rabbitrun"] },
    topics: { startAt: "2026-11-01T00:00:00Z" },
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  mkdirSync(join(dir, "workspace/knowledge/assets/jinzhao-compare"), { recursive: true });
  const compare = "## App 改写版 A2\n\nI read a book.";
  writeFileSync(join(dir, "workspace/knowledge/assets/jinzhao-compare/compare.md"), compare);
  writeFileSync(join(dir, "workspace/knowledge/jinzhao-stories.md"), "### S1 故事\n真实素材");
  writeFileSync(
    join(dir, "jinzhao-writing-assets.json"),
    JSON.stringify({ compareSha256: digest(compare), images: [{ sha256: digest(png), level: "A2" }] }),
  );
  writeFileSync(
    join(dir, "publishing.json"),
    JSON.stringify({ projects: { jinzhao: { channel: "小红书" }, rabbitrun: { channel: rabbitChannel } } }),
  );
  const c = new Company(cfg),
    o = new Operations(dir),
    b = new Businesses(dir);
  for (const id of ["jinzhao", "rabbitrun", "jizhu"]) {
    b.save({ id, name: id, description: id, audience: "用户", objective: "内容", stage: "operating" });
    b.autonomy(id, true);
    b.status(id, id === "jizhu" ? "paused" : "active");
  }
  o.leadership(true);
  let seq = 0;
  const tick = (at: string, answers: any[] = []) =>
    o.plan(`batch-${++seq}`, b.list(), c.tasks(), new Date(at), answers);
  const accept = (r: Receipt) => {
    parseResult({ outcome: "done", ...r });
    for (const e of r.events ?? []) c.process({ events: [{ ...e, id: ++seq, source: "company-inbox" }], answers: [] });
  };
  const complete = (id: string, business: string, bad = false) => {
    const path = `tasks/${id}/${business === "jinzhao" ? "xiaohongshu" : "rabbitrun"}.json`;
    mkdirSync(join(dir, "workspace/tasks", id), { recursive: true });
    const common = {
      title: bad ? "不合格？" : `${business}内容`,
      content: "阅读笔记".repeat(80) + "目前只有安卓，感兴趣的可以私我安装。",
      images: [],
      angle: "从真实使用过程说明具体问题",
      duplicateCheck: [],
    };
    writeFileSync(
      join(dir, "workspace", path),
      JSON.stringify(
        business === "rabbitrun"
          ? common
          : {
              ...common,
              content: common.content + "jinzhao阅读内容。#英语阅读 #英文原著 #生词",
              images: [1, 2].map(() => ({ mime: "image/png", base64: png.toString("base64") })),
              stories: ["S1"],
              comparison: { image: 1, level: "A2", rewrite: "I read a book." },
            },
      ),
    );
    return c.process(
      {
        events: [
          {
            id: ++seq,
            source: "company-growth",
            type: "company.result",
            subject: id,
            detail: JSON.stringify({
              assignment: c.task(id)!.assignment,
              verdict: "pass",
              summary: "写完",
              artifacts: [path],
              evidence: ["自查"],
            }),
          },
        ],
        answers: [],
      },
      new Date("2026-11-13T02:00:00Z"),
    );
  };
  return { dir, cfg, c, o, b, tick, accept, complete };
}

test("weekday 09:30 direct writing, program checks, owner return once, deterministic report and restart", () =>
  fixture((f) => {
    assert.deepEqual(f.tick("2026-11-12T02:00:00Z").events ?? [], []);
    assert.deepEqual(f.tick("2026-11-13T01:29:00Z").events ?? [], []);
    let r = f.tick("2026-11-13T01:30:00Z");
    f.accept(r);
    const write = r.events!.find((e) => e.summary.startsWith("jinzhao"))!;
    assert.equal(JSON.parse(write.detail).kind, "staff-growth");
    f.complete(write.subject, "jinzhao");
    r = f.tick("2026-11-13T02:01:00Z");
    f.accept(r);
    assert.equal(r.ask?.[0].title, "发布确认");
    assert.ok(!r.events?.some((e) => JSON.parse(e.detail).kind === "publish-content"));
    const first = r.ask![0];
    r = f.tick("2026-11-13T02:02:00Z", [{ card: 1, about: first.about, choice: 1, text: "开头请换具体场景" }]);
    f.accept(r);
    const revision = r.events!.find((e) => JSON.parse(e.detail).kind === "staff-growth")!;
    assert.match(revision.detail, /开头请换具体场景/);
    f.complete(revision.subject, "jinzhao");
    r = f.tick("2026-11-13T02:03:00Z");
    assert.equal(r.ask?.length, 1);
    assert.notEqual(r.ask![0].about, first.about);
    const second = r.ask![0];
    r = f.tick("2026-11-13T02:04:00Z", [{ card: 2, about: second.about, choice: 0 }]);
    assert.ok(r.events?.some((e) => JSON.parse(e.detail).kind === "publish-content"));
    f.accept(r);
    assert.ok(!f.tick("2026-11-13T02:05:00Z", [{ card: 2, about: second.about, choice: 0 }]).events?.length);
    r = f.tick("2026-11-13T12:30:00Z");
    assert.equal(r.notice?.[0].title, "CEO · 日报");
    for (const word of ["今天写了什么", "发了什么", "程序退回原因", "待董事长确认", "X 待发", "异常"])
      assert.match(r.notice![0].text, new RegExp(word));
    assert.ok(!r.events?.some((e) => JSON.parse(e.detail).kind === "ceo"));
    const restarted = new Operations(f.dir);
    try {
      assert.ok(
        !restarted.plan("restart-report", f.b.list(), f.c.tasks(), new Date("2026-11-13T13:00:00Z")).notice?.length,
      );
    } finally {
      restarted.close();
    }
  }));

test("program rejects twice then abandons the day; CEO and topic settings cannot restore management", () =>
  fixture((f) => {
    const r = f.tick("2026-11-13T01:30:00Z");
    f.accept(r);
    const id = r.events![0].subject;
    for (let n = 0; n < 3; n++) {
      const returned = f.complete(id, "jinzhao", true);
      assert.equal(returned.events?.length ?? 0, n < 2 ? 1 : 0);
    }
    assert.equal(f.c.task(id)!.assignment, 3);
    f.tick("2026-11-13T02:10:00Z");
    const p = f.o.snapshot(f.b.list(), f.c.tasks()).find((p) => p.business === "jinzhao")!;
    assert.equal(p.plans[0].status, "closed");
    assert.match(p.plans[0].result, /当天放弃/);
    assert.ok(!f.tick("2026-11-13T03:00:00Z").events?.some((e) => e.summary.startsWith("jinzhao")));
    const ceo = f.c.process({
      events: [
        {
          id: "old-ceo",
          source: "company-inbox",
          type: "company.task.create",
          subject: "old-ceo",
          detail: JSON.stringify({ title: "旧日报", kind: "ceo", goal: "管理", acceptance: ["汇报"] }),
        },
      ],
      answers: [],
    });
    assert.ok(!ceo.events?.length);
  }));

test("rabbitrun passes straight to publisher despite legacy confirmation policy; weekends skip jinzhao", () =>
  fixture((f) => {
    const r = f.tick("2026-11-14T01:30:00Z");
    f.accept(r);
    assert.equal(r.events?.length, 1);
    assert.match(r.events![0].summary, /^rabbitrun/);
    f.complete(r.events![0].subject, "rabbitrun");
    const next = f.tick("2026-11-14T02:00:00Z");
    assert.ok(!next.ask?.length);
    assert.equal(JSON.parse(next.events![0].detail).kind, "publish-content");
  }));

test("manual posts participate in latest ten; compliance red lines and notification suppression", () =>
  fixture((f) => {
    writeFileSync(
      join(f.dir, "workspace/knowledge/feedback.json"),
      JSON.stringify({
        manual: Array.from({ length: 12 }, (_, i) => ({
          id: String(i),
          title: `手动${i}`,
          firstSeen: `2026-11-${String(i + 1).padStart(2, "0")}T01:00:00Z`,
        })),
      }),
    );
    const recent = recentPipelinePosts(f.dir, "jinzhao");
    assert.equal(recent.length, 10);
    assert.equal(recent[0].title, "手动11");
    for (const bad of ["必涨", "推荐买入BTC", "返佣链接", "保证收益", "内幕消息", "私钥：abcdef"])
      assert.ok(
        checkRabbitCompliance({ title: "测试", content: "正文".repeat(170) + bad }).some((e) =>
          e.startsWith("合规红线"),
        ),
      );
    assert.equal(pipelineSuppresses(f.dir, { title: "CEO · 本人验证", text: "记住需要验证", kind: "ask" }), true);
    assert.equal(pipelineSuppresses(f.dir, { title: "CEO · 日报", text: "日报", kind: "notice" }), false);
    const text = pipelineDailyReport(f.dir, "2026-11-11", f.c.tasks(), []);
    assert.match(text, /首次采集的手动帖，发帖日期未知/);
  }));

test("generated rules remove all CEO routes and retain configured Sonnet writer", () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-rules-")),
    dir = join(root, "company");
  try {
    initialize(dir, "local", "claude");
    mkdirSync(join(dir, "hub"));
    const rules = JSON.parse(readFileSync(join(dir, "rules.company.json"), "utf8"));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    const cfg = JSON.parse(readFileSync(join(dir, "company.json"), "utf8"));
    Object.assign(cfg, {
      pipelineMode: true,
      ceoMode: true,
      dailyModelRuns: { total: 20 },
      staffModels: { jinzhao: { growth: { engine: "claude", model: "sonnet" } } },
    });
    writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
    ensureBusinessRules(dir);
    const next = JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8"));
    assert.ok(!next.rules.some((r: any) => r.to === "company-ceo"));
    assert.equal(next.agents["company-staff-jinzhao-growth"].model, "sonnet");
    assert.match(next.rules.find((r: any) => r.to === "company-staff-jinzhao-growth").prompt, /内容流水线规范/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large maintenance backlog still produces a protocol-valid fixed report", () =>
  fixture((f) => {
    const text = pipelineDailyReport(
      f.dir,
      "2026-11-11",
      [],
      [],
      Array.from({ length: 50 }, (_, n) => `${n}：${"异常".repeat(1000)}`),
    );
    parseResult({ outcome: "done", notice: [{ key: "report", title: "CEO · 日报", text }] });
    assert.match(text, /完整记录见后台/);
  }));

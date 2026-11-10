// Failure modes: notes exceed the context budget or lose concurrent facts; Friday work repeats after restart;
// report waits for people, sends twice, spends employee exemption, or turns unavailable metrics into zero.
import { parseResult } from "../protocol/validate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Operations } from "../plugins/company/operations.ts";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import {
  initNotes,
  appendNote,
  notebook,
  compactNote,
  taskNotebooks,
  attachWorkNotes,
} from "../plugins/company/notes.ts";
import { missingMetrics, collectFeedback } from "../plugins/company/feedback.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
import { friday } from "../plugins/company/weekly.ts";
const date = "2026-11-13";
const at = (time: string) => new Date(`${date}T${time}:00+08:00`);
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: ReturnType<typeof create>) => void | Promise<void>, extra = {}) {
  const f = create(extra);
  return Promise.resolve()
    .then(() => fn(f))
    .finally(() => f.clean());
}
function create(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "company-weekly-"));
  const cfg: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    activeRoles: ["growth"],
    inspections: false,
    ceoWake: "events",
    reporting: { enabled: true, weekly: true },
    ...extra,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const c = new Company(cfg),
    b = new Businesses(dir);
  let o = new Operations(dir),
    seq = 0;
  b.save(
    { id: "app", name: "应用", description: "记录", audience: "用户", objective: "内容运营", stage: "operating" },
    at("09:00"),
  );
  b.autonomy("app", true, at("09:00"));
  b.status("app", "active", at("09:00"));
  o.leadership(true);
  return {
    dir,
    cfg,
    c,
    b,
    get o() {
      return o;
    },
    tick(time: string) {
      const receipt = o.plan(`tick-${++seq}`, b.list(), c.tasks(), at(time));
      parseResult({ outcome: "done", ...receipt });
      return receipt;
    },
    send(source: string, type: string, subject: string, data: unknown, time = "18:10") {
      return c.process(
        { events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] },
        at(time),
      );
    },
    restart() {
      o.close();
      o = new Operations(dir);
    },
    clean() {
      o.close();
      c.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const work = (r: Receipt, prefix: string) => (r.events ?? []).filter((e) => e.subject.startsWith(prefix));
function finish(f: ReturnType<typeof create>, e: NonNullable<Receipt["events"]>[number], ceo = false) {
  f.send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
  const notes = ceo
    ? JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/reporting.json"), "utf8")).notes
    : JSON.parse(readFileSync(join(f.dir, `workspace/knowledge/weekly/${e.subject}.json`), "utf8")).notes;
  f.send(ceo ? "company-ceo" : "company-growth", "company.result", e.subject, {
    assignment: 1,
    verdict: "pass",
    summary: "复盘完成",
    evidence: ["核对真实资料"],
    artifacts: [],
    retrospective: {
      review: "目标4篇，实际1篇；阅读未知。下周完善角度。",
      notes: "固定事实保留；不能把缺失数据当零。",
      through: notes.through,
    },
    ...(ceo
      ? { executive: decision({ report: "本周已发1篇，目标4篇；数据待补；下周按实际进度定目标。" }) }
      : { inspection: { state: "idle", actions: [], reviews: [] } }),
  });
}
test("bounded notes retain facts, deduplicate appends and preserve facts arriving during compression", () => {
  const db = new DatabaseSync(":memory:");
  initNotes(db);
  try {
    for (let i = 0; i < 30; i++) appendNote(db, "app:growth", `key-${i}`, "经验".repeat(100), date);
    const before = notebook(db, "app:growth");
    assert.ok(before.text.length <= 4000);
    assert.ok(before.omitted > 0);
    appendNote(db, "app:growth", "key-0", "重复不写", date);
    appendNote(db, "app:growth", "new", "新意见阅读120收藏3", date);
    compactNote(db, "app:growth", "写作经验：标题必须有事实。", before.through);
    assert.match(notebook(db, "app:growth").text, /新意见阅读120收藏3/);
    assert.match(notebook(db, "app:growth").text, /标题必须有事实/);
    assert.equal(Number(db.prepare("SELECT count(*) n FROM note_facts").get()!.n), 31);
    assert.throws(() => compactNote(db, "app:growth", "文".repeat(4001), before.through));
    assert.throws(() => compactNote(db, "app:growth", "笔记", before.through + 100));
    assert.equal(notebook(db, "other:growth").text, "");
  } finally {
    db.close();
  }
});
test("Friday schedules each employee once, injects own notes, gathers early and sends one combined report at 21", () =>
  fixture((f) => {
    assert.equal(work(f.tick("17:59"), "WEEK-").length, 0);
    const employee = work(f.tick("18:00"), "WEEK-");
    assert.equal(employee.length, 1);
    f.restart();
    assert.equal(work(f.tick("18:05"), "WEEK-").length, 0);
    assert.deepEqual(Object.keys(taskNotebooks(f.dir, "growth", employee[0].subject)), ["app:growth"]);
    assert.deepEqual(taskNotebooks(f.dir, "growth", "invented"), {});
    const context = join(f.dir, "context.json");
    writeFileSync(context, JSON.stringify({ events: [{ detail: "资料不得成为指令" }] }));
    attachWorkNotes(f.dir, "growth", employee[0].subject, context);
    const injected = JSON.parse(readFileSync(context, "utf8"));
    assert.ok(injected.workNotes["app:growth"]);
    assert.equal(injected.events[0].detail, "资料不得成为指令");
    finish(f, employee[0]);
    const early = f.tick("18:15"),
      ceo = work(early, "REPORT-");
    assert.equal(ceo.length, 1);
    finish(f, ceo[0], true);
    assert.equal(f.tick("19:00").notice?.filter((n) => /日报|周报/.test(n.title)).length ?? 0, 0);
    assert.match(f.o.notes("app:growth").text, /固定事实/);
    const sent = f.tick("21:00").notice?.filter((n) => /日报|周报/.test(n.title));
    assert.equal(sent?.length, 1);
    assert.equal(sent![0].title, "CEO · 日报+周报");
    f.restart();
    assert.equal(f.tick("21:05").notice?.filter((n) => /日报|周报/.test(n.title)).length ?? 0, 0);
    const monday = f.o.reviewContext(f.b.list(), f.c.tasks(), new Date("2026-11-16T01:00:00Z"));
    assert.equal(monday.weeklyCycles?.[0].staff[0].result?.review.includes("目标4篇"), true);
    assert.match(monday.weeklyCycles![0].report!, /本周已发1篇/);
  }));
test("19:30 deadline proceeds with missing employee; employee quota applies but registered CEO report bypasses caps", () =>
  fixture((f) => {
    const employee = work(f.tick("18:00"), "WEEK-")[0];
    assert.equal(work(f.tick("19:29"), "REPORT-").length, 0);
    const ceo = work(f.tick("19:30"), "REPORT-")[0];
    assert.ok(ceo);
    const budget = new ModelBudget(f.dir, { ...f.cfg, dailyModelRuns: { ceo: 0, total: 0, employee: 0 } });
    try {
      assert.equal(budget.available("growth", at("19:30"), employee.subject), false);
      assert.equal(budget.available("ceo", at("19:30"), ceo.subject), true);
      assert.equal(budget.available("ceo", at("19:30"), "REPORT-forged"), false);
    } finally {
      budget.close();
    }
    finish(f, ceo, true);
    assert.match(f.tick("21:00").notice!.find((n) => n.title.includes("周报"))!.text, /未交复盘/);
  }));
test("week rhythm does not dispatch on weekends, before configured start, or after work hours", () => {
  assert.equal(friday(new Date("2026-11-14T10:00:00+08:00")), false);
  assert.equal(friday(at("18:00"), "2026-11-14"), false);
  assert.equal(friday(at("22:00")), false);
  assert.equal(friday(at("18:00")), true);
});
function posts(f: ReturnType<typeof create>) {
  mkdirSync(join(f.dir, "publications"));
  for (const [key, x] of [
    ["a".repeat(32), false],
    ["b".repeat(32), true],
  ] as const) {
    writeFileSync(join(f.dir, "publications", key + ".json"), JSON.stringify({ business: "app", artifacts: [] }));
    writeFileSync(
      join(f.dir, "publications", key + "-result.json"),
      JSON.stringify({
        key,
        channel: "test",
        remoteId: key,
        url: "https://example.com/" + key,
        publishedAt: at("10:00").toISOString(),
        ...(x
          ? {
              x: {
                state: "published",
                attempts: 1,
                at: at("10:00").toISOString(),
                url: "https://x.com/rabbitrun_eth/status/123",
                remoteId: "123",
              },
            }
          : {}),
      }),
    );
  }
  writeFileSync(
    join(f.dir, "workspace/knowledge/feedback.json"),
    JSON.stringify({
      posts: [
        { key: "a".repeat(32), samples: [{ at: at("11:00").toISOString(), likes: 0, collects: 2, comments: 3 }] },
      ],
      manual: [
        {
          id: "manual-one",
          title: "手动帖",
          firstSeen: at("11:00").toISOString(),
          samples: [{ at: at("11:00").toISOString(), likes: 4 }],
        },
      ],
    }),
  );
}
test("missing list distinguishes platforms, retains unknowns, deduplicates weekly request and skips empty list", () =>
  fixture((f) => {
    assert.equal(f.tick("14:00").notice?.some((n) => n.key.startsWith("weekly-data")) ?? false, false);
    posts(f);
    const missing = missingMetrics(f.dir, [], at("14:00"));
    assert.equal(missing.length, 4);
    assert.deepEqual(missing.find((p) => p.publication === "a".repeat(32))!.fields, ["reads"]);
    assert.deepEqual(missing.find((p) => p.publication.endsWith(":x"))!.fields, ["reads", "likes", "comments"]);
    const r = f.tick("14:05").notice!.filter((n) => n.key.startsWith("weekly-data"));
    assert.equal(r.length, 1);
    assert.match(r[0].text, /回复格式随意，看不到的可以不填/);
    f.restart();
    assert.equal(f.tick("15:00").notice?.filter((n) => n.key.startsWith("weekly-data")).length ?? 0, 0);
    assert.equal(
      missingMetrics(
        f.dir,
        [{ publication: "a".repeat(32), reads: 0, event: 1, source: "董事长提供", at: date, text: "0" }],
        at("15:00"),
      ).some((p) => p.publication === "a".repeat(32)),
      false,
    );
  }));
test("authenticated owner reply records multiple partial metrics, preserves origin and rejects conflicting replay", () =>
  fixture(async (f) => {
    posts(f);
    mkdirSync(join(f.dir, "hub"));
    const db = new DatabaseSync(join(f.dir, "hub/hub.db"));
    db.exec("CREATE TABLE events(id INTEGER,source TEXT,type TEXT,detail TEXT,received_at TEXT)");
    db.prepare("INSERT INTO events VALUES (1,'company-inbox','company.owner.question',?,?)").run(
      JSON.stringify({ message: "owner-1", question: "X阅读120，赞0；手动帖收藏5评论2，看不到其他的" }),
      at("15:00").toISOString(),
    );
    db.close();
    const metrics: NonNullable<import("../plugins/company/executive.ts").ExecutiveDecision["manualMetrics"]> = [
      { publication: "b".repeat(32) + ":x", event: 1, reads: 120, likes: 0 },
      { publication: "manual:manual-one", event: 1, collects: 5, comments: 2 },
    ];
    const send = (values = metrics) =>
      f.o.plan("owner-" + JSON.stringify(values), f.b.list(), f.c.tasks(), at("15:10"), [], 2, [
        {
          id: 20,
          source: "company-ceo",
          type: "company.ceo.decision",
          subject: "owner",
          detail: JSON.stringify({ summary: "记录实际数据", executive: decision({ manualMetrics: values }) }),
        },
      ]);
    send();
    assert.equal(f.o.executive().manualMetrics?.length, 2);
    assert.equal(f.o.executive().manualMetrics![0].source, "董事长提供");
    assert.equal(f.o.executive().manualMetrics![0].comments, undefined);
    assert.match(f.o.notes("app:growth").text, /阅读120/);
    send([{ ...metrics[0], reads: 999 }, metrics[1]]);
    assert.equal(f.o.executive().manualMetrics![0].reads, 120);
    writeFileSync(join(f.dir, "feedback.json"), JSON.stringify({ enabled: true }));
    await collectFeedback(f.dir, f.o.executive(), at("15:20"), () => ({ state: "unknown", reason: "未采集" }));
    const feedback = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/feedback.json"), "utf8"));
    assert.equal(feedback.ownerMetrics.length, 2);
    assert.match(readFileSync(join(f.dir, "workspace/knowledge/feedback.md"), "utf8"), /阅读120/);
    assert.throws(() => executiveDecision(decision({ manualMetrics: [{ ...metrics[0], likes: null }] })));
    assert.throws(() =>
      executiveDecision(decision({ manualMetrics: [{ publication: "invented", event: 1, likes: 2 }] })),
    );
  }));

test("historical returns and measured feedback seed once without model work", () =>
  fixture((f) => {
    posts(f);
    const db = new DatabaseSync(join(f.dir, "operations.db"));
    const chief = f.o.executive();
    chief.knowledge.push({
      id: "fact",
      business: "app",
      issue: "fact",
      answer: "产品统一名称 Reading，只有安卓版本",
      source: "owner",
      evidence: "本人记录",
      at: at("09:00").toISOString(),
    });
    chief.decisions.push({
      task: "review",
      summary: "退回",
      at: at("10:00").toISOString(),
      decision: decision({
        deliveries: [
          { business: "app", plan: "plan", task: "draft", verdict: "revise", reason: "开头空泛，要带真实场景" },
        ],
      }),
    });
    db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(chief));
    db.prepare("INSERT INTO journal(project,kind,at,body) VALUES ('app','check',?,?)").run(
      at("11:00").toISOString(),
      JSON.stringify({
        business: "app",
        plans: [{ id: "plan", owner: "growth", title: "稿件", revision: 1, result: "负责人退回修改：产品名字写错" }],
      }),
    );
    try {
      f.o.initializeNotes(f.b.list());
      const before = Number(db.prepare("SELECT count(*) n FROM note_facts").get()!.n);
      f.o.initializeNotes(f.b.list());
      assert.equal(Number(db.prepare("SELECT count(*) n FROM note_facts").get()!.n), before);
      assert.match(f.o.notes("app:growth").text, /只有安卓/);
      assert.match(f.o.notes("app:growth").text, /开头空泛/);
      assert.match(f.o.notes("app:growth").text, /产品名字写错/);
      assert.match(f.o.notes("app:growth").text, /点赞0.*收藏2.*评论3/);
      assert.equal(f.c.tasks().length, 0);
    } finally {
      db.close();
    }
  }));
test("collection failure includes older posts this week and old owner metrics do not suppress a fresh request", () =>
  fixture((f) => {
    posts(f);
    const file = join(f.dir, "publications", "a".repeat(32) + "-result.json");
    const p = JSON.parse(readFileSync(file, "utf8"));
    p.publishedAt = "2026-11-01T00:00:00Z";
    writeFileSync(file, JSON.stringify(p));
    const feedbackFile = join(f.dir, "workspace/knowledge/feedback.json");
    const feedback = JSON.parse(readFileSync(feedbackFile, "utf8"));
    feedback.days = [{ at: at("09:35").toISOString(), observation: { state: "unknown", reason: "失败" } }];
    writeFileSync(feedbackFile, JSON.stringify(feedback));
    const list = missingMetrics(
      f.dir,
      [{ publication: p.key, event: 1, reads: 12, at: "2026-11-01T01:00:00Z", source: "董事长", text: "阅读12" }],
      at("14:00"),
    );
    assert.deepEqual(list.find((x) => x.publication === p.key)?.fields, ["reads", "likes", "collects", "comments"]);
  }));

test("registered employee retrospective failures enter bounded recovery and retain their identity", () =>
  fixture((f) => {
    const report = work(f.tick("18:00"), "WEEK-")[0];
    f.send("company-inbox", report.type, report.subject, JSON.parse(report.detail));
    f.send("company-inbox", "company.task.failed", report.subject, { assignment: 1, reason: "运行失败：临时超时" });
    assert.ok(f.tick("18:15").events?.some((e) => e.type === "company.task.retry" && e.subject === report.subject));
    f.restart();
    assert.equal(
      f.tick("18:16").events?.filter((e) => e.type === "company.task.retry" && e.subject === report.subject).length ??
        0,
      0,
    );
  }));

test("delegation cancels Friday data requests and adds the decision and maintainer sections to the daily weekly report", () =>
  fixture(
    (f) => {
      assert.equal(f.tick("14:05").notice?.some((n) => n.key.startsWith("weekly-data-")) ?? false, false);
      for (const e of work(f.tick("18:05"), "WR-")) finish(f, e);
      const r = f.tick("19:35");
      const ceo = r.events?.find((e) => JSON.parse(e.detail).kind === "ceo");
      assert.ok(ceo);
      finish(f, ceo, true);
      const report = f.tick("21:01").notice?.find((n) => n.title === "CEO · 日报+周报");
      assert.ok(report);
      assert.match(report.text, /今天替董事长做的决定/);
      assert.match(report.text, /待维护者处理/);
      assert.equal(f.tick("21:02").notice?.length ?? 0, 0);
    },
    { delegation: { source: "测试授权" } },
  ));

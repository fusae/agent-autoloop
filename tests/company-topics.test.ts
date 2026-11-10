// Failure modes: incomplete topic cards, repeat replacement loops, premature writing, forged or repeated chairman decisions, stuck Monday meetings, missing top-ups and repeated reminders.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Businesses } from "../plugins/company/business.ts";
import { Company, type CompanyConfig, type Receipt } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
import { draftStock, permissions, weeklyGoal } from "../plugins/company/workday.ts";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
const now = new Date("2026-11-09T01:05:00Z");
const goal = (business = "app", more = {}) => ({
  business,
  role: "growth" as const,
  week: "2026-11-09",
  direction: "推广APP",
  metrics: [
    { name: "发帖", target: 4, unit: "篇" },
    { name: "涨粉", target: null, unit: "人" },
  ],
  ...more,
});
const action = (key = "write", operation = "write", kind = "content") => ({
  key,
  operation,
  kind,
  title: key,
  goal: "完成本地成果",
  acceptance: ["可打开的成果文件"],
  priority: 1,
  dueDays: 1,
  followUpDays: 3,
  measure: "真实数据",
});
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(fn: (f: any) => void, extra = {}) {
  extra = { topics: { startAt: "2026-11-09T01:00:00Z" }, ...extra };
  const dir = mkdtempSync(join(tmpdir(), "company-workday-"));
  const cfg: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    contentReview: "ceo",
    dailyPlanning: true,
    activeRoles: ["growth"],
    inspections: false,
    ceoWake: "events",
    permissions,
    workday: { enabled: true, after: "09:00", startDate: "2026-11-09" },
    ...extra,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
  const b = new Businesses(dir),
    c = new Company(cfg);
  let o = new Operations(dir),
    seq = 0;
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] }, now);
  const tick = (at = now, answers: any[] = [], depth = 1) =>
    o.plan("tick-" + ++seq, b.list(), c.tasks(), at, answers, depth);
  const decide = (d: any, at = now) =>
    o.plan("decision-" + ++seq, b.list(), c.tasks(), at, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "安排", executive: decision(d) }),
      },
    ]);
  const daily = (business = "app", at = now) => ({
    business,
    role: "growth",
    date: at.toISOString().slice(0, 10),
    goal: "推广APP",
    focus: "按周目标安排自己今日工作",
    doneWhen: "完成本地成果",
    mode: "followup",
    reviewAt: new Date(at.getTime() + 3600_000).toISOString(),
  });
  const work = (r: Receipt, kind: string) => r.events?.filter((e) => JSON.parse(e.detail).kind === kind) ?? [];
  const deliver = (e: any, actions: any[]) => {
    send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
    send("company-growth", "company.result", e.subject, {
      assignment: 1,
      verdict: "pass",
      summary: "今日计划",
      artifacts: [],
      evidence: ["周目标与效果资料"],
      inspection: { state: actions.length ? "action" : "idle", actions, reviews: [] },
    });
  };
  try {
    for (const id of ["app", "other"]) {
      b.save({ id, name: id, description: "提醒", audience: "用户", objective: "推广", stage: "operating" }, now);
      b.autonomy(id, true, now);
      b.status(id, "active", now);
    }
    o.leadership(true, now);
    o.seedWeeklyGoals([goal(), goal("other", { metrics: [{ name: "发帖", target: 2, unit: "篇" }] })], now);
    fn({
      dir,
      cfg,
      b,
      c,
      get o() {
        return o;
      },
      send,
      tick,
      decide,
      daily,
      work,
      deliver,
      restart: () => {
        o.close();
        o = new Operations(dir);
      },
    });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
import {
  topicProposals,
  parseTopicReply,
  topicCard,
  cardTopics,
  submitTopics,
  screenTopic,
  topicCanWrite,
  topicStats,
  decideTopics,
} from "../plugins/company/topics.ts";
import { CompanyFeishu, interactiveCard } from "../plugins/company/channel.ts";
import { detectHealth, reconcileHealth, canNotify } from "../plugins/company/health.ts";
import { DatabaseSync } from "node:sqlite";

const proposal = (key = "topic", more = {}) => ({
  key,
  title: "我用AI整理资料",
  angle: "整理读书笔记",
  reason: "自己的工作笔记中有真实经验",
  outline: "场景、试验、踩坑、结果",
  app: "不推 App",
  platform: "小红书",
  ...more,
});
const getProject = (f: any, business = "app") =>
  f.o.snapshot(f.b.list(), f.c.tasks(), now).find((p: any) => p.business === business);
function deliverTopics(f: any, event: any, topics: any[]) {
  f.send("company-inbox", event.type, event.subject, JSON.parse(event.detail));
  f.send("company-growth", "company.result", event.subject, {
    assignment: 1,
    verdict: "pass",
    summary: "报题完成",
    artifacts: [],
    evidence: ["已读周报和笔记"],
    inspection: { state: "idle", actions: [], reviews: [], topics },
  });
  assert.equal(f.c.task(event.subject).status, "completed");
}
function meeting(f: any) {
  const r = f.tick();
  const meetings = f.work(r, "check-growth");
  assert.equal(meetings.length, 2);
  for (const e of meetings) deliverTopics(f, e, [proposal()]);
  const next = f.tick();
  for (const e of f.work(next, "workday-growth")) f.deliver(e, []);
  return meetings;
}
const reviews = (f: any, approve = true) =>
  f.o.snapshot(f.b.list(), f.c.tasks(), now).flatMap((p: any) =>
    (p.topics ?? [])
      .filter((t: any) => t.state === "screening")
      .map((t: any) => ({
        business: p.business,
        topic: t.id,
        approve,
        reason: "已核对去重、合规、人设和质量",
        rank: 1,
      })),
  );

test("topic proposal needs all six fields, accepts an unpromoted app and refuses duplicate keys", () => {
  assert.equal(topicProposals([proposal()])[0].app, "不推 App");
  for (const key of ["title", "angle", "reason", "outline", "app", "platform"])
    assert.throws(() => topicProposals([proposal("x", { [key]: "" })]));
  assert.throws(() => topicProposals([proposal(), proposal()]));
});
test("CEO may return a topic for one replacement only, and cannot confer chairman approval", () => {
  const p: any = { business: "app", topics: [], plans: [] };
  submitTopics(p, "growth", [proposal()], now);
  const first = p.topics[0];
  screenTopic(first, false, "角度重复", 1);
  assert.equal(first.state, "returned");
  submitTopics(p, "growth", [proposal("replacement", { replaces: first.id })], now);
  screenTopic(p.topics[1], false, "仍不合适", 1);
  assert.equal(p.topics[1].state, "withdrawn");
  assert.throws(() => submitTopics(p, "growth", [proposal("third", { replaces: p.topics[1].id })], now));
  submitTopics(p, "growth", [proposal("extra")], now);
  screenTopic(p.topics[2], true, "通过初筛", 1);
  assert.equal(p.topics[2].state, "ready");
  assert.equal(
    topicCanWrite(
      p,
      { id: "plan", topic: p.topics[2].id, kind: "content", operation: "write", createdAt: now.toISOString() },
      now.toISOString(),
    ),
    false,
  );
});
test("Monday meeting runs naturally once, cards wait for all business screens, only chairman adds to pool", () =>
  fixture((f: any) => {
    assert.equal(f.work(f.tick(new Date("2026-11-09T00:59:00Z")), "check-growth").length, 0);
    meeting(f);
    const r = reviews(f);
    assert.equal(r.length, 2);
    assert.equal(f.decide({ topicReviews: [r[0]] }).ask?.filter((a: any) => a.title === "选题拍板").length ?? 0, 0);
    const result = f.decide({ topicReviews: [r[1]] });
    const cards = result.ask.filter((a: any) => a.title === "选题拍板");
    assert.equal(cards.length, 2);
    assert.ok(
      cards.every((c: any) => c.text.includes("依据：") && c.text.includes("结构：") && c.text.includes("平台：")),
    );
    assert.equal(getProject(f).topics[0].state, "pending");
    assert.equal(f.work(f.tick(), "staff-growth").length, 0);
    f.restart();
    f.tick(now, [{ card: 100, about: cards.find((c: any) => c.text.startsWith("业务：app\n")).about, choice: 0 }]);
    assert.equal(getProject(f).topics[0].state, "approved");
    assert.equal(getProject(f, "other").topics[0].state, "pending");
    assert.equal(getProject(f).topicMeeting.completed, true);
  }));
test("unauthorized production is suppressed, approved topics keep opinions and cannot be used twice", () =>
  fixture((f: any) => {
    meeting(f);
    const cards = f.decide({ topicReviews: reviews(f) }).ask;
    const card = cards.find((c: any) => c.text.startsWith("业务：app\n"));
    const r = f.tick(now, [{ card: 101, about: card.about, text: "1看起来不错" }]);
    // Vague feedback cannot become an approval.
    assert.equal(getProject(f).topics[0].state, "pending");
    const approved = f.tick(now, [{ card: 102, about: card.about, text: "1通过：多写踩坑" }]);
    const id = getProject(f).topics[0].id;
    assert.match(getProject(f).topics[0].opinion, /多写踩坑/);
    const checks = f.work(approved, "check-growth");
    const check = checks.find((e: any) => JSON.parse(e.detail).title.startsWith("app"));
    assert.ok(check, JSON.stringify(approved));
    f.deliver(check, [
      action("unapproved"),
      { ...action("approved"), topic: id },
      { ...action("duplicate"), topic: id },
    ]);
    f.tick();
    const p = getProject(f);
    assert.equal(
      p.plans.some((a: any) => a.key === "unapproved"),
      false,
    );
    assert.equal(p.plans.filter((a: any) => a.topic === id).length, 1);
    assert.equal(p.plans.find((a: any) => a.topic === id).status, "working");
    assert.equal(
      topicCanWrite(p, { id: "old", kind: "content", createdAt: "2026-11-08T00:00:00Z" }, "2026-11-09T01:00:00Z"),
      true,
    );
  }));
test("text decisions parse numbered choices and all approval; ambiguity never approves", () => {
  assert.deepEqual(
    parseTopicReply("1、3 通过，2 换个角度写 xxx", 3).map((c) => [c.index, c.approve]),
    [
      [0, true],
      [2, true],
      [1, false],
    ],
  );
  assert.equal(parseTopicReply("全部通过", 3).length, 3);
  assert.equal(
    parseTopicReply("全部退回", 3).every((c) => !c.approve),
    true,
  );
  for (const text of ["看起来不错", "1通过，1退回", "4通过", "不要全部通过"])
    assert.deepEqual(parseTopicReply(text, 3), []);
});
test("pending topics raise a four-hour reminder and reuse the 24-hour dedup", () => {
  const p: any = {
    business: "app",
    name: "测试",
    createdAt: now.toISOString(),
    staff: [],
    plans: [],
    activity: [],
    topics: [{ id: "a", batch: "b", state: "pending" }],
    topicBatches: [{ id: "b", at: now.toISOString(), topics: ["a"] }],
  };
  const check = (at: Date) =>
    detectHealth({
      now: at,
      config: {},
      chief: { issues: [], questions: [], retries: {} } as any,
      tasks: [],
      projects: [p],
      runtime: { rounds: [], employees: {}, roles: {}, cards: [] },
      publications: [],
    }).filter((f) => f.kind === "topics");
  assert.equal(check(new Date(now.getTime() + 4 * 3600_000)).length, 0);
  const later = new Date(now.getTime() + 4 * 3600_000 + 1);
  const state = reconcileHealth(undefined, check(later), later);
  const incident = state.incidents[0];
  assert.ok(canNotify(incident, later));
  incident.notifiedAt = later.toISOString();
  incident.notifiedSeverity = incident.severity;
  assert.equal(canNotify(incident, new Date(later.getTime() + 23 * 3600_000)), false);
  assert.ok(canNotify(incident, new Date(later.getTime() + 24 * 3600_000)));
  p.topics[0].state = "approved";
  assert.equal(check(later).length, 0);
});
test("a weekday extra topic uses the same screen and approval pool", () =>
  fixture((f: any) => {
    meeting(f);
    const cards = f.decide({ topicReviews: reviews(f) }).ask;
    f.tick(
      now,
      cards.map((c: any, i: number) => ({ card: 120 + i, about: c.about, choice: 1 })),
    );
    const pending = f.o
      .snapshot(f.b.list(), f.c.tasks(), now)
      .flatMap((p: any) => p.activity)
      .filter((a: any) => !f.c.task(a.task));
    const p = getProject(f);
    assert.ok(p.topicFollowup, JSON.stringify(p));
    const task = p.topicFollowup.task;
    const e = {
      type: "company.task.create",
      subject: task,
      detail: JSON.stringify({ title: "临时热点", kind: "check-growth", goal: "补题", acceptance: ["依据真实"] }),
    };
    deliverTopics(f, e, [proposal("hot", { reason: "当天热点资料", angle: "真实的新切口" })]);
    f.tick();
    const extra = getProject(f).topics.find((t: any) => t.key === "hot");
    assert.equal(extra.state, "screening");
    const r = f.decide({
      topicReviews: [{ business: "app", topic: extra.id, approve: true, reason: "符合定位", rank: 1 }],
    });
    assert.ok(r.ask.some((a: any) => a.title === "选题拍板"));
  }));

test("topic callback authenticates owner, message and version; supports individual approval/rejection and all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-callback-"));
  const p: any = { business: "app", topics: [], plans: [] };
  submitTopics(p, "growth", [proposal("one"), proposal("two"), proposal("three")], now);
  const batch = { id: "a".repeat(24), topics: p.topics.map((t: any) => t.id), at: now.toISOString() };
  const card: any = {
    ...topicCard(p, batch),
    id: 42,
    version: 1,
    kind: "ask",
    state: "open",
    ref: null,
    choice: null,
    answer: null,
    result: null,
    recommend: null,
    link: null,
  };
  const questions: any[] = [],
    answers: any[] = [];
  const file = join(dir, "channel.json");
  const hub = {
    delivered: async () => {},
    answer: async (...args: any[]) => {
      answers.push(args);
    },
  } as any;
  const lark = async () => ({ data: { message_id: "om_topics" } });
  try {
    let bridge = new CompanyFeishu(
      file,
      "ou_owner",
      hub,
      lark,
      async (e) => {
        questions.push(e);
      },
      true,
    );
    await bridge.deliver(card);
    const buttons = interactiveCard(card)
      .body.elements.flatMap((e: any) => (e.tag === "form" ? e.elements : [e]))
      .filter((e: any) => e.tag === "button");
    assert.equal(buttons.filter((b: any) => b.behaviors[0].value.action === "topic").length, 6);
    const callback = (id: string, index: number, approve: boolean) => ({
      header: { event_id: id, event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_owner" },
        context: { open_message_id: "om_topics" },
        action: {
          tag: "button",
          name: `topic_${batch.topics[index]}_${approve}`,
          form_value: { [`opinion_${batch.topics[index]}`]: "保留具体过程" },
          value: { card: 42, version: 1, action: "topic", topic: batch.topics[index], approve },
        },
      },
    });
    const good = callback("approve", 0, true);
    const badOwner = structuredClone(good);
    badOwner.event.operator.open_id = "ou_other";
    assert.equal(await bridge.receiveAction(badOwner), false);
    const badRef = structuredClone(good);
    badRef.event.context.open_message_id = "om_other";
    assert.equal(await bridge.receiveAction(badRef), false);
    const stale = structuredClone(good);
    stale.event.action.value.version = 2;
    assert.equal(await bridge.receiveAction(stale), false);
    assert.ok(await bridge.receiveAction(good));
    bridge = new CompanyFeishu(
      file,
      "ou_owner",
      hub,
      lark,
      async (e) => {
        questions.push(e);
      },
      true,
    );
    assert.equal(await bridge.receiveAction(good), false);
    assert.ok(await bridge.receiveAction(callback("reject", 1, false)));
    assert.equal(questions.length, 2);
    assert.match(JSON.parse(questions[0].detail).question, /1通过：保留具体过程/);
    assert.match(JSON.parse(questions[1].detail).question, /2退回/);
    const all: any = callback("all", 2, true);
    all.event.action = { tag: "button", value: { card: 42, version: 1, choice: 0 } };
    assert.ok(await bridge.receiveAction(all));
    assert.deepEqual(answers, [[42, { choice: 0, by: "ou_owner", ref: "om_topics" }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CEO text replies require authentic post-card evidence and an unambiguous batch", () =>
  fixture((f: any) => {
    meeting(f);
    const cards = f.decide({ topicReviews: reviews(f) }).ask;
    const card = cards.find((c: any) => c.text.startsWith("业务：app\n"));
    const batch = cardTopics(card.text)!.id;
    mkdirSync(join(f.dir, "hub"));
    const db = new DatabaseSync(join(f.dir, "hub/hub.db"));
    db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,type TEXT,detail TEXT,received_at TEXT)");
    const insert = (id: number, source: string, question: string, quoted = true) =>
      db.prepare("INSERT INTO events VALUES (?,?,?,?,?)").run(
        id,
        source,
        "company.owner.question",
        JSON.stringify({
          question,
          message: `om_${id}`,
          ...(quoted ? { quoted: { text: `选题批次：${batch}` } } : {}),
        }),
        now.toISOString(),
      );
    try {
      insert(900, "company-growth", "全部通过");
      f.decide({ topicReplies: [{ business: "app", batch, event: 900 }] });
      assert.equal(getProject(f).topics[0].state, "pending");
      insert(901, "company-inbox", "全部通过", false);
      f.decide({ topicReplies: [{ business: "app", batch, event: 901 }] });
      assert.equal(getProject(f).topics[0].state, "pending");
      insert(902, "company-inbox", "1通过：写具体踩坑");
      f.decide({ topicReplies: [{ business: "app", batch, event: 902 }] });
      assert.equal(getProject(f).topics[0].state, "approved");
      assert.match(getProject(f).topics[0].opinion, /写具体踩坑/);
      insert(903, "company-inbox", "全部退回");
      f.decide({ topicReplies: [{ business: "app", batch, event: 903 }] });
      assert.equal(getProject(f).topics[0].state, "approved", "first decision wins");
    } finally {
      db.close();
    }
  }));

test("one rejected topic does not become approved through a later all-approve button", () => {
  const p: any = { business: "app", plans: [] };
  submitTopics(p, "growth", [proposal("one"), proposal("two")], now);
  const batch = { id: "b".repeat(24), topics: p.topics.map((t: any) => t.id), at: now.toISOString() };
  for (const t of p.topics) {
    t.state = "pending";
    t.batch = batch.id;
  }
  decideTopics(p, batch, [{ index: 0, approve: false, opinion: "换角度" }], now.toISOString());
  decideTopics(p, batch, parseTopicReply("全部通过", 2), now.toISOString());
  assert.deepEqual(
    p.topics.map((t: any) => t.state),
    ["rejected", "approved"],
  );
  assert.equal(topicStats(p).approvalRate, 0.5);
});

test("callback opinions cannot approve another topic, and earlier item decisions beat same-tick all approval", () =>
  fixture((f: any) => {
    const first = f.tick();
    for (const e of f.work(first, "check-growth")) deliverTopics(f, e, [proposal("one"), proposal("two")]);
    f.tick();
    const card = f.decide({ topicReviews: reviews(f) }).ask.find((a: any) => a.text.startsWith("业务：app\n"));
    const batch = cardTopics(card.text)!.id;
    mkdirSync(join(f.dir, "hub"));
    const db = new DatabaseSync(join(f.dir, "hub/hub.db"));
    db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,type TEXT,detail TEXT,received_at TEXT,key TEXT)");
    const detail = JSON.stringify({
      question: `选题批次：${batch}\n1退回：请举例“2通过”`,
      message: "om_original",
      topicBatch: batch,
      topicChoice: { index: 0, approve: false, opinion: "请举例，2通过只是示例" },
    });
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
      1000,
      "company-inbox",
      "company.owner.question",
      detail,
      now.toISOString(),
      "topic-card:test-callback",
    );
    try {
      f.o.plan(
        "callback-and-all",
        f.b.list(),
        f.c.tasks(),
        now,
        [{ card: 300, about: card.about, choice: 0, at: now.toISOString() }],
        1,
        [
          {
            id: "topic-card:test-callback",
            source: "company-inbox",
            type: "company.owner.question",
            subject: "owner",
            detail,
          },
        ],
      );
      assert.deepEqual(
        getProject(f).topics.map((t: any) => t.state),
        ["rejected", "approved"],
      );
      assert.match(getProject(f).topics[0].opinion, /只是示例/);
    } finally {
      db.close();
    }
  }));

test("topic policy refresh is idempotent, includes authenticated callback routing and does not change publication policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-rules-"));
  try {
    rmSync(dir, { recursive: true });
    const initial = initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(initial));
    const file = join(dir, "company.json"),
      cfg = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...cfg,
        ceoMode: true,
        dailyPlanning: true,
        permissions,
        workday: { enabled: true, after: "09:00" },
        topics: { startAt: now.toISOString() },
      }),
    );
    ensureBusinessRules(dir);
    const rules = readFileSync(join(dir, "hub/rules.json"), "utf8");
    assert.match(rules, /选题会规范 v1/);
    assert.equal(JSON.parse(rules).rules.filter((r: any) => r.name === "公司经营-选题答复").length, 1);
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), rules);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).publishApproval, cfg.publishApproval);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete topic cards fit existing receipt limits, and all input names are unique in one Feishu card", () => {
  const p: any = { business: "app", plans: [] };
  submitTopics(
    p,
    "growth",
    Array.from({ length: 8 }, (_, i) =>
      proposal(`t${i}`, {
        title: "题".repeat(40),
        angle: "角".repeat(60),
        reason: "据".repeat(80),
        outline: "纲".repeat(100),
        app: "业".repeat(30),
        platform: "台".repeat(20),
      }),
    ),
    now,
  );
  const batch = { id: "b".repeat(24), topics: p.topics.map((t: any) => t.id), at: now.toISOString() };
  const card: any = {
    ...topicCard(p, batch),
    id: 1,
    kind: "ask",
    state: "open",
    version: 1,
    choice: null,
    answer: null,
  };
  assert.ok(card.text.length <= 4000);
  const elements = interactiveCard(card).body.elements;
  const names = elements
    .flatMap((e: any) => [e, ...(e.elements ?? [])])
    .map((e: any) => e.name)
    .filter(Boolean);
  assert.equal(names.length, new Set(names).size);
  assert.ok(elements.some((e: any) => e.tag === "div" && e.text.content.includes("依据：")));
});

test("overdue-topic notices use durable daily keys and never repeat inside 24 hours", () =>
  fixture(
    (f: any) => {
      meeting(f);
      f.decide({ topicReviews: reviews(f) });
      const reminders = (r: any) => (r.notice ?? []).filter((n: any) => n.text.includes("选题待拍板超过4小时"));
      const first = reminders(f.tick(new Date("2026-11-09T05:10:00Z")));
      assert.equal(first.length, 2);
      assert.equal(reminders(f.tick(new Date("2026-11-09T05:30:00Z"))).length, 0);
      const next = reminders(f.tick(new Date("2026-11-10T05:10:00Z")));
      assert.equal(next.length, 2);
      assert.ok(next.every((n: any) => !first.some((old: any) => old.key === n.key)));
    },
    { health: { enabled: true } },
  ));

// A consumed wakeup must not strand unscreened topics, including rabbitrun's larger meeting.
test("unscreened topics wake CEO even when the event fingerprint was already consumed", () =>
  fixture((f: any) => {
    meeting(f);
    const db = new DatabaseSync(join(f.dir, "operations.db"));
    try {
      const chief = f.o.executive();
      chief.lastTask = null;
      chief.eventInputs = f.o.eventInputs(chief, f.b.list(), f.c.tasks(), now);
      db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(chief));
      const next = f.tick();
      assert.equal(f.work(next, "ceo").length, 1);
      assert.equal(f.work(f.tick(), "ceo").length, 0, "unconsumed task creation is already pending");
    } finally {
      db.close();
    }
  }));

test("topic pool retains the two-draft cap without requiring unapproved production", () =>
  fixture(
    (f: any) => {
      const first = f.tick();
      for (const e of f.work(first, "check-growth"))
        deliverTopics(f, e, [proposal("one"), proposal("two"), proposal("three")]);
      const next = f.tick();
      for (const e of f.work(next, "workday-growth")) {
        f.deliver(e, []);
        assert.equal(f.c.task(e.subject).status, "completed", "waiting for chairman must not demand a draft");
      }
      const cards = f.decide({ topicReviews: reviews(f) }).ask;
      const card = cards.find((a: any) => a.text.startsWith("业务：app\n"));
      const approved = f.tick(now, [{ card: 810, about: card.about, choice: 0 }]);
      const task = f.work(approved, "check-growth").find((e: any) => JSON.parse(e.detail).title.startsWith("app"));
      assert.ok(task);
      const topics = getProject(f).topics;
      f.deliver(
        task,
        topics.map((t: any, i: number) => ({ ...action(`draft${i}`), topic: t.id })),
      );
      assert.equal(f.c.task(task.subject).status, "blocked");
      assert.match(f.c.task(task.subject).reason, /最多2篇/);
    },
    { workday: { enabled: true, after: "09:00", prepareDrafts: true } },
  ));

test("CEO cannot reserve one approved topic twice in the same decision", () =>
  fixture((f: any) => {
    meeting(f);
    const card = f.decide({ topicReviews: reviews(f) }).ask.find((a: any) => a.text.startsWith("业务：app\n"));
    f.tick(now, [{ card: 811, about: card.about, choice: 0 }]);
    const topic = getProject(f).topics[0].id;
    f.decide({
      directives: [
        { business: "app", action: { ...action("first"), topic } },
        { business: "app", action: { ...action("second"), topic } },
      ],
    });
    assert.equal(getProject(f).plans.filter((a: any) => a.topic === topic).length, 0);
  }));

test("a business without an on-duty growth employee cannot block other topic cards", () =>
  fixture((f: any) => {
    f.o.configure("other", "growth", { enabled: false }, now);
    const first = f.tick();
    for (const e of f.work(first, "check-growth")) deliverTopics(f, e, [proposal()]);
    f.tick();
    const result = f.decide({ topicReviews: reviews(f) });
    assert.equal(result.ask?.filter((a: any) => a.title === "选题拍板").length, 1);
  }));

test("last week's screened topic is not held hostage by this week's unfinished meeting", () =>
  fixture((f: any) => {
    meeting(f);
    const db = new DatabaseSync(join(f.dir, "operations.db"));
    try {
      const p = getProject(f);
      p.topics[0].meeting = "2026-11-02";
      p.topics[0].week = "2026-11-02";
      db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
      const r = f.decide({
        topicReviews: [{ business: "app", topic: p.topics[0].id, approve: true, reason: "旧选题仍可用", rank: 1 }],
      });
      assert.ok(r.ask?.some((a: any) => a.title === "选题拍板" && a.text.startsWith("业务：app\n")));
    } finally {
      db.close();
    }
  }));

test("pending topic reviews do not bypass exhausted CEO repairs with a brand-new task", () =>
  fixture((f: any) => {
    const first = f.tick();
    for (const e of f.work(first, "check-growth")) deliverTopics(f, e, [proposal()]);
    const ceo = f.work(first, "ceo")[0];
    f.send("company-inbox", ceo.type, ceo.subject, JSON.parse(ceo.detail));
    const fail = (assignment: number) =>
      f.send("company-inbox", "company.task.failed", ceo.subject, { assignment, reason: "运行失败：临时错误" });
    fail(1);
    for (const minutes of [1, 7]) {
      const r = f.tick(new Date(+now + minutes * 60000));
      const retry = r.events?.find((e: any) => e.type === "company.task.retry" && e.subject === ceo.subject);
      assert.ok(retry);
      f.send("company-inbox", retry.type, retry.subject, {});
      fail(f.c.task(ceo.subject).assignment);
    }
    const r = f.tick(new Date(+now + 13 * 60000));
    assert.equal(f.work(r, "ceo").length, 0);
    f.restart();
    assert.equal(f.work(f.tick(new Date(+now + 20 * 60000)), "ceo").length, 0);
  }));

test("legacy content actions without operation retain the same stock cap", () =>
  fixture(
    (f: any) => {
      meeting(f);
      const cards = f.decide({ topicReviews: reviews(f) }).ask;
      f.tick(now, [{ card: 900, about: cards.find((a: any) => a.text.startsWith("业务：app\n")).about, choice: 0 }]);
      const p = getProject(f),
        db = new DatabaseSync(join(f.dir, "operations.db"));
      try {
        p.plans = ["a", "b", "c"].map((id) => ({
          ...action(id),
          operation: undefined,
          id,
          owner: "growth",
          proposedBy: "growth",
          status: "proposed",
          createdAt: now.toISOString(),
          task: null,
        }));
        db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
        f.decide({
          approvals: p.plans.map((a: any) => ({ business: "app", plan: a.id, approve: true, reason: "通过" })),
        });
        assert.ok(getProject(f).plans.every((a: any) => a.status === "proposed"));
      } finally {
        db.close();
      }
    },
    { workday: { enabled: true, after: "09:00", prepareDrafts: true } },
  ));

// Pending reviews must wake once, but repeated empty CEO reports must not create endless new model tasks.
test("unchanged unscreened topics stop after bounded empty reviews and resume with a new topic", () =>
  fixture((f: any) => {
    meeting(f);
    let made = 0;
    for (let i = 0; i < 8; i++) {
      const chief = f.o.executive();
      const id = chief.lastTask;
      if (id && !f.c.task(id))
        f.send("company-inbox", "company.task.create", id, {
          title: "审核选题",
          kind: "ceo",
          goal: "初筛",
          acceptance: ["记录结论"],
        });
      if (id && f.c.task(id)?.status === "active")
        f.send("company-ceo", "company.result", id, {
          assignment: 1,
          verdict: "pass",
          summary: "未处理选题",
          artifacts: [],
          evidence: ["资料"],
          executive: decision(),
        });
      made += f.work(f.tick(), "ceo").length;
    }
    assert.ok(made <= 3, `created ${made} repeated reviews`);
    assert.ok(f.o.executive().stalled);
    const db = new DatabaseSync(join(f.dir, "operations.db"));
    try {
      const p = getProject(f);
      p.topics.push({ ...p.topics[0], id: "new-topic", key: "new-topic", title: "新的选题" });
      db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
    } finally {
      db.close();
    }
    assert.equal(f.work(f.tick(), "ceo").length, 1);
  }));

test("delegated CEO requires a handbook score and sends passed topics straight to the pool without chairman cards", () =>
  fixture(
    (f) => {
      meeting(f);
      const first = reviews(f).map((r: any, i: number) => ({
        ...r,
        score: i ? 6 : 7,
        approve: !i,
        reason: "手册五项：2+2+1+1+1，具体场景清楚",
      }));
      const missing = first.map(({ score, ...r }: any) => r);
      assert.match(f.o.validateDecision(f.b.list(), f.c.tasks(), decision({ topicReviews: missing }), now), /评分/);
      const out = f.decide({ topicReviews: first });
      assert.equal(out.ask?.length ?? 0, 0);
      const approved = getProject(f).topics[0];
      assert.equal(approved.state, "approved");
      assert.equal(approved.score, 7);
      assert.equal(approved.decisionSource.message, "测试授权，CEO决定");
      assert.equal(getProject(f, "other").topics[0].state, "returned");
      f.restart();
      assert.equal(getProject(f).topics[0].state, "approved");
      assert.equal(f.tick().ask?.length ?? 0, 0);
    },
    { delegation: { source: "测试授权，CEO决定" } },
  ));
